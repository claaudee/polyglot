import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { parseTranslation } from "../translation/engine.js";
import { ContextEngine } from "./context-engine.js";
import type { MessagesBody } from "./rewrite-request.js";
import { sseRecord } from "./sse.js";

interface Received {
  readonly headers: IncomingMessage["headers"];
  readonly body: MessagesBody & { readonly messages: ReadonlyArray<{ role: string; content: unknown }> };
}

const reply = (text: string, stop = "end_turn"): string =>
  [
    sseRecord("message_start", { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 900 } } }),
    sseRecord("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sseRecord("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 9) } }),
    sseRecord("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(9) } }),
    sseRecord("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseRecord("message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 7 } }),
    sseRecord("message_stop", { type: "message_stop" }),
  ].join("");

describe("ContextEngine", () => {
  const received: Received[] = [];
  let answer = "";
  let stop = "end_turn";
  const upstream: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(200, { "content-type": "text/event-stream" }).end(reply(answer, stop));
  });
  let url = "";

  before(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1/messages`;
  });

  after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

  const engine = () =>
    new ContextEngine({
      url,
      headers: { "content-type": "application/json", authorization: "Bearer oauth-test" },
      body: {
        model: "claude-haiku-5-5",
        stream: true,
        system: "system prompt",
        tools: [{ name: "Bash" }],
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "the original request" }],
      },
    });

  it("asks inside the given context with the request's own model, system, tools and sign-in", async () => {
    answer = "<language>ru</language>\n<translation>\nWhat is in this folder?\n</translation>";
    const context = [
      { role: "user", content: "Run ls." },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
    ];
    assert.deepEqual(await engine().translate("что в этой папке?", undefined, "en", context), {
      text: "What is in this folder?",
      language: "ru",
    });

    const sent = received.at(-1)!;
    assert.equal(sent.headers["authorization"], "Bearer oauth-test");
    assert.equal(sent.body.model, "claude-haiku-5-5");
    assert.equal(sent.body.system, "system prompt");
    assert.deepEqual(sent.body.tools, [{ name: "Bash" }]);
    assert.deepEqual(sent.body.thinking, { type: "adaptive" });
    assert.deepEqual(sent.body.messages.slice(0, 2), context.slice(0, 2));
    const last = sent.body.messages[2]!.content as Array<{ type: string; text?: string }>;
    assert.equal(sent.body.messages.length, 3, "the task joins the last user turn");
    assert.equal(last[0]?.type, "tool_result");
    assert.ok(last[1]?.text?.includes("<source>\nчто в этой папке?\n</source>"));
  });

  it("adds a user turn after an assistant one, and starts one in an empty context", async () => {
    answer = "<language>en</language><translation>Готово.</translation>";
    await engine().translate("Done.", "en", "ru", [
      { role: "user", content: "привет" },
      { role: "assistant", content: [{ type: "text", text: "Hi." }] },
    ]);
    assert.equal(received.at(-1)!.body.messages.at(-1)?.role, "user");
    assert.equal(received.at(-1)!.body.messages.length, 3);

    await engine().translate("Done.", "en", "ru", []);
    assert.equal(received.at(-1)!.body.messages.length, 1);
  });

  it("keeps trailing system messages at the end of the array", async () => {
    answer = "<language>en</language><translation>Готово.</translation>";
    const environment = { role: "system", content: [{ type: "text", text: "# Environment" }] };
    await engine().translate("Done.", "en", "ru", [{ role: "user", content: "привет" }, environment]);
    const sent = received.at(-1)!.body.messages;
    assert.deepEqual(sent.map((message) => message.role), ["user", "system"]);
    assert.deepEqual(sent[1], environment);
    assert.equal((sent[0]!.content as Array<{ text?: string }>).length, 2, "the task joins the user turn");
  });

  it("refuses an answer that stopped to call a tool", async () => {
    answer = "Let me look.";
    stop = "tool_use";
    try {
      await assert.rejects(engine().translate("привет", undefined, "en", []), /translation stopped: tool_use/);
    } finally {
      stop = "end_turn";
    }
  });
});

describe("parseTranslation", () => {
  it("keeps closing tags that belong to the text", () => {
    assert.deepEqual(parseTranslation("<language>de</language><translation>a </translation> b</translation>"), {
      text: "a </translation> b",
      language: "de",
    });
  });

  it("rejects chat instead of the answer shape", () => {
    assert.throws(() => parseTranslation("Sure! Here is the translation: hello"), /malformed/);
  });
});
