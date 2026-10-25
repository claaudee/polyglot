import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { debugLog } from "../log.js";

export type MemoryKind =
  /** Source-language prompt → what was sent to the model. */
  | "prompt"
  /** Translated reply as displayed → the model's original text. */
  | "reply"
  /** Source-language prompt → the language the user wrote it in. */
  | "language";

/** In-memory database, for tests and as the fallback when the file cannot be opened. */
export const IN_MEMORY = ":memory:";

/**
 * `node:sqlite` still announces itself as experimental on load; that line
 * would land in the user's terminal on every start, so only it is dropped.
 */
const loadSqlite = (): typeof import("node:sqlite") => {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: never[]) => {
    if (!String(warning).includes("SQLite")) emitWarning.call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS translations (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  ) WITHOUT ROWID`;

const open = (file: string): DatabaseSync => {
  const { DatabaseSync } = loadSqlite();
  if (file !== IN_MEMORY) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL and a busy timeout let several pclaude sessions share the file.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
};

/**
 * Remembers translations so the same input always maps to byte-identical
 * output: history the model sees must not drift between turns, or the
 * prompt cache breaks. Kept in SQLite at `file`, so `--continue` and
 * `--resume` find the translations of earlier runs. The first translation
 * stored for a key wins, also across sessions writing at once. A file that
 * cannot be opened leaves memory per process rather than failing the proxy.
 */
export class TranslationMemory {
  private readonly db: DatabaseSync;
  private readonly select: StatementSync;
  private readonly insert: StatementSync;

  constructor(readonly file: string) {
    this.db = (() => {
      try {
        return open(file);
      } catch (error) {
        debugLog("memory:open", error);
        return open(IN_MEMORY);
      }
    })();
    this.select = this.db.prepare("SELECT value FROM translations WHERE kind = ? AND key = ?");
    this.insert = this.db.prepare("INSERT INTO translations (kind, key, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
  }

  get(kind: MemoryKind, key: string): string | undefined {
    const row = this.select.get(kind, key) as { value: string } | undefined;
    return row?.value;
  }

  /** Stores `value` unless the key already has one; returns the value now held. */
  set(kind: MemoryKind, key: string, value: string): string {
    this.insert.run(kind, key, value);
    return this.get(kind, key) ?? value;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
