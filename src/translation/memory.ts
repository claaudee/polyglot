export type MemoryKind =
  /** Source-language prompt → what was sent to the model. */
  | "prompt"
  /** Translated reply as displayed → the model's original text. */
  | "reply"
  /** Source-language prompt → the language the user wrote it in. */
  | "language";

/**
 * Remembers translations so the same input always maps to byte-identical
 * output: history the model sees must not drift between turns, or the
 * prompt cache breaks. In-memory for now; `file` is where persistence
 * (phase 7) will keep it across `--resume`.
 */
export class TranslationMemory {
  private readonly entries = new Map<string, string>();

  constructor(readonly file: string) {}

  get(kind: MemoryKind, key: string): string | undefined {
    return this.entries.get(`${kind}\u0000${key}`);
  }

  set(kind: MemoryKind, key: string, value: string): void {
    this.entries.set(`${kind}\u0000${key}`, value);
  }

  close(): void {
    this.entries.clear();
  }
}
