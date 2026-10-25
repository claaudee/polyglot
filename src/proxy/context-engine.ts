import { log } from "../log.js";
import {
  parseTranslation,
  translationRequest,
  type Conversation,
  type Translation,
  type TranslationEngine,
} from "../translation/engine.js";
import type { ContentBlock, Message, MessagesBody } from "./rewrite-request.js";
import { SseParser } from "./sse.js";

export interface ContextEngineOptions {
  /** The upstream Messages endpoint the intercepted request was bound for. */
  readonly url: string;
  /** The intercepted request's own headers: its sign-in, betas and client identity. */
  readonly headers: Record<string, string>;
  /** The intercepted request: model, system, tools, thinking and the rest are reused as sent; only `messages` changes. */
  readonly body: MessagesBody;
}

interface StreamEvent {
  readonly type?: string;
  readonly delta?: { readonly type?: string; readonly text?: string; readonly stop_reason?: string };
  readonly message?: { readonly usage?: unknown };
  readonly usage?: unknown;
  readonly error?: unknown;
}

const blocksOf = (content: Message["content"]): readonly ContentBlock[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

/**
 * `context` plus the task: on its last user message, or as a new user turn
 * after an assistant one. Trailing `system` messages (Claude Code's
 * environment) must end the array, so the task goes before them; replies
 * avoid that, as they come with an assistant turn after the environment.
 */
const withTask = (context: Conversation, task: string): readonly Message[] => {
  const all = context as readonly Message[];
  const end = all.findLastIndex((message) => message.role !== "system") + 1;
  const [messages, trailing] = [all.slice(0, end), all.slice(end)];
  const last = messages.at(-1);
  const block: ContentBlock = { type: "text", text: task };
  return last?.role === "user"
    ? [...messages.slice(0, -1), { ...last, content: [...blocksOf(last.content), block] }, ...trailing]
    : [...messages, { role: "user", content: [block] }, ...trailing];
};

/** The text of a streamed reply; refuses one that stopped to call a tool or broke off. */
const streamedText = async (body: ReadableStream<Uint8Array>): Promise<string> => {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const usage: unknown[] = [];
  let text = "";
  let stop: string | undefined;
  for await (const chunk of body)
    for (const record of parser.push(decoder.decode(chunk, { stream: true }))) {
      const event = record.data as StreamEvent | undefined;
      if (event?.type === "error") throw new Error(`translation stream error: ${JSON.stringify(event.error)}`);
      if (event?.type === "message_start") usage.push(event.message?.usage);
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") text += event.delta.text ?? "";
      if (event?.type === "message_delta") {
        stop = event.delta?.stop_reason;
        usage.push(event.usage);
      }
    }
  log().debug({ scope: "translate:usage", usage, stop }, "translation call");
  if (stop !== "end_turn" && stop !== "stop_sequence") throw new Error(`translation stopped: ${stop}`);
  return text;
};

/**
 * Translates inside the user's own conversation: the intercepted request is
 * sent again, same model, system, tools and sign-in, with the translation
 * task added after the context it is given. The cached prefix keeps that
 * cheap and the subscription pays as for any turn. Nothing of the exchange
 * is kept: the conversation the model goes on with is "rewound" to before
 * it and only gets the translated text.
 */
export class ContextEngine implements TranslationEngine {
  readonly name: string;

  constructor(private readonly options: ContextEngineOptions) {
    this.name = `context:${options.body.model ?? "unknown"}`;
  }

  async translate(text: string, from: string | undefined, to: string, context: Conversation): Promise<Translation> {
    const response = await fetch(this.options.url, {
      method: "POST",
      headers: this.options.headers,
      body: JSON.stringify({
        ...this.options.body,
        stream: true,
        messages: withTask(context, translationRequest(text, from, to)),
      }),
    });
    if (!response.ok || !response.body)
      throw new Error(`translation request failed: ${response.status} ${await response.text()}`);
    return parseTranslation(await streamedText(response.body));
  }
}
