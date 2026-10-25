export interface Language {
  /** ISO 639 base language, e.g. `ru` (`pt-BR` → `pt`). */
  readonly code: string;
  /** English name, used in translation prompts. */
  readonly name: string;
  /** ISO 15924 script the language is usually written in, e.g. `Cyrl`, `Latn`, `Jpan`. */
  readonly scriptCode: string;
  /** Matches characters of that script (source detection). */
  readonly script: RegExp;
}

/** The language the main model always works in. */
export const MODEL_LANGUAGE = "en";

/** Writing systems that combine several Unicode scripts; the rest map one-to-one. */
const COMPOSITE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  Jpan: ["Hira", "Kana", "Hani"],
  Kore: ["Hang", "Hani"],
  Hans: ["Hani"],
  Hant: ["Hani"],
};

const scriptPattern = (scriptCode: string): RegExp | undefined => {
  try {
    const scripts = COMPOSITE_SCRIPTS[scriptCode] ?? [scriptCode];
    return new RegExp(`[${scripts.map((script) => `\\p{Script=${script}}`).join("")}]`, "u");
  } catch {
    return undefined;
  }
};

const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * Any language the runtime's ICU data knows, by BCP 47 tag: the name comes
 * from `Intl.DisplayNames`, the usual script from `Intl.Locale#maximize`.
 * Undefined for tags it does not know.
 */
export const resolveLanguage = (tag: string): Language | undefined => {
  try {
    const locale = new Intl.Locale(tag).maximize();
    const name = names.of(locale.language);
    const script = locale.script === undefined ? undefined : scriptPattern(locale.script);
    return name && locale.script && script
      ? { code: locale.language, name, scriptCode: locale.script, script }
      : undefined;
  } catch {
    return undefined;
  }
};
