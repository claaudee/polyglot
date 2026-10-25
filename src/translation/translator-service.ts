import { retry } from "../async.js";
import { MODEL_LANGUAGE, resolveLanguage, type Language } from "../languages.js";
import { debugLog, log } from "../log.js";
import { mask, PlaceholderMismatch, restore } from "../text/mask.js";
import type { Scopes } from "../text/scopes.js";
import type { Conversation, TranslationEngine } from "./engine.js";
import type { TranslationMemory } from "./memory.js";

export interface TranslatorServiceOptions {
  readonly scopes: Scopes;
  readonly memory: TranslationMemory;
  readonly engine: TranslationEngine;
  /** Tries per text when the model breaks placeholders. */
  readonly attempts?: number;
}

/** User text as the model gets it, with the language the user wrote it in (undefined: nothing to tell it by). */
export interface Prompt {
  readonly text: string;
  readonly language?: string;
}

/** Translates one reply into the language of the request it answers. */
export interface ReplyTranslator {
  /** One completed block of the streamed reply; `reply` is the model's whole reply so far, `text` included. */
  replyChunk(text: string, reply?: string): Promise<string>;
  rememberReply(original: string, displayed: string): void;
}

interface Direction {
  /** Undefined for prompts: the user may write in any language, the engine tells which. */
  readonly from?: Language;
  readonly to: Language;
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

/**
 * Orchestrates mask → translate → restore for both directions: prompts go
 * from whatever language the user wrote in to English, one model call per
 * text, and the engine reports that language; replies come back from
 * English into it, one streamed block at a time. Each text fails open on
 * its own: if the model keeps breaking placeholders or the call errors, it
 * stays in the original language. Knows nothing of HTTP: the proxy uses it
 * through `RequestTextOps`, which it matches structurally. Every translation is asked inside a `Conversation`: the
 * context the model sees while it translates.
 */
export class TranslatorService {
  private readonly model: Language;

  constructor(private readonly options: TranslatorServiceOptions) {
    this.model = resolveLanguage(MODEL_LANGUAGE)!;
  }

  get scopes(): Scopes {
    return this.options.scopes;
  }

  /** Surrounding whitespace never reaches the model, so block boundaries stay byte-exact. */
  private async translate(text: string, direction: Direction, context: Conversation): Promise<Prompt> {
    const [, lead = "", core = "", trail = ""] = EDGES.exec(text) ?? [];
    const masked = mask(core);
    if (!needsTranslation(masked.text, direction)) return { text };

    const startedAt = performance.now();
    try {
      const translated = await retry(
        this.options.attempts ?? 2,
        async () => {
          const output = await this.options.engine.translate(masked.text, direction.from?.code, direction.to.code, context);
          const language = resolveLanguage(output.language)?.code;
          // An unchanged answer is fine only when the text already was in the target language.
          if (output.text.trim() === masked.text.trim() && language !== direction.to.code) throw new Untranslated();
          return { text: restore(masked, output.text), language };
        },
        (error) => error instanceof PlaceholderMismatch || error instanceof Untranslated
      );
      log().debug(
        {
          scope: "translate",
          from: translated.language,
          to: direction.to.code,
          chars: core.length,
          ms: Math.round(performance.now() - startedAt),
        },
        "translated"
      );
      return { text: lead + translated.text + trail, language: translated.language };
    } catch (error) {
      debugLog("translate", error);
      log().debug({ scope: "translate", to: direction.to.code, text: masked.text }, "kept untranslated");
      return { text };
    }
  }

  /**
   * User text in any language → English, memoized with its language so a
   * turn re-sent in history is byte-identical and costs no new translation.
   */
  async toModel(text: string, context: Conversation = []): Promise<Prompt> {
    const known = this.options.memory.get("prompt", text);
    if (known !== undefined) return { text: known, language: this.options.memory.get("language", text) };

    const translated = await this.translate(text, { to: this.model }, context);
    this.options.memory.set("prompt", text, translated.text);
    if (translated.language) this.options.memory.set("language", text, translated.language);
    return translated;
  }

  /** Displayed assistant text → the exact original the model produced, or a fresh translation if unknown. */
  async restoreToModel(text: string, context: Conversation = []): Promise<string> {
    const original = this.options.memory.get("reply", text);
    if (original !== undefined) return original;
    log().debug({ scope: "translate:history", text }, "assistant history not in memory");
    return (await this.toModel(text, context)).text;
  }

  /**
   * Reply translation into `language`, asked inside `context` (the request
   * the reply answers); undefined when the user already writes in the
   * model's language.
   */
  forReply(language: string, context: Conversation = []): ReplyTranslator | undefined {
    const to = resolveLanguage(language);
    if (!to || to.code === this.model.code) return undefined;
    const direction: Direction = { from: this.model, to };
    return {
            // Asked after the model's own words, so the request the reply answers stays a cached prefix.
      replyChunk: async (text, reply = text) =>
        (await this.translate(text, direction, [...context, { role: "assistant", content: [{ type: "text", text: reply }] }]))
          .text,
      rememberReply: (original, displayed) => {
        log().debug({ scope: "translate:remember", text: displayed }, "reply remembered");
        this.options.memory.set("reply", displayed, original);
      },
    };
  }
}
