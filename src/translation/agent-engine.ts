import { tmpdir } from "node:os";
import {
  query,
  type EffortLevel,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../async.js";
import { log } from "../log.js";
import { TRANSLATOR_SYSTEM_PROMPT, translationRequest, type Translation, type TranslationEngine } from "./engine.js";

export type Effort = EffortLevel;

/** The Agent SDK call the engine makes; tests substitute a fake. */
export type RunQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { close(): void };

export interface AgentEngineOptions {
  readonly model: string;
  readonly effort: Effort;
  /** Where the translator's own Claude Code sends requests: the proxy's upstream, never the proxy itself. */
  readonly baseURL: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runQuery?: RunQuery;
}

/** Claude Code variables that still matter to a standalone process: sign-in and, on Windows, the shell it needs. */
const KEPT_CLAUDE_VARS = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_GIT_BASH_PATH"]);
const HOST_SESSION_VAR = /^(CLAUDECODE$|CLAUDE_PID$|CLAUDE_AGENT_SDK_|CLAUDE_CODE_)/;

/**
 * The translator's environment: the caller's, minus the variables that tie
 * a Claude Code process to the session that spawned it (entrypoint, host
 * session ids, messaging sockets, …). Inherited, they make the translator
 * act as part of that session, e.g. write an end-of-turn summary after
 * every translation, which adds seconds to each call.
 */
export const translatorEnv = (env: NodeJS.ProcessEnv, baseURL: string): Record<string, string | undefined> => ({
  ...Object.fromEntries(Object.entries(env).filter(([name]) => KEPT_CLAUDE_VARS.has(name) || !HOST_SESSION_VAR.test(name))),
  ANTHROPIC_BASE_URL: baseURL,
  CLAUDE_AGENT_SDK_CLIENT_APP: "pclaude",
});

/** The answer is a `{translation, language}` object: a structured reply leaves no room to chat instead of translating. */
const TRANSLATION_FORMAT: Options["outputFormat"] = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: { translation: { type: "string" }, language: { type: "string" } },
    required: ["translation", "language"],
    additionalProperties: false,
  },
};

const userMessage = (text: string, composed: boolean): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  // Translations are delivered as written (no @path expansion, no slash commands); /clear is a command.
  ...(composed ? { client_composed: true as const } : {}),
});

/** Structured output arrives through Claude Code's StructuredOutput tool, so a complete answer may stop on `tool_use`. */
const COMPLETE_STOPS = new Set(["end_turn", "tool_use"]);

const translationOf = (result: SDKResultMessage): Translation => {
  if (result.subtype !== "success" || result.is_error) throw new Error(`translation failed: ${result.subtype}`);
  if (!COMPLETE_STOPS.has(result.stop_reason ?? "")) throw new Error(`translation stopped: ${result.stop_reason}`);
  const { translation, language } = (result.structured_output ?? {}) as { translation?: unknown; language?: unknown };
  if (typeof translation !== "string" || typeof language !== "string")
    throw new Error("translation missing from structured output");
  return { text: translation, language };
};

/**
 * One long-lived Claude Code process fed through streaming input: start-up
 * is paid once, then each translation is a single turn. Turns run one at a
 * time and every one is followed by `/clear`, so no translation ever sees
 * the text of another.
 */
class TranslatorSession {
  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly run: ReturnType<RunQuery>;
  private readonly output: AsyncIterator<SDKMessage>;
  private tail: Promise<unknown> = Promise.resolve();
  alive = true;

  constructor(runQuery: RunQuery, options: Options) {
    this.run = runQuery({ prompt: this.inbox, options });
    this.output = this.run[Symbol.asyncIterator]();
  }

  private async turn(message: SDKUserMessage): Promise<SDKResultMessage> {
    this.inbox.push(message);
    for (;;) {
      const next = await this.output.next().catch((error: unknown) => {
        this.alive = false;
        throw error;
      });
      if (next.done) {
        this.alive = false;
        throw new Error("translator session ended");
      }
      if (next.value.type === "result") return next.value;
    }
  }

  private async ask(prompt: string): Promise<Translation> {
    // A failed /clear only means the process died; `alive` is already false, so the next call starts afresh.
    const result = await this.turn(userMessage(prompt, true)).finally(
      () => this.alive && this.turn(userMessage("/clear", false)).catch(() => {})
    );
    return translationOf(result);
  }

  /** Queued behind the turns already running on this process. */
  translate(prompt: string): Promise<Translation> {
    const next = this.tail.then(() => this.ask(prompt));
    this.tail = next.catch(() => {});
    return next;
  }

  close(): void {
    this.alive = false;
    this.run.close();
  }
}

/**
 * Translates through the Claude Agent SDK, i.e. headless Claude Code on the
 * user's own subscription login — the only way pclaude reaches a model for
 * translation. One persistent session serves both directions (each request
 * names its languages), started on first use and restarted if it dies. The
 * session is bare: no tools, no user settings, hooks or CLAUDE.md, nothing
 * persisted.
 */
export class AgentEngine implements TranslationEngine {
  readonly name: string;
  private session?: TranslatorSession;

  constructor(private readonly options: AgentEngineOptions) {
    this.name = `agent:${options.model}`;
  }

  private get liveSession(): TranslatorSession {
    if (!this.session?.alive)
      this.session = new TranslatorSession(this.options.runQuery ?? query, {
        model: this.options.model,
        effort: this.options.effort,
        thinking: { type: "disabled" },
        systemPrompt: TRANSLATOR_SYSTEM_PROMPT,
        outputFormat: TRANSLATION_FORMAT,
        tools: [],
        settingSources: [],
        persistSession: false,
        cwd: tmpdir(),
        env: translatorEnv(this.options.env, this.options.baseURL),
        stderr: (data) => log().debug({ scope: "translator:stderr", data }, "translator stderr"),
      });
    return this.session;
  }

  translate(text: string, from: string | undefined, to: string): Promise<Translation> {
    return this.liveSession.translate(translationRequest(text, from, to));
  }

  dispose(): Promise<void> {
    this.session?.close();
    this.session = undefined;
    return Promise.resolve();
  }
}
