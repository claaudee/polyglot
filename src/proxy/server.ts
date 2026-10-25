import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isActive, openConfig } from "../config.js";
import { MODEL_LANGUAGE } from "../languages.js";
import { debugLog, log } from "../log.js";
import { MetricsStore } from "../metrics.js";
import type { PolyglotPaths } from "../paths.js";
import { mergeScopes } from "../text/scopes.js";
import type { TranslationEngine } from "../translation/engine.js";
import { TranslationMemory } from "../translation/memory.js";
import { ContextEngine, type ContextEngineOptions } from "./context-engine.js";
import { rewriteRequestBody, type MessagesBody } from "./rewrite-request.js";
import { ReplyStreamRewriter, rewriteResponseBody, type ReplyStats } from "./stream-rewriter.js";
import { TranslatorService, type ReplyTranslator } from "../translation/translator-service.js";

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export interface ProxyOptions {
  readonly paths: PolyglotPaths;
  /** 0 = ephemeral. */
  readonly port?: number;
  /** Overrides upstream resolution (flag > env ANTHROPIC_BASE_URL > api.anthropic.com). */
  readonly upstream?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Tests substitute a fake; by default translations are asked inside the intercepted request. */
  readonly engineFactory?: (request: ContextEngineOptions) => TranslationEngine;
}

export interface ProxyHandle {
  readonly port: number;
  readonly url: string;
  readonly upstream: string;
  close(): Promise<void>;
}

/**
 * Chaining: an already-set ANTHROPIC_BASE_URL (rtk-style setups, routers,
 * corporate gateways) becomes our upstream, so polyglot slots in front of
 * whatever proxy stack is already there.
 */
export const resolveUpstream = (explicit: string | undefined, env: NodeJS.ProcessEnv): string =>
  (explicit ?? env["ANTHROPIC_BASE_URL"] ?? DEFAULT_UPSTREAM).replace(/\/+$/, "");

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
  "accept-encoding",
  "upgrade",
]);

const requestHeaders = (req: IncomingMessage): Record<string, string> => {
  const headers = Object.fromEntries(
    Object.entries(req.headers)
      .filter(([name]) => !HOP_HEADERS.has(name))
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : (value ?? "")])
  );
  return { ...headers, "accept-encoding": "identity" };
};

const responseHeaders = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name) && name !== "content-encoding") headers[name] = value;
  });
  return headers;
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const isMessagesRequest = (req: IncomingMessage): boolean =>
  req.method === "POST" &&
  new URL(req.url ?? "/", "http://localhost").pathname.endsWith("/v1/messages");

const parseBody = (raw: Buffer): MessagesBody | undefined => {
  try {
    return JSON.parse(raw.toString("utf8")) as MessagesBody;
  } catch {
    return undefined;
  }
};

const lastUserTextLength = (body: MessagesBody): number => {
  const last = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  if (typeof last?.content === "string") return last.content.length;
  if (Array.isArray(last?.content))
    return last.content.reduce(
      (sum, block) => sum + (typeof block.text === "string" ? block.text.length : 0),
      0
    );
  return 0;
};

/** True when the resolved upstream would point back at this very proxy. */
const isSelf = (upstream: string, port: number): boolean => {
  try {
    const url = new URL(upstream);
    return (
      ["127.0.0.1", "localhost", "::1"].includes(url.hostname) && Number(url.port) === port
    );
  } catch {
    return false;
  }
};

export const startProxy = async (options: ProxyOptions): Promise<ProxyHandle> => {
  const env = options.env ?? process.env;
  let upstream = resolveUpstream(options.upstream, env);
  const memory = new TranslationMemory(options.paths.statsFile);
  const metrics = new MetricsStore(options.paths.statsFile);

  /**
   * A service for one intercepted request: its translations are asked
   * inside that very request. The config is re-read every time, so
   * `pclaude disable` and `pclaude config` apply live; a broken config
   * means relay as-is.
   */
  const activeService = (request: ContextEngineOptions): TranslatorService | undefined => {
    try {
      const store = openConfig(env);
      if (!isActive(store)) return undefined;
      return new TranslatorService({
        scopes: mergeScopes(store.get("scopes")),
        memory,
        engine: options.engineFactory?.(request) ?? new ContextEngine(request),
      });
    } catch (error) {
      debugLog("proxy:config", error);
      return undefined;
    }
  };

  /** `language` is the user's: prompts go from it to English, replies the other way. */
  const recordMetric = (
    event: "prompt" | "reply",
    stats: ReplyStats,
    translated: boolean,
    startedAt: number,
    language = "und"
  ): void => {
    try {
      metrics.record({
        event,
        fromLang: event === "prompt" ? language : MODEL_LANGUAGE,
        toLang: event === "prompt" ? MODEL_LANGUAGE : language,
        inputChars: stats.inputChars,
        outputChars: stats.outputChars,
        translated,
        durationMs: performance.now() - startedAt,
      });
    } catch (error) {
      debugLog("proxy:metrics", error);
    }
  };

  /** The request for the model, plus the language its reply must come back in. */
  const rewriteOutgoing = async (
    raw: Buffer,
    live: TranslatorService
  ): Promise<{ readonly raw: Buffer; readonly body?: MessagesBody; readonly language?: string }> => {
    const startedAt = performance.now();
    try {
      const body = JSON.parse(raw.toString("utf8")) as MessagesBody;
      const { body: rewritten, language } = await rewriteRequestBody(body, live);
      const inputChars = lastUserTextLength(body);
      const outputChars = lastUserTextLength(rewritten);
      const changed = JSON.stringify(rewritten) !== JSON.stringify(body);
      recordMetric("prompt", { inputChars, outputChars }, changed, startedAt, language);
      return { raw: Buffer.from(JSON.stringify(rewritten), "utf8"), body: rewritten, language };
    } catch (error) {
      debugLog("proxy:request", error);
      return { raw };
    }
  };

  const relayReply = async (
    upstreamResponse: Response,
    res: ServerResponse,
    replies: ReplyTranslator | undefined,
    language: string | undefined
  ): Promise<void> => {
    res.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));

    const body = upstreamResponse.body;
    if (!body) {
      res.end();
      return;
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const startedAt = performance.now();

    if (replies && contentType.includes("text/event-stream")) {
      const rewriter = new ReplyStreamRewriter(replies, (stats) =>
        recordMetric("reply", stats, true, startedAt, language)
      );
      for await (const chunk of rewriter.transform(body)) res.write(chunk);
      res.end();
      return;
    }

    if (replies && contentType.includes("application/json")) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const rewritten = await rewriteResponseBody(JSON.parse(raw), replies, (stats) =>
          recordMetric("reply", stats, true, startedAt, language)
        );
        res.end(JSON.stringify(rewritten));
      } catch (error) {
        debugLog("proxy:response", error);
        res.end(raw);
      }
      return;
    }

    for await (const chunk of body) res.write(chunk);
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req);
    const body = isMessagesRequest(req) ? parseBody(raw) : undefined;
    // Only the streamed conversation is the user's dialogue; Claude Code's side requests
    // (session classifiers, titles, summaries) are non-streaming and must reach the model as sent.
    const translatable = body?.stream === true;
    if (body)
      log().debug(
        { scope: "proxy:request", model: body.model, tools: Array.isArray(body["tools"]) ? body["tools"].length : 0, translatable },
        "messages request"
      );
    const url = `${upstream}${req.url ?? "/"}`;
    const headers = requestHeaders(req);
    const live = translatable && body ? activeService({ url, headers, body }) : undefined;

    const outgoing = live && raw.length > 0 ? await rewriteOutgoing(raw, live) : { raw };
    // The reply goes back in whatever language the user's latest words were in, translated inside
    // the request it answers; none for English.
    const replies =
      live && outgoing.language ? live.forReply(outgoing.language, outgoing.body?.messages ?? []) : undefined;

    const upstreamResponse = await fetch(url, {
      method: req.method,
      headers,
      body: outgoing.raw.length > 0 ? outgoing.raw : undefined,
    });

    await relayReply(upstreamResponse, res, replies, outgoing.language);
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      debugLog("proxy:relay", error);
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "application/json" }).end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: `polyglot proxy: ${String(error)}` },
          })
        );
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  if (isSelf(upstream, port)) {
    debugLog("proxy:upstream", `refusing self-loop via ${upstream}, using ${DEFAULT_UPSTREAM}`);
    upstream = DEFAULT_UPSTREAM;
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    upstream,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      memory.close();
      metrics.close();
    },
  };
};
