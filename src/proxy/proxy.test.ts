import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_SCOPES } from "../text/scopes.js";
import { MappingEngine } from "../translation/engine.js";
import { TranslationMemory } from "../translation/memory.js";
import { rewriteRequestBody, type RequestTextOps } from "./rewrite-request.js";
import { SseParser, sseRecord } from "./sse.js";
import { ReplyRecorder, ReplyStreamRewriter, rewriteResponseBody } from "./stream-rewriter.js";
import { TranslatorService } from "../translation/translator-service.js";

const roots: string[] = [];
const memories: TranslationMemory[] = [];

// Windows refuses to unlink a file whose handle is still open, so every
// database is closed before its directory is removed.
after(async () => {
  memories.forEach((memory) => memory.close());
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const tempDb = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "polyglot-proxy-"));
  roots.push(root);
  return join(root, "stats.db");
};

/** ru->en tags with EN[], en->ru tags with «ру:» (Cyrillic, so script detection behaves). */
const fakeEngine = () =>
  new MappingEngine("fake", (text, from) => (from === "ru" ? `EN[${text}]` : `«ру:${text}»`));

const makeService = async (): Promise<TranslatorService> => {
  const memory = new TranslationMemory(await tempDb());
  memories.push(memory);
  return new TranslatorService({
    scopes: DEFAULT_SCOPES,
    memory,
    engine: fakeEngine(),
  });
};

describe("SseParser", () => {
  it("splits complete records and buffers partials", () => {
    const parser = new SseParser();
    const first = parser.push('event: ping\ndata: {"type":"ping"}\n\nevent: par');
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]?.data, { type: "ping" });

    const second = parser.push('tial\ndata: {"a":1}\n\n');
    assert.equal(second.length, 1);
    assert.ok(second[0]?.raw.startsWith("event: partial"));
    assert.equal(parser.flush(), "");
  });

  it("keeps raw bytes for relaying", () => {
    const parser = new SseParser();
    const raw = "event: x\ndata: not-json\n\n";
    const [record] = parser.push(raw);
    assert.equal(record?.raw, raw);
    assert.equal(record?.data, undefined);
  });
});

describe("rewriteRequestBody", () => {
  const ops: RequestTextOps = {
    toModel: async (text) => ({ text: `EN[${text}]`, language: /\p{Script=Cyrillic}/u.test(text) ? "ru" : "en" }),
    restoreToModel: async (text) => `ORIG[${text}]`,
  };

  it("translates user text and restores assistant text", async () => {
    const body = {
      model: "claude-haiku-5-5",
      system: "системный промпт не трогать",
      messages: [
        { role: "user", content: "привет" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "переведённый ответ" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "вывод команды" },
            { type: "text", text: "продолжай" },
          ],
        },
      ],
    };

    const { body: result, language } = await rewriteRequestBody(body, ops);

    assert.equal(language, "ru", "the reply goes back in the language of the user's latest words");

    assert.equal(result.system, "системный промпт не трогать");
    assert.equal(result.messages?.[0]?.content, "EN[привет]");

    const assistant = result.messages?.[1]?.content as Array<Record<string, unknown>>;
    assert.equal(assistant[0]?.text, "ORIG[переведённый ответ]");
    assert.deepEqual(assistant[1], body.messages[1]?.content?.[1]);

    const user = result.messages?.[2]?.content as Array<Record<string, unknown>>;
    assert.equal(user[0]?.content, "вывод команды");
    assert.equal(user[1]?.text, "EN[продолжай]");
  });

  it("translates each message inside the rewritten history before it", async () => {
    const contexts: unknown[] = [];
    const recording: RequestTextOps = {
      toModel: async (text, context) => (contexts.push(context), { text: `EN[${text}]`, language: "ru" }),
      restoreToModel: async (text, context) => (contexts.push(context), `ORIG[${text}]`),
    };
    const toolResult = { type: "tool_result", tool_use_id: "t1", content: "вывод" };
    await rewriteRequestBody(
      {
        messages: [
          { role: "user", content: "привет" },
          { role: "assistant", content: [{ type: "text", text: "ответ" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] },
          { role: "user", content: [toolResult, { type: "text", text: "продолжай" }] },
        ],
      },
      recording
    );

    assert.deepEqual(contexts[0], []);
    assert.deepEqual(contexts[1], [{ role: "user", content: "EN[привет]" }]);
    assert.deepEqual(contexts[2], [
      { role: "user", content: "EN[привет]" },
      { role: "assistant", content: [{ type: "text", text: "ORIG[ответ]" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [toolResult] },
    ]);
  });

  it("passes bodies without messages through", async () => {
    const body = { model: "claude-haiku-5-5", prompt: "legacy" };
    assert.deepEqual(await rewriteRequestBody(body, ops), { body });
  });
});

describe("TranslatorService", () => {
  it("memoizes prompt translations byte-stably", async () => {
    const service = await makeService();
    const first = await service.toModel("поправь баг");
    const second = await service.toModel("поправь баг");
    assert.deepEqual(first, { text: "EN[поправь баг]", language: "ru" });
    assert.deepEqual(first, second);
  });

  it("returns English as it is and says so", async () => {
    const service = await makeService();
    assert.deepEqual(await service.toModel("already english"), { text: "already english", language: "en" });
  });

  it("restores the exact original of a remembered reply", async () => {
    const service = await makeService();
    service.forReply("ru")!.rememberReply("original English text.", "«ру:какой-то перевод»");
    assert.equal(await service.restoreToModel("«ру:какой-то перевод»"), "original English text.");
  });

  it("falls back to MT for unremembered assistant history", async () => {
    const service = await makeService();
    assert.equal(await service.restoreToModel("незнакомый текст"), "EN[незнакомый текст]");
  });
});

describe("ReplyStreamRewriter", () => {
  const delta = (index: number, text: string): string =>
    sseRecord("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    });

  const start = (index: number, type: string): string =>
    sseRecord("content_block_start", { type: "content_block_start", index, content_block: { type } });

  const stop = (index: number): string =>
    sseRecord("content_block_stop", { type: "content_block_stop", index });

  const collect = async (service: TranslatorService, chunks: readonly string[]): Promise<string> => {
    const rewriter = new ReplyStreamRewriter(service.forReply("ru")!);
    let out = "";
    for await (const piece of rewriter.transform((async function* () {
      yield* chunks;
    })())) {
      out += piece;
    }
    return out;
  };

  it("translates whole paragraphs and holds partials until they finish", async () => {
    const service = await makeService();
    const out = await collect(service, [
      start(0, "text"),
      delta(0, "First li"),
      delta(0, "ne done.\nSecond "),
      delta(0, "line.\n\nNext para"),
      delta(0, "graph.\n"),
      stop(0),
    ]);

    assert.ok(out.includes("ру:First line done.\\nSecond line."));
    assert.ok(out.includes("ру:Next paragraph."));
    assert.ok(!out.includes('"text":"First li"'));
  });

  it("keeps code fences untranslated across deltas", async () => {
    const service = await makeService();
    const out = await collect(service, [
      start(0, "text"),
      delta(0, "Intro line.\n```js\n"),
      delta(0, "const x = 1;\n"),
      delta(0, "```\nOutro line.\n"),
      stop(0),
    ]);

    assert.ok(out.includes("ру:Intro line."));
    assert.ok(out.includes("const x = 1;"));
    assert.ok(!out.includes("ру:const"));
    assert.ok(out.includes("ру:Outro line."));
  });

  it("flushes a partial final line on content_block_stop", async () => {
    const service = await makeService();
    const out = await collect(service, [start(0, "text"), delta(0, "no trailing newline"), stop(0)]);
    assert.ok(out.includes("ру:no trailing newline"));
  });

  it("passes tool_use blocks and unknown events through byte-for-byte", async () => {
    const service = await makeService();
    const toolStart = start(1, "tool_use");
    const toolDelta = sseRecord("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    });
    const ping = "event: ping\ndata: {\"type\": \"ping\"}\n\n";
    const out = await collect(service, [toolStart, toolDelta, ping, stop(1)]);
    assert.equal(out, toolStart + toolDelta + ping + stop(1));
  });

  it("records the reply pair for later restore", async () => {
    const service = await makeService();
    const out = await collect(service, [start(0, "text"), delta(0, "Reply text.\n"), stop(0)]);
    assert.ok(out.includes("ру:Reply text."));
    assert.equal(await service.restoreToModel("«ру:Reply text.»\n"), "Reply text.\n");
  });
});

describe("ReplyRecorder", () => {
  const start = (index: number, type: string): string =>
    sseRecord("content_block_start", { type: "content_block_start", index, content_block: { type } });
  const delta = (index: number, type: string, field: string, value: string): string =>
    sseRecord("content_block_delta", { type: "content_block_delta", index, delta: { type, [field]: value } });
  const stop = (index: number): string => sseRecord("content_block_stop", { type: "content_block_stop", index });

  it("relays every chunk at once and unchanged, reporting each finished text block", async () => {
    const stream = [
      start(0, "thinking"),
      delta(0, "thinking_delta", "thinking", "hmm"),
      stop(0),
      start(1, "text"),
      delta(1, "text_delta", "text", "Hello, "),
      delta(1, "text_delta", "text", "world.\n\nSecond"),
      delta(1, "text_delta", "text", " paragraph."),
      stop(1),
      start(2, "tool_use"),
      delta(2, "input_json_delta", "partial_json", "{}"),
      stop(2),
    ].join("");
    // Slices cut records apart, as a socket would.
    const chunks = Array.from({ length: Math.ceil(stream.length / 13) }, (_, at) => stream.slice(at * 13, at * 13 + 13));
    const texts: string[] = [];
    const recorder = new ReplyRecorder((text) => texts.push(text));
    const relayed: string[] = [];
    let ahead = 0;
    for await (const chunk of recorder.transform((async function* () {
      for (const chunk of chunks) {
        ahead++;
        yield chunk;
      }
    })())) {
      assert.equal(ahead, relayed.length + 1, "each chunk goes out before the next one is read");
      relayed.push(chunk);
    }
    assert.deepEqual(relayed, chunks);
    assert.deepEqual(texts, ["Hello, world.\n\nSecond paragraph."]);
  });
});

describe("rewriteResponseBody", () => {
  it("translates text blocks of a non-streaming response", async () => {
    const service = await makeService();
    const body = {
      content: [
        { type: "text", text: "Plain answer." },
        { type: "tool_use", id: "t", name: "Bash", input: {} },
      ],
    };
    const result = (await rewriteResponseBody(body, service.forReply("ru")!)) as typeof body;
    assert.equal(result.content[0]?.text, "«ру:Plain answer.»");
    assert.deepEqual(result.content[1], body.content[1]);
  });
});
