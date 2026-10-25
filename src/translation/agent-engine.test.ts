import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentEngine, translatorEnv, type RunQuery } from "./agent-engine.js";

const result = (fields: Record<string, unknown>): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "", ...fields }) as SDKMessage;

/** A successful turn whose structured answer is `translation`, detected as `language`. */
const translated = (translation: string, language = "ru"): SDKMessage =>
  result({ structured_output: { translation, language } });

const textOf = (message: SDKUserMessage): string => String(message.message.content);
const sourceOf = (request: string): string => /<source>\n([\s\S]*)\n<\/source>$/.exec(request)?.[1] ?? request;

interface FakeProcess {
  readonly options: Options;
  readonly received: SDKUserMessage[];
  closed: boolean;
}

/**
 * Fake Claude Code process: answers each streamed request with what `reply`
 * returns for its source text (`/clear` gets an empty success), and ends its
 * output when `reply` returns undefined.
 */
const fakeAgent = (reply: (request: string, turn: number) => readonly SDKMessage[] | undefined) => {
  const processes: FakeProcess[] = [];
  const runQuery: RunQuery = ({ prompt, options }) => {
    const proc: FakeProcess = { options, received: [], closed: false };
    processes.push(proc);
    const output = (async function* () {
      let turn = 0;
      for await (const message of prompt) {
        proc.received.push(message);
        if (textOf(message) === "/clear") {
          yield result({});
          continue;
        }
        const messages = reply(textOf(message), ++turn);
        if (!messages) return;
        yield { type: "system" } as SDKMessage;
        yield* messages;
      }
    })();
    return Object.assign(output, { close: () => void (proc.closed = true) });
  };
  const engine = new AgentEngine({
    model: "claude-haiku-5-5",
    effort: "medium",
    baseURL: "https://api.anthropic.com",
    env: { PATH: "/bin", ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" },
    runQuery,
  });
  return { engine, processes };
};

const echoing = () => fakeAgent((request) => [translated(`T(${sourceOf(request)})`)]);

describe("AgentEngine", () => {
  it("runs every translation on one bare, persistent process", async () => {
    const { engine, processes } = echoing();
    assert.deepEqual(await engine.translate("привет ⟦0⟧", undefined, "en"), { text: "T(привет ⟦0⟧)", language: "ru" });
    assert.deepEqual(await engine.translate("Done.", "en", "ru"), { text: "T(Done.)", language: "ru" });

    assert.equal(processes.length, 1);
    const options = processes[0]?.options;
    assert.equal(options?.model, "claude-haiku-5-5");
    assert.deepEqual(options?.thinking, { type: "disabled" });
    assert.deepEqual(options?.tools, []);
    assert.deepEqual(options?.settingSources, []);
    assert.equal(options?.persistSession, false);
    assert.equal(options?.outputFormat?.type, "json_schema");
    assert.equal(options?.env?.["ANTHROPIC_BASE_URL"], "https://api.anthropic.com");
  });

  it("names the direction in each request, next to the fenced text, and asks for the source language", async () => {
    const { engine, processes } = echoing();
    await engine.translate("привет", undefined, "en");
    await engine.translate("hello", "en", "ru");
    const [first, , second] = (processes[0]?.received ?? []).map(textOf);
    assert.match(first ?? "", /^Translate the text inside <source> into English, whatever language it is in\./);
    assert.match(first ?? "", /report the language the text is actually written in/);
    assert.match(second ?? "", /^Translate the text inside <source> from English .* into Russian\./);
    assert.ok(second?.endsWith("<source>\nhello\n</source>"));
  });

  it("rejects an answer that does not name the source language", async () => {
    const { engine } = fakeAgent(() => [result({ structured_output: { translation: "hi" } })]);
    await assert.rejects(engine.translate("привет", undefined, "en"), /structured output/);
  });

  it("clears the conversation after every translation, sending text verbatim and /clear as a command", async () => {
    const { engine, processes } = echoing();
    await engine.translate("один", "ru", "en");
    await engine.translate("два", "ru", "en");
    const received = processes[0]?.received ?? [];
    assert.deepEqual(received.map((message) => (textOf(message) === "/clear" ? "/clear" : sourceOf(textOf(message)))), [
      "один",
      "/clear",
      "два",
      "/clear",
    ]);
    assert.deepEqual(received.map((message) => message.client_composed ?? false), [true, false, true, false]);
  });

  it("serializes concurrent calls on the process and keeps answers matched to them", async () => {
    const { engine, processes } = echoing();
    const answers = await Promise.all(["а", "б", "в"].map((text) => engine.translate(text, "ru", "en")));
    assert.deepEqual(answers.map((answer) => answer.text), ["T(а)", "T(б)", "T(в)"]);
    assert.equal(processes.length, 1);
  });

  it("rejects failed, truncated or unstructured turns but keeps the process", async () => {
    const { engine, processes } = fakeAgent((_, turn) =>
      turn === 1
        ? [result({ subtype: "error_during_execution", is_error: true })]
        : turn === 2
          ? [result({ structured_output: { translation: "half", language: "ru" }, stop_reason: "max_tokens" })]
          : turn === 3
            ? [result({ result: "Sure! Here is the translation: …" })]
            : [translated("ok")]
    );
    await assert.rejects(engine.translate("a", "ru", "en"), /error_during_execution/);
    await assert.rejects(engine.translate("b", "ru", "en"), /max_tokens/);
    await assert.rejects(engine.translate("c", "ru", "en"), /structured output/);
    assert.equal((await engine.translate("d", "ru", "en")).text, "ok");
    assert.equal(processes.length, 1);
  });

  it("starts a fresh process when the old one dies", async () => {
    const { engine, processes } = fakeAgent((request) =>
      processes.length === 1 ? undefined : [translated(sourceOf(request))]
    );
    await assert.rejects(engine.translate("a", "ru", "en"), /session ended/);
    assert.equal((await engine.translate("b", "ru", "en")).text, "b");
    assert.equal(processes.length, 2);
  });

  it("closes its process on dispose", async () => {
    const { engine, processes } = echoing();
    await engine.translate("a", "ru", "en");
    await engine.dispose();
    assert.equal(processes[0]?.closed, true);
  });
});

describe("translatorEnv", () => {
  it("keeps the user's environment but not the variables of the session that spawned it", () => {
    const env = translatorEnv(
      {
        PATH: "/bin",
        HTTPS_PROXY: "http://proxy",
        CLAUDE_CONFIG_DIR: "/home/u/.claude",
        CLAUDE_CODE_OAUTH_TOKEN: "token",
        CLAUDE_CODE_GIT_BASH_PATH: "C:/git/bash.exe",
        CLAUDECODE: "1",
        CLAUDE_PID: "42",
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        CLAUDE_CODE_HOST_SESSION_ID: "local_1",
        CLAUDE_AGENT_SDK_VERSION: "0.3.0",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
      },
      "https://api.anthropic.com"
    );
    assert.deepEqual(env, {
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy",
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CODE_GIT_BASH_PATH: "C:/git/bash.exe",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_AGENT_SDK_CLIENT_APP: "pclaude",
    });
  });
});
