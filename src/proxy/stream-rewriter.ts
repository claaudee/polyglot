import { debugLog } from "../log.js";
import { splitCompleted } from "../text/blocks.js";
import { SseParser, sseRecord, type SseRecord } from "./sse.js";
import type { ReplyTranslator } from "../translation/translator-service.js";

/**
 * Translates the assistant's reply while it streams. Only top-level `text`
 * blocks are touched: deltas are buffered per content block until a whole
 * markdown block (paragraph, list, fenced code, …) is complete, so the
 * masker always parses complete structure, then re-emitted as synthesized
 * `text_delta` events. Thinking, tool_use JSON, pings, usage —
 * everything else — passes through byte-for-byte. Any translation error
 * falls back to the original text (fail-open).
 */
interface StreamEvent {
  readonly type?: string;
  readonly index?: number;
  readonly content_block?: { readonly type?: string };
  readonly delta?: { readonly type?: string; readonly text?: string };
}

interface BlockState {
  buffer: string;
  original: string;
  displayed: string;
}

export interface ReplyStats {
  readonly inputChars: number;
  readonly outputChars: number;
}

const newBlock = (): BlockState => ({
  buffer: "",
  original: "",
  displayed: "",
});

export class ReplyStreamRewriter {
  private readonly blocks = new Map<number, BlockState>();
  /** The model's text so far, across blocks: the context each block is translated in. */
  private reply = "";

  constructor(
    private readonly service: ReplyTranslator,
    private readonly onReply: (stats: ReplyStats) => void = () => {}
  ) {}

  private async emitTranslated(index: number, block: BlockState, text: string): Promise<string> {
    if (text === "") return "";
    block.original += text;
    this.reply += text;
    const translated = await this.service.replyChunk(text, this.reply);
    block.displayed += translated;
    return sseRecord("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: translated },
    });
  }

  private async handleRecord(record: SseRecord): Promise<string> {
    const event = record.data as StreamEvent | undefined;
    const index = event?.index ?? -1;

    switch (event?.type) {
      case "content_block_start": {
        if (event.content_block?.type === "text") this.blocks.set(index, newBlock());
        return record.raw;
      }

      case "content_block_delta": {
        const block = this.blocks.get(index);
        if (!block || event.delta?.type !== "text_delta") return record.raw;

        const { completed, rest } = splitCompleted(block.buffer + (event.delta.text ?? ""));
        block.buffer = rest;
        return this.emitTranslated(index, block, completed);
      }

      case "content_block_stop": {
        const block = this.blocks.get(index);
        if (!block) return record.raw;

        const tail = await this.emitTranslated(index, block, block.buffer);
        block.buffer = "";
        this.service.rememberReply(block.original, block.displayed);
        this.onReply({ inputChars: block.original.length, outputChars: block.displayed.length });
        this.blocks.delete(index);
        return tail + record.raw;
      }

      default:
        return record.raw;
    }
  }

  /** Fail-open per record: emit whatever is buffered untranslated, then the original record. */
  private recover(record: SseRecord, error: unknown): string {
    debugLog("proxy:stream", error);
    const pending = [...this.blocks.entries()]
      .filter(([, block]) => block.buffer !== "")
      .map(([index, block]) => {
        const text = block.buffer;
        block.buffer = "";
        block.original += text;
        block.displayed += text;
        this.reply += text;
        return sseRecord("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        });
      })
      .join("");
    return pending + record.raw;
  }

  async *transform(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
    const parser = new SseParser();
    // stream:true keeps multi-byte UTF-8 sequences split across chunks intact
    const decoder = new TextDecoder();

    for await (const chunk of chunks) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      for (const record of parser.push(text)) {
        try {
          yield await this.handleRecord(record);
        } catch (error) {
          yield this.recover(record, error);
        }
      }
    }

    const rest = parser.push(decoder.decode()).map((record) => record.raw).join("") + parser.flush();
    if (rest !== "") yield rest;
  }
}

/**
 * For replies that are not translated (the user writes in the model's
 * language): relays every chunk the moment it arrives, byte for byte, and
 * reads the stream on the side only to report each finished top-level
 * `text` block, so its exact text can be remembered as history.
 */
export class ReplyRecorder {
  private readonly blocks = new Map<number, string>();

  constructor(private readonly onText: (text: string) => void) {}

  private read(record: SseRecord): void {
    const event = record.data as StreamEvent | undefined;
    const index = event?.index ?? -1;
    if (event?.type === "content_block_start" && event.content_block?.type === "text") this.blocks.set(index, "");
    const text = this.blocks.get(index);
    if (text === undefined) return;
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta")
      this.blocks.set(index, text + (event.delta.text ?? ""));
    if (event?.type === "content_block_stop") {
      this.blocks.delete(index);
      if (text !== "") this.onText(text);
    }
  }

  async *transform<C extends Uint8Array | string>(chunks: AsyncIterable<C>): AsyncGenerator<C> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    for await (const chunk of chunks) {
      yield chunk;
      try {
        for (const record of parser.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })))
          this.read(record);
      } catch (error) {
        debugLog("proxy:record", error);
      }
    }
  }
}

/**
 * Non-streaming variant: translates `content[].text` of a complete
 * Messages API response.
 */
export const rewriteResponseBody = async (
  body: unknown,
  service: ReplyTranslator,
  onReply: (stats: ReplyStats) => void = () => {}
): Promise<unknown> => {
  const response = body as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(response.content)) return body;

  const content = await Promise.all(
    response.content.map(async (block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const text = await service.replyChunk(block.text);
      service.rememberReply(block.text, text);
      onReply({ inputChars: block.text.length, outputChars: text.length });
      return { ...block, text };
    })
  );

  return { ...response, content };
};
