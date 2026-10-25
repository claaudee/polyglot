import { DEFAULT_SCOPES, type Scopes } from "../text/scopes.js";

export interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface Message {
  readonly role: string;
  readonly content: string | readonly ContentBlock[];
}

export interface MessagesBody {
  readonly model?: string;
  readonly system?: unknown;
  readonly messages?: readonly Message[];
  readonly [key: string]: unknown;
}

/** User text as the model gets it, with the language the user wrote it in. */
export interface PromptText {
  readonly text: string;
  readonly language?: string;
}

/**
 * Text transforms the request rewriter needs; TranslatorService implements
 * them. `context` is the conversation so far as the model sees it, the
 * translation is asked inside of it.
 */
export interface RequestTextOps {
  /** User text in any language → model language. */
  toModel(text: string, context: readonly Message[]): Promise<PromptText>;
  /** Displayed assistant text → the exact original the model produced. */
  restoreToModel(text: string, context: readonly Message[]): Promise<string>;
  readonly scopes?: Scopes;
}

export interface RewrittenRequest {
  readonly body: MessagesBody;
  /** The language of the user's latest words: the reply is translated into it. */
  readonly language?: string;
}

type Rewrite = (text: string) => Promise<PromptText>;

/** The last part that says which language it is in. */
const lastLanguage = (parts: readonly { readonly language?: string }[]): string | undefined =>
  parts.findLast((part) => part.language !== undefined)?.language;

/**
 * Claude Code's harness wrappers (`<system-reminder>`, `<command-name>`,
 * `<local-command-stdout>`, …): always hyphenated tag names, kept verbatim.
 */
const WRAPPER = /<([a-z]+(?:-[a-z]+)+)>[\s\S]*?<\/\1>/g;

interface Segment {
  readonly text: string;
  readonly keep: boolean;
}

const segments = (text: string): readonly Segment[] => {
  const { out, last } = [...text.matchAll(WRAPPER)].reduce<{ readonly out: readonly Segment[]; readonly last: number }>(
    (acc, match) => ({
      out: [...acc.out, { text: text.slice(acc.last, match.index), keep: false }, { text: match[0], keep: true }],
      last: match.index + match[0].length,
    }),
    { out: [], last: 0 }
  );
  return [...out, { text: text.slice(last), keep: false }];
};

/** Applies `rewrite` to the text between wrappers; whitespace-only gaps are left alone. */
const outsideWrappers = async (text: string, rewrite: Rewrite): Promise<PromptText> => {
  const parts = segments(text);
  if (parts.length === 1) return rewrite(text);
  const rewritten = await Promise.all(
    parts.map((part): PromptText | Promise<PromptText> =>
      part.keep || part.text.trim() === "" ? { text: part.text } : rewrite(part.text)
    )
  );
  return { text: rewritten.map((part) => part.text).join(""), language: lastLanguage(rewritten) };
};

const rewriteContent = async (
  content: Message["content"],
  rewrite: Rewrite
): Promise<{ readonly content: Message["content"]; readonly language?: string }> => {
  if (typeof content === "string") {
    const { text, language } = await outsideWrappers(content, rewrite);
    return { content: text, language };
  }
  const blocks = await Promise.all(
    content.map(async (block) => {
      if (block.type !== "text" || typeof block.text !== "string") return { block };
      const { text, language } = await outsideWrappers(block.text, rewrite);
      return { block: { ...block, text }, language };
    })
  );
  return { content: blocks.map((entry) => entry.block), language: lastLanguage(blocks) };
};

/**
 * The context a user message is translated in: the rewritten history, then
 * the message's own tool results and other non-text blocks, which must
 * follow the tool calls they answer.
 */
const userContext = (history: readonly Message[], message: Message): readonly Message[] => {
  const rest = typeof message.content === "string" ? [] : message.content.filter((block) => block.type !== "text");
  return rest.length > 0 ? [...history, { ...message, content: rest }] : history;
};

/**
 * Rewrites a Messages request for the model: user text is translated into
 * the model language, assistant history is swapped back to the exact
 * English the model wrote (byte-stable, so the prompt cache keeps hitting).
 * Only `text` content is touched; tool_use, tool_result, thinking, images,
 * system — everything else — passes through as-is. Messages go in order,
 * so each is translated inside the already rewritten history before it;
 * remembered history costs nothing. Also reports the language of the
 * user's latest words, so the reply can go back in it.
 */
export const rewriteRequestBody = async (body: MessagesBody, ops: RequestTextOps): Promise<RewrittenRequest> => {
  if (!Array.isArray(body.messages)) return { body };
  const scopes = ops.scopes ?? DEFAULT_SCOPES;

  const messages: Message[] = [];
  let language: string | undefined;
  for (const message of body.messages) {
    const history = [...messages];
    if (message.role === "user" && scopes.user) {
      const context = userContext(history, message);
      const rewritten = await rewriteContent(message.content, (text) => ops.toModel(text, context));
      messages.push({ ...message, content: rewritten.content });
      language = rewritten.language ?? language;
    } else if (message.role === "assistant" && scopes.assistant) {
      const restore: Rewrite = async (text) => ({ text: await ops.restoreToModel(text, history) });
      messages.push({ ...message, content: (await rewriteContent(message.content, restore)).content });
    } else messages.push(message);
  }
  return { body: { ...body, messages }, language };
};
