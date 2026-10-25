import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { openConfig } from "../config.js";
import { resolvePaths } from "../paths.js";
import { MappingEngine } from "../translation/engine.js";
import { SseParser } from "./sse.js";
import { startProxy, type ProxyHandle } from "./server.js";

const SSE = readFileSync(fileURLToPath(new URL("../../fixtures/sse/reply-with-tool.sse", import.meta.url)), "utf8");

interface Received {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

/** Fake api.anthropic.com: replays the recorded SSE, or JSON when the request is not streaming. */
const fakeUpstream = (received: Received[]): Server =>
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    received.push({ url: req.url ?? "", headers: req.headers, body });

    if (req.method === "GET") return void res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
    if (!JSON.parse(body).stream)
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ content: [{ type: "text", text: "Plain answer." }] }));

    res.writeHead(200, { "content-type": "text/event-stream" });
    // Uneven slices, so records and UTF-8 straddle chunk boundaries like on a real socket.
    for (let at = 0; at < SSE.length; at += 97) res.write(SSE.slice(at, at + 97));
    res.end();
  });

/** ru→en tags with EN[], en→ru with «ру:» (Cyrillic, so script detection behaves). */
const fakeEngine = () =>
  new MappingEngine("fake", (text, from) => (from === "ru" ? `EN[${text}]` : `«ру:${text}»`));

const replyText = (stream: string): string =>
  new SseParser()
    .push(stream)
    .map((record) => record.data as { type?: string; delta?: { type?: string; text?: string } })
    .filter((event) => event?.type === "content_block_delta" && event.delta?.type === "text_delta")
    .map((event) => event.delta?.text ?? "")
    .join("");

describe("proxy end-to-end", () => {
  const received: Received[] = [];
  const upstream = fakeUpstream(received);
  let root = "";
  let proxy: ProxyHandle;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "pclaude-e2e-"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    const port = typeof address === "object" && address ? address.port : 0;
    env = { PCLAUDE_HOME: root };
    // The file logger reads process.env; keep fail-open records out of the user's real log.
    process.env["PCLAUDE_HOME"] = root;
    proxy = await startProxy({
      paths: resolvePaths(env),
      env,
      upstream: `http://127.0.0.1:${port}`,
      engineFactory: fakeEngine,
    });
  });

  after(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const post = (body: unknown): Promise<Response> =>
    fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer oauth-test" },
      body: JSON.stringify(body),
    });

  it("translates the prompt and streams the reply back translated", async () => {
    const response = await post({
      model: "claude-haiku-5-5",
      stream: true,
      system: "системный промпт",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>Context, keep as is.</system-reminder>" },
            { type: "text", text: "что в этой папке?" },
          ],
        },
      ],
    });
    const stream = await response.text();
    const sent = JSON.parse(received.at(-1)?.body ?? "{}");

    assert.equal(sent.system, "системный промпт");
    assert.equal(sent.messages[0].content[0].text, "<system-reminder>Context, keep as is.</system-reminder>");
    assert.equal(sent.messages[0].content[1].text, "EN[что в этой папке?]");
    assert.equal(received.at(-1)?.headers["authorization"], "Bearer oauth-test");

    assert.equal(
      replyText(stream),
      "«ру:The folder holds a small project.»\n\n«ру:Run it with:»\n\n```sh\nnpm start\n```\n\n«ру:Let me check the files.»"
    );
    assert.ok(stream.includes('"signature":"EqQBCkYIBxgCKkA"'), "thinking signature relayed untouched");
    assert.ok(stream.includes('{\\"command\\": \\"ls -la\\"}'), "tool_use input relayed untouched");
    assert.ok(stream.includes('"stop_reason":"tool_use"'));
  });

  it("sends the model its own words back when the translated reply returns as history", async () => {
    const displayed = "«ру:The folder holds a small project.»\n\n«ру:Run it with:»\n\n```sh\nnpm start\n```\n\n«ру:Let me check the files.»";
    await post({
      model: "claude-haiku-5-5",
      stream: true,
      messages: [
        { role: "user", content: "что в этой папке?" },
        { role: "assistant", content: [{ type: "text", text: displayed }] },
        { role: "user", content: "продолжай" },
      ],
    }).then((response) => response.text());
    const sent = JSON.parse(received.at(-1)?.body ?? "{}");

    assert.equal(sent.messages[0].content, "EN[что в этой папке?]");
    assert.equal(
      sent.messages[1].content[0].text,
      "The folder holds a small project.\n\nRun it with:\n\n```sh\nnpm start\n```\n\nLet me check the files."
    );
    assert.equal(sent.messages[2].content, "EN[продолжай]");
  });

  it("leaves Claude Code's non-streaming side requests (classifiers, titles) untouched both ways", async () => {
    const response = await post({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "привет" }] });
    assert.deepEqual(await response.json(), { content: [{ type: "text", text: "Plain answer." }] });
    assert.equal(JSON.parse(received.at(-1)?.body ?? "{}").messages[0].content, "привет");
  });

  it("leaves the reply alone for a user who writes in English", async () => {
    const stream = await post({
      model: "claude-haiku-5-5",
      stream: true,
      messages: [{ role: "user", content: "what is in this folder?" }],
    }).then((response) => response.text());
    assert.equal(JSON.parse(received.at(-1)?.body ?? "{}").messages[0].content, "what is in this folder?");
    assert.ok(replyText(stream).startsWith("The folder holds a small project."));
    assert.ok(!stream.includes("ру:"));
  });

  it("relays other endpoints untouched", async () => {
    const response = await fetch(`${proxy.url}/v1/models`);
    assert.deepEqual(await response.json(), { data: [] });
    assert.equal(received.at(-1)?.url, "/v1/models");
  });

  it("relays untranslated rather than failing when config.json is invalid", async () => {
    const file = openConfig(env).path;
    const saved = await readFile(file, "utf8");
    await writeFile(file, JSON.stringify({ ...JSON.parse(saved), concurrency: "lots" }));
    try {
      const response = await post({ model: "claude-haiku-5-5", stream: true, messages: [{ role: "user", content: "привет" }] });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(JSON.parse(received.at(-1)?.body ?? "{}").messages[0].content, "привет");
    } finally {
      await writeFile(file, saved);
    }
  });

  it("stops translating live when the config disables it", async () => {
    openConfig(env).set("enabled", false);
    try {
      await post({ model: "claude-haiku-5-5", stream: true, messages: [{ role: "user", content: "привет" }] }).then(
        (response) => response.text()
      );
      assert.equal(JSON.parse(received.at(-1)?.body ?? "{}").messages[0].content, "привет");
    } finally {
      openConfig(env).set("enabled", true);
    }
  });
});
