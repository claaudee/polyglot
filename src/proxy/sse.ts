/**
 * Minimal Server-Sent-Events framing: splits an incoming byte stream into
 * complete records (terminated by a blank line) while buffering partials.
 * Records are kept as raw strings so untouched events can be relayed
 * byte-for-byte.
 */
export interface SseRecord {
  /** The record exactly as received, including its trailing blank line. */
  readonly raw: string;
  /** Parsed JSON of the `data:` line, or undefined when absent/invalid. */
  readonly data: unknown;
}

const RECORD_BOUNDARY = /\r?\n\r?\n/;

/**
 * All `data:` lines of a record, joined as the SSE spec says; `[DONE]` and
 * non-JSON payloads count as no data.
 * Copied from claude-code-router's `parseSseEventBlock`:
 * {@link https://github.com/musistudio/claude-code-router/blob/057abaa1f95519ab8faf999e1ccef2b80ccdeb9e/packages/core/src/gateway/features/hosted-web-search/sse.ts#L22-L40}
 */
const parseData = (raw: string): unknown => {
  const data = raw
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
};

export class SseParser {
  private buffer = "";

  push(chunk: string): readonly SseRecord[] {
    this.buffer += chunk;

    const records: SseRecord[] = [];
    for (;;) {
      const match = RECORD_BOUNDARY.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      records.push({ raw, data: parseData(raw) });
    }
    return records;
  }

  /** Whatever is left after the stream ends (normally empty). */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }
}

/** Serializes one event in the standard `event: ...\ndata: ...` framing. */
export const sseRecord = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
