import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SCOPES } from "../text/scopes.js";
import type { Translation, TranslationEngine } from "./engine.js";
import { TranslationMemory } from "./memory.js";
import { TranslatorService } from "./translator-service.js";

interface Call {
  readonly text: string;
  readonly from?: string;
  readonly to: string;
}

/** Engine whose answers are scripted per call; records what it was asked. */
const scripted = (answer: (call: Call, index: number) => Translation | Promise<Translation>) => {
  const calls: Call[] = [];
  const engine: TranslationEngine = {
    name: "scripted",
    translate: async (text, from, to) => {
      const call = { text, from, to };
      calls.push(call);
      return answer(call, calls.length);
    },
  };
  return { engine, calls };
};

/** Answers every prompt as if it were Russian, translated by `map`. */
const fromRussian = (map: (text: string) => string) => scripted(({ text }) => ({ text: map(text), language: "ru" }));

const serviceWith = (engine: TranslationEngine) =>
  new TranslatorService({
    scopes: DEFAULT_SCOPES,
    memory: new TranslationMemory("unused"),
    engine,
  });

describe("TranslatorService prompts", () => {
  it("never shows the model masked code and puts it back verbatim", async () => {
    const { engine, calls } = fromRussian((text) => text.replace("запусти", "run"));
    const service = serviceWith(engine);
    assert.deepEqual(await service.toModel("запусти `npm test`"), { text: "run `npm test`", language: "ru" });
    assert.equal(calls[0]?.text, "запусти ⟦0⟧");
  });

  it("asks the engine which language the user wrote in, and always translates into English", async () => {
    const { engine, calls } = scripted(({ text }) =>
      text.startsWith("Bitte") ? { text: "Please fix the bug.", language: "de" } : { text: "Fix it.", language: "ja" }
    );
    const service = serviceWith(engine);
    assert.deepEqual(await service.toModel("Bitte behebe den Fehler."), { text: "Please fix the bug.", language: "de" });
    assert.deepEqual(await service.toModel("直してください。"), { text: "Fix it.", language: "ja" });
    assert.deepEqual(
      calls.map(({ from, to }) => ({ from, to })),
      [
        { from: undefined, to: "en" },
        { from: undefined, to: "en" },
      ]
    );
  });

  it("accepts English handed back unchanged", async () => {
    const { engine, calls } = scripted(({ text }) => ({ text, language: "en" }));
    const service = serviceWith(engine);
    assert.deepEqual(await service.toModel("Already English."), { text: "Already English.", language: "en" });
    assert.equal(calls.length, 1);
  });

  it("memoizes the translation with its language, so history costs nothing", async () => {
    const { engine, calls } = fromRussian(() => "Fix the bug.");
    const service = serviceWith(engine);
    const first = await service.toModel("поправь баг");
    assert.deepEqual(await service.toModel("поправь баг"), first);
    assert.equal(calls.length, 1);
  });

  it("retries when the model breaks placeholders", async () => {
    const { engine, calls } = fromRussian((text) => (calls.length === 1 ? "lost it" : text.replace("запусти", "run")));
    const service = serviceWith(engine);
    assert.equal((await service.toModel("запусти `ls`")).text, "run `ls`");
    assert.equal(calls.length, 2);
  });

  it("falls back to the original when placeholders stay broken", async () => {
    const { engine, calls } = fromRussian(() => "⟦0⟧ ⟦0⟧");
    const service = serviceWith(engine);
    assert.deepEqual(await service.toModel("запусти `ls`"), { text: "запусти `ls`" });
    assert.equal(calls.length, 2);
  });

  it("retries when the model hands non-English text back untranslated", async () => {
    const { engine, calls } = fromRussian((text) => (calls.length === 1 ? text : "Hi! How are you?"));
    const service = serviceWith(engine);
    assert.equal((await service.toModel("Привет! Как дела?")).text, "Hi! How are you?");
    assert.equal(calls.length, 2);
  });

  it("does not retry engine errors and falls back to the original", async () => {
    const { engine, calls } = scripted(() => {
      throw new Error("529 overloaded");
    });
    const service = serviceWith(engine);
    assert.deepEqual(await service.toModel("привет"), { text: "привет" });
    assert.equal(calls.length, 1);
  });

  it("keeps whitespace around blocks out of the model's hands", async () => {
    const { engine, calls } = fromRussian(() => "Hello.");
    const service = serviceWith(engine);
    assert.equal((await service.toModel("\n  Привет.\n\n")).text, "\n  Hello.\n\n");
    assert.equal(calls[0]?.text, "Привет.");
  });

  it("skips the engine for text with no words at all", async () => {
    const { engine, calls } = fromRussian(() => "never");
    const service = serviceWith(engine);
    assert.deepEqual(await service.toModel("```sh\nls -la\n```"), { text: "```sh\nls -la\n```" });
    assert.equal(calls.length, 0);
  });
});

describe("TranslatorService replies", () => {
  it("translates the reply from English into the language of the request", async () => {
    const { engine, calls } = scripted(({ text, to }) => ({
      text: to === "ja" ? "テストは隣にあります。" : text.replace("Done", "Готово"),
      language: "en",
    }));
    const service = serviceWith(engine);
    assert.equal(await service.forReply("ru")!.replyChunk("Done.\n\n"), "Готово.\n\n");
    assert.equal(await service.forReply("ja")!.replyChunk("Tests sit next to the code."), "テストは隣にあります。");
    assert.deepEqual(
      calls.map(({ from, to }) => ({ from, to })),
      [
        { from: "en", to: "ru" },
        { from: "en", to: "ja" },
      ]
    );
  });

  it("asks each reply block after the request it answers and the model's reply so far", async () => {
    const contexts: unknown[] = [];
    const engine: TranslationEngine = {
      name: "recording",
      translate: async (text, _from, _to, context) => (contexts.push(context), { text: `«${text}»`, language: "en" }),
    };
    const request = [{ role: "user", content: "привет" }];
    await serviceWith(engine).forReply("ru", request)!.replyChunk("Second.", "First.\n\nSecond.");
    assert.deepEqual(contexts, [
      [...request, { role: "assistant", content: [{ type: "text", text: "First.\n\nSecond." }] }],
    ]);
  });

  it("does not translate replies for English speakers", () => {
    const { engine } = scripted(() => ({ text: "never", language: "en" }));
    assert.equal(serviceWith(engine).forReply("en"), undefined);
  });

  it("leaves code and text already in the user's script alone", async () => {
    const { engine, calls } = scripted(() => ({ text: "never", language: "en" }));
    const replies = serviceWith(engine).forReply("ru")!;
    const russian = "Это прокси для Claude Code: он переводит промпты через подписку.";
    assert.equal(await replies.replyChunk(russian), russian);
    assert.equal(await replies.replyChunk("```sh\nls\n```\n"), "```sh\nls\n```\n");
    assert.equal(calls.length, 0);
  });

  it("lets the engine judge replies within one script, accepting text already in the user's language", async () => {
    const { engine, calls } = scripted(({ text }) =>
      text.startsWith("Fix") ? { text: "Behebe den Fehler.", language: "en" } : { text, language: "de" }
    );
    const replies = serviceWith(engine).forReply("de")!;
    assert.equal(await replies.replyChunk("Fix the bug."), "Behebe den Fehler.");
    assert.equal(await replies.replyChunk("Schon deutsch."), "Schon deutsch.");
    assert.equal(calls.length, 2);
  });

  it("restores remembered replies exactly and translates unknown history to English", async () => {
    const { engine } = fromRussian(() => "Unknown text.");
    const service = serviceWith(engine);
    service.forReply("ru")!.rememberReply("Original English.", "Перевод.");
    assert.equal(await service.restoreToModel("Перевод."), "Original English.");
    assert.equal(await service.restoreToModel("Незнакомый текст."), "Unknown text.");
  });
});
