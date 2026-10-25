import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeArgs, launch } from "./launcher.js";

describe("claudeArgs", () => {
  it("pins Claude Code's language to English ahead of the user's own arguments", () => {
    assert.deepEqual(claudeArgs(["-p", "привет", "--", "x"]), [
      "--settings",
      '{"language":"English"}',
      "-p",
      "привет",
      "--",
      "x",
    ]);
  });
});

/** Stand-in for `claude`: records what it was started with, then exits with the code it was asked for. */
const FAKE_CLAUDE = `
const { writeFileSync } = require("node:fs");
const [, , out, code, ...rest] = process.argv;
writeFileSync(out, JSON.stringify({ baseUrl: process.env.ANTHROPIC_BASE_URL, args: rest }));
process.exit(Number(code));
`;

describe("launch", () => {
  let root = "";
  let script = "";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "pclaude-launch-"));
    script = join(root, "fake-claude.cjs");
    await writeFile(script, FAKE_CLAUDE);
  });

  after(() => rm(root, { recursive: true, force: true }));

  const run = async (code: number, args: readonly string[]) => {
    const out = join(root, `out-${code}.json`);
    const exitCode = await launch({
      command: process.execPath,
      args: [script, out, String(code), ...args],
      env: { ...process.env, PCLAUDE_HOME: root, ANTHROPIC_BASE_URL: "https://gateway.example" },
    });
    return { exitCode, seen: JSON.parse(await readFile(out, "utf8")) as { baseUrl: string; args: string[] } };
  };

  it("points claude at the local proxy and passes its arguments through untouched", async () => {
    const { exitCode, seen } = await run(0, ["-p", "привет, что в этой папке?", "--output-format", "json"]);
    assert.equal(exitCode, 0);
    assert.match(seen.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(seen.args, ["-p", "привет, что в этой папке?", "--output-format", "json"]);
  });

  it("returns claude's exit code", async () => {
    const { exitCode } = await run(3, []);
    assert.equal(exitCode, 3);
  });

  it("reports a missing claude binary instead of crashing", async () => {
    const exitCode = await launch({ command: "pclaude-no-such-binary", args: [], env: { ...process.env, PCLAUDE_HOME: root } });
    // POSIX: ENOENT → 127. Windows resolves through cmd.exe, which prints its own error and exits 1.
    assert.equal(exitCode, process.platform === "win32" ? 1 : 127);
  });
});
