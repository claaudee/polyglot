import { lexer } from "marked";

export interface SplitResult {
  /** Whole markdown blocks, safe to translate. */
  readonly completed: string;
  /** Unfinished tail, kept buffered until more text arrives. */
  readonly rest: string;
}

/**
 * The top-level markdown blocks of `src` (paragraphs, fences, lists, …,
 * blank-line runs included), or undefined when the lexer normalized the
 * source so their raws no longer concatenate back to it byte-for-byte.
 */
export const topLevelBlocks = (src: string): readonly string[] | undefined => {
  const raws = lexer(src).map((token) => token.raw);
  return raws.join("") === src ? raws : undefined;
};

/**
 * Splits a streaming buffer into blocks that can no longer change and the
 * tail that still can. The last non-blank block is always held back: more
 * text may extend it (a paragraph's next line, an unclosed fence, the next
 * list item, a setext underline).
 */
export const splitCompleted = (buffer: string): SplitResult => {
  const blocks = topLevelBlocks(buffer);
  if (!blocks) return { completed: "", rest: buffer };

  const last = blocks.findLastIndex((raw) => raw.trim() !== "");
  const cut = blocks.slice(0, Math.max(last, 0)).join("").length;
  return { completed: buffer.slice(0, cut), rest: buffer.slice(cut) };
};
