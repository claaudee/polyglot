import { topLevelBlocks } from "./blocks.js";

/** Rough token count: ~4 characters per token for ASCII, ~2 for other scripts. */
export const estimateTokens = (text: string): number => {
  const other = text.replace(/[\x00-\x7F]/g, "").length;
  return Math.ceil((text.length - other) / 4 + other / 2);
};

/**
 * Packs whole top-level markdown blocks into chunks of at most `maxTokens`
 * (a single larger block becomes a chunk of its own), so no chunk ever cuts
 * a fence, list or table. `chunks.join("") === src`.
 */
export const chunkBlocks = (src: string, maxTokens: number): readonly string[] =>
  (topLevelBlocks(src) ?? [src]).reduce<readonly string[]>((chunks, block) => {
    const current = chunks.at(-1);
    return current !== undefined && estimateTokens(current + block) <= maxTokens
      ? [...chunks.slice(0, -1), current + block]
      : [...chunks, block];
  }, []);
