import { mapLimit, retry } from "../async.js";
import { MODEL_LANGUAGE, resolveLanguage, type Language } from "../languages.js";
import { debugLog, log } from "../log.js";
import { chunkBlocks } from "../text/chunk.js";
import { mask, PlaceholderMismatch, restore } from "../text/mask.js";
import type { Scopes } from "../text/scopes.js";
import type { TranslationEngine } from "./engine.js";
import type { TranslationMemory } from "./memory.js";

export interface TranslatorServiceOptions {
  readonly scopes: Scopes;
  readonly memory: TranslationMemory;
  readonly engineFactory: () => TranslationEngine;
  /** Upper bound per model call, in estimated tokens. */
  readonly chunkTokens?: number;
  /** Prompt chunks translated in parallel. */
  readonly concurrency?: number;
  /** Tries per chunk when the model breaks placeholders. */
  readonly attempts?: number;
}

/** User text as the model gets it, with the language the user wrote it in (undefined: nothing to tell it by). */
export interface Prompt {
  readonly text: string;
  readonly language?: string;
}

/** Translates one reply into the language of the request it answers. */
export interface ReplyTranslator {
  /** One completed block of the streamed reply. */
  replyChunk(text: string): Promise<string>;
  rememberReply(original: string, displayed: string): void;
}

interface Direction {
  /** Undefined for prompts: the user may write in any language, the engine tells which. */
  readonly from?: Language;
  readonly to: Language;
  readonly concurrency: number;
}

const EDGES = /^(\s*)([\s\S]*?)(\s*)$/;

const ANY_LETTER = /\p{L}/gu;

const letters = (text: string, language: Language): number =>
  text.match(new RegExp(language.script.source, "gu"))?.length ?? 0;

/**
 * Whether masked text may need translating. Prompts always do when they
 * have words: the user may write in any language, so the engine decides.
 * Replies do unless most of their letters are already in the user's
 * script; within one script (English → German) letters cannot tell, so the
 * engine decides there too.
 */
const needsTranslation = (text: string, direction: Direction): boolean => {
  const all = text.match(ANY_LETTER)?.length ?? 0;
  if (all === 0) return false;
  if (!direction.from || direction.from.scriptCode === direction.to.scriptCode) return true;
  return letters(text, direction.to) * 2 < all;
};

/** The model handed the source text back although it was not in the target language. */
class Untranslated extends Error {
  constructor() {
    super("model returned the source text unchanged");
  }
}

/** The language most of the translated text was in, by characters. */
const dominantLanguage = (parts: readonly Prompt[]): string | undefined => {
  const weights = parts.reduce<Readonly<Record<string, number>>>(
    (acc, { text, language }) => (language ? { ...acc, [language]: (acc[language] ?? 0) + text.length } : acc),
    {}
  );
  return Object.entries(weights).sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * Orchestrates mask → chunk → translate → restore for both directions:
 * prompts go from whatever language the user wrote in to English with
 * chunks in parallel, and the engine reports that language; replies come
 * back from English into it, one streamed block at a time. Each chunk
 * fails open on its own: if the model keeps breaking placeholders or the
 * call errors, that chunk stays in the original language. Knows nothing of
 * HTTP: the proxy uses it through `RequestTextOps`, which it matches
 * structurally.
 */
export class TranslatorService {
  private engine?: TranslationEngine;
  private readonly model: Language;

  constructor(private readonly options: TranslatorServiceOptions) {
    this.model = resolveLanguage(MODEL_LANGUAGE)!;
  }

  get scopes(): Scopes {
    return this.options.scopes;
  }

  /** Created on first use, so a disabled session never builds an SDK client. */
  private get activeEngine(): TranslationEngine {
    this.engine ??= this.options.engineFactory();
    return this.engine;
  }

  /** One chunk; surrounding whitespace never reaches the model, so block boundaries stay byte-exact. */
  private async translateChunk(chunk: string, direction: Direction): Promise<Prompt> {
    const [, lead = "", core = "", trail = ""] = EDGES.exec(chunk) ?? [];
    const masked = mask(core);
    if (!needsTranslation(masked.text, direction)) return { text: chunk };

    const startedAt = performance.now();
    try {
      const translated = await retry(
        this.options.attempts ?? 2,
        async () => {
          const output = await this.activeEngine.translate(masked.text, direction.from?.code, direction.to.code);
          const language = resolveLanguage(output.language)?.code;
          // An unchanged answer is fine only when the text already was in the target language.
          if (output.text.trim() === masked.text.trim() && language !== direction.to.code) throw new Untranslated();
          return { text: restore(masked, output.text), language };
        },
        (error) => error instanceof PlaceholderMismatch || error instanceof Untranslated
      );
      log().debug(
        {
          scope: "translate:chunk",
          from: translated.language,
          to: direction.to.code,
          chars: core.length,
          ms: Math.round(performance.now() - startedAt),
        },
        "translated"
      );
      return { text: lead + translated.text + trail, language: translated.language };
    } catch (error) {
      debugLog("translate:chunk", error);
      log().debug({ scope: "translate:chunk", to: direction.to.code, text: masked.text }, "kept untranslated");
      return { text: chunk };
    }
  }

  private async translate(text: string, direction: Direction): Promise<Prompt> {
    const chunks = chunkBlocks(text, this.options.chunkTokens ?? 2000);
    const translated = await mapLimit(chunks, direction.concurrency, (chunk) => this.translateChunk(chunk, direction));
    return { text: translated.map((part) => part.text).join(""), language: dominantLanguage(translated) };
  }

  /**
   * User text in any language → English, memoized with its language so a
   * turn re-sent in history is byte-identical and costs no new translation.
   */
  async toModel(text: string): Promise<Prompt> {
    const known = this.options.memory.get("prompt", text);
    if (known !== undefined) return { text: known, language: this.options.memory.get("language", text) };

    const translated = await this.translate(text, { to: this.model, concurrency: this.options.concurrency ?? 4 });
    this.options.memory.set("prompt", text, translated.text);
    if (translated.language) this.options.memory.set("language", text, translated.language);
    return translated;
  }

  /** Displayed assistant text → the exact original the model produced, or a fresh translation if unknown. */
  async restoreToModel(text: string): Promise<string> {
    const original = this.options.memory.get("reply", text);
    if (original !== undefined) return original;
    log().debug({ scope: "translate:history", text }, "assistant history not in memory");
    return (await this.toModel(text)).text;
  }

  /** Reply translation into `language`; undefined when the user already writes in the model's language. */
  forReply(language: string): ReplyTranslator | undefined {
    const to = resolveLanguage(language);
    if (!to || to.code === this.model.code) return undefined;
    const direction: Direction = { from: this.model, to, concurrency: 1 };
    return {
      replyChunk: async (text) => (await this.translate(text, direction)).text,
      rememberReply: (original, displayed) => {
        log().debug({ scope: "translate:remember", text: displayed }, "reply remembered");
        this.options.memory.set("reply", displayed, original);
      },
    };
  }

  async dispose(): Promise<void> {
    await this.engine?.dispose();
    this.engine = undefined;
  }
}
