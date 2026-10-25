import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { lexer, marked, walkTokens, type Token } from "marked";
import { splitCompleted } from "./blocks.js";
import { chunkBlocks } from "./chunk.js";
import { mask, PlaceholderMismatch, restore, verify } from "./mask.js";

interface Case {
  readonly file: string;
  readonly markdown: string;
}

const FIXTURES = fileURLToPath(new URL("../../fixtures/md/", import.meta.url));

const suites: ReadonlyArray<{ readonly name: string; readonly cases: readonly Case[] }> = [
  ...readdirSync(join(FIXTURES, "spec-cases")).map((name) => ({
    name,
    cases: JSON.parse(readFileSync(join(FIXTURES, "spec-cases", name, "cases.json"), "utf8")) as Case[],
  })),
  {
    name: "real",
    cases: readdirSync(join(FIXTURES, "real")).map((file) => ({
      file,
      markdown: readFileSync(join(FIXTURES, "real", file), "utf8"),
    })),
  },
];

/** Checks a property on every case, reporting all failures at once instead of stopping at the first. */
const holdsForAll = (cases: readonly Case[], check: (markdown: string) => string | undefined): void => {
  const failures = cases.flatMap((testCase) => {
    try {
      const failure = check(testCase.markdown);
      return failure === undefined ? [] : [`${testCase.file}: ${failure}`];
    } catch (error) {
      return [`${testCase.file}: threw ${String(error)}`];
    }
  });
  assert.equal(failures.length, 0, `${failures.length} failing:\n${failures.slice(0, 10).join("\n")}`);
};

const render = (markdown: string): string => marked.parse(markdown, { async: false });

/** Everything that must come out of translation untouched. */
const protectedContent = (markdown: string): readonly string[] => {
  const found: string[] = [];
  walkTokens(lexer(markdown), (token: Token) => {
    if (token.type === "code" || token.type === "codespan") found.push(`${token.type}:${token.text}`);
    if (token.type === "html") found.push(`html:${token.raw}`);
    if (token.type === "link" || token.type === "image" || token.type === "def")
      found.push(`${token.type}:${token.href}|${token.title ?? ""}`);
  });
  return found;
};

/** A stand-in translation that changes every translatable letter but no markdown syntax. */
const shout = (text: string): string => text.replace(/[a-z]/g, (letter) => letter.toUpperCase());

/** Feeds `markdown` in small deltas the way the stream rewriter does. */
const streamed = (markdown: string, step: number): string => {
  let buffer = "";
  let out = "";
  for (let at = 0; at < markdown.length; at += step) {
    const { completed, rest } = splitCompleted(buffer + markdown.slice(at, at + step));
    out += completed;
    buffer = rest;
  }
  return out + buffer;
};

for (const { name, cases } of suites)
  describe(`fixtures: ${name} (${cases.length})`, () => {
    it("mask → restore round-trips byte-for-byte", () =>
      holdsForAll(cases, (markdown) => {
        const masked = mask(markdown);
        return restore(masked, masked.text) === markdown ? undefined : "round-trip differs";
      }));

    it("a translation keeps structure, code, HTML and URLs intact", () =>
      holdsForAll(cases, (markdown) => {
        const masked = mask(markdown);
        const translated = restore(masked, shout(masked.text));
        if (render(translated).toLowerCase() !== render(markdown).toLowerCase()) return "rendered structure differs";
        const before = protectedContent(markdown);
        const after = protectedContent(translated);
        return JSON.stringify(before) === JSON.stringify(after) ? undefined : "protected content changed";
      }));

    it("chunks join back to the source", () =>
      holdsForAll(cases, (markdown) => (chunkBlocks(markdown, 20).join("") === markdown ? undefined : "join differs")));

    it("streamed splitCompleted reassembles the source", () =>
      holdsForAll(cases, (markdown) => (streamed(markdown, 7) === markdown ? undefined : "reassembly differs")));
  });

describe("mask", () => {
  it("hides code, inline code, URLs and identifiers from the translator", () => {
    const masked = mask(
      "Run `npm test` in [the repo](https://x.dev/a) and set API_KEY {% data x.y-z %}.\n\n```sh\nls -la\n```\n"
    );
    assert.ok(!masked.text.includes("npm test"));
    assert.ok(!masked.text.includes("data x.y-z"));
    assert.ok(!masked.text.includes("https://x.dev/a"));
    assert.ok(!masked.text.includes("API_KEY"));
    assert.ok(!masked.text.includes("ls -la"));
    assert.ok(masked.text.includes("the repo"));
  });

  it("keeps literal placeholder-like text in the source", () => {
    const source = "Text with ⟦0⟧ already in it.\n";
    const masked = mask(source);
    assert.equal(restore(masked, masked.text), source);
  });

  it("rejects translations that lose or duplicate placeholders", () => {
    const masked = mask("Use `a` and `b`.\n");
    assert.equal(masked.slots.length, 2);
    assert.ok(verify(masked, masked.text));
    assert.ok(!verify(masked, "Use ⟦0⟧."));
    assert.ok(!verify(masked, "Use ⟦0⟧ ⟦0⟧ ⟦1⟧."));
    assert.throws(() => restore(masked, "Use ⟦1⟧."), PlaceholderMismatch);
  });
});

describe("splitCompleted", () => {
  it("holds the last block until something follows it", () => {
    assert.deepEqual(splitCompleted("First line.\nSecond "), { completed: "", rest: "First line.\nSecond " });
    const { completed, rest } = splitCompleted("Para one.\n\nPara tw");
    assert.equal(completed, "Para one.\n\n");
    assert.equal(rest, "Para tw");
  });

  it("holds an unclosed fence and releases it once closed", () => {
    assert.deepEqual(splitCompleted("Intro.\n```js\nconst"), { completed: "Intro.\n", rest: "```js\nconst" });
    assert.deepEqual(splitCompleted("```js\nx\n```\nOutro."), { completed: "```js\nx\n```\n", rest: "Outro." });
  });
});
