import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TranslationMemory } from "./memory.js";

const roots: string[] = [];
const memories: TranslationMemory[] = [];

// Windows refuses to unlink a database whose handle is still open.
after(async () => {
  memories.forEach((memory) => memory.close());
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const tempDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pclaude-memory-"));
  roots.push(root);
  return root;
};

const opened = (file: string): TranslationMemory => {
  const memory = new TranslationMemory(file);
  memories.push(memory);
  return memory;
};

describe("TranslationMemory", () => {
  it("finds the translations of an earlier run in the file, creating its directory", async () => {
    const file = join(await tempDir(), "nested", "stats.db");
    const first = new TranslationMemory(file);
    first.set("prompt", "привет", "hello");
    first.set("language", "привет", "ru");
    first.close();

    const next = opened(file);
    assert.equal(next.get("prompt", "привет"), "hello");
    assert.equal(next.get("language", "привет"), "ru");
    assert.equal(next.get("reply", "привет"), undefined, "kinds are kept apart");
  });

  it("keeps the first translation of a key, also across sessions sharing the file", async () => {
    const file = join(await tempDir(), "stats.db");
    const one = opened(file);
    const other = opened(file);
    assert.equal(one.set("prompt", "привет", "hello"), "hello");
    assert.equal(other.set("prompt", "привет", "hi"), "hello");
    assert.equal(other.get("prompt", "привет"), "hello");
  });

  it("falls back to memory per process when the file cannot be opened", async () => {
    const directory = await tempDir();
    const memory = opened(directory);
    assert.equal(memory.set("prompt", "привет", "hello"), "hello");
    assert.equal(memory.get("prompt", "привет"), "hello");
  });
});
