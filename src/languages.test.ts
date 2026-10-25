import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveLanguage } from "./languages.js";

describe("resolveLanguage", () => {
  it("knows languages from the runtime's ICU data, with English names and usual scripts", () => {
    const cases: ReadonlyArray<readonly [string, string, string, string]> = [
      ["ru", "Russian", "Cyrl", "Привет"],
      ["uk", "Ukrainian", "Cyrl", "Привіт"],
      ["de", "German", "Latn", "Grüße"],
      ["pt-BR", "Portuguese", "Latn", "Olá"],
      ["ja", "Japanese", "Jpan", "こんにちはカタカナ漢字"],
      ["zh", "Chinese", "Hans", "你好"],
      ["ko", "Korean", "Kore", "안녕하세요"],
      ["ar", "Arabic", "Arab", "مرحبا"],
      ["hi", "Hindi", "Deva", "नमस्ते"],
      ["th", "Thai", "Thai", "สวัสดี"],
    ];
    for (const [tag, name, scriptCode, sample] of cases) {
      const language = resolveLanguage(tag);
      assert.equal(language?.name, name, tag);
      assert.equal(language?.scriptCode, scriptCode, tag);
      assert.ok(language?.script.test(sample), `${tag} script matches ${sample}`);
      assert.ok(!language?.script.test("abc") || scriptCode === "Latn", `${tag} script ignores Latin`);
    }
    assert.equal(resolveLanguage("pt-BR")?.code, "pt");
  });

  it("matches every part of composite writing systems", () => {
    const japanese = resolveLanguage("ja")!;
    assert.ok(["ひらがな", "カタカナ", "漢字"].every((text) => japanese.script.test(text)));
  });

  it("rejects tags it does not know", () => {
    assert.equal(resolveLanguage("xx"), undefined);
    assert.equal(resolveLanguage("auto"), undefined);
    assert.equal(resolveLanguage(""), undefined);
  });
});
