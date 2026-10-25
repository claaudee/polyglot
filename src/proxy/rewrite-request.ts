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

/** Text transforms the request rewriter needs; TranslatorService implements them. */
export interface RequestTextOps {
  /** User text in any language → model language. */
  toModel(text: string): Promise<PromptText>;
  /** Displayed assistant text → the exact original the model produced. */
  restoreToModel(text: string): Promise<string>;
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
 * Rewrites a Messages request for the model: user text is translated into
 * the model language, assistant history is swapped back to the exact
 * English the model wrote (byte-stable, so the prompt cache keeps hitting).
 * Only `text` content is touched; tool_use, tool_result, thinking, images,
 * system — everything else — passes through as-is. Also reports the
 * language of the user's latest words, so the reply can go back in it.
 */
export const rewriteRequestBody = async (body: MessagesBody, ops: RequestTextOps): Promise<RewrittenRequest> => {
  if (!Array.isArray(body.messages)) return { body };
  const scopes = ops.scopes ?? DEFAULT_SCOPES;
  const restore: Rewrite = async (text) => ({ text: await ops.restoreToModel(text) });

  const rewritten = await Promise.all(
    body.messages.map(async (message): Promise<{ readonly message: Message; readonly language?: string }> => {
      if (message.role === "user" && scopes.user) {
        const { content, language } = await rewriteContent(message.content, (text) => ops.toModel(text));
        return { message: { ...message, content }, language };
      }
      if (message.role === "assistant" && scopes.assistant)
        return { message: { ...message, content: (await rewriteContent(message.content, restore)).content } };
      return { message };
    })
  );
  return { body: { ...body, messages: rewritten.map((entry) => entry.message) }, language: lastLanguage(rewritten) };
};
