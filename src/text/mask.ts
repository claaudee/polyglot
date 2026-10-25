import { lexer, type Token, type Tokens } from "marked";

/**
 * Placeholder masking (the DeepL `ignore_tags` / chatgpt-md-translator
 * approach, see docs/no-translate.md): every span that must survive
 * translation verbatim — code, HTML, URLs, identifiers, … — is cut out and
 * replaced by an opaque `⟦n⟧`, so the model never sees it and cannot break
 * it. Restoring puts the exact original bytes back, so
 * `restore(mask(src), mask(src).text) === src` always holds.
 */
export interface Masked {
  /** The source with every protected span replaced by `⟦n⟧`. */
  readonly text: string;
  /** `slots[n]` is the original span behind `⟦n⟧`. */
  readonly slots: readonly string[];
}

export class PlaceholderMismatch extends Error {
  constructor(readonly expected: number, readonly found: readonly number[]) {
    super(`placeholder mismatch: expected ⟦0⟧..⟦${expected - 1}⟧, got [${found.join(",")}]`);
  }
}

type Span = readonly [start: number, end: number];

/** Result of walking tokens: spans found so far, where the scan stopped, and whether every protected token was located. */
interface Walk {
  readonly spans: readonly Span[];
  readonly cursor: number;
  readonly ok: boolean;
}

const PLACEHOLDER = /⟦(\d+)⟧/g;
const placeholder = (index: number): string => `⟦${index}⟧`;

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Tokens whose whole source is kept verbatim. */
const PROTECTED = new Set(["code", "codespan", "html", "def"]);

const LINE_SUFFIX = String.raw`(?::\d+(?::\d+)?)?`;

/** Text-level protection, applied to whatever markdown structure left translatable. */
const TEXT_PATTERNS: readonly RegExp[] = [
  /⟦\d+⟧/, // literal placeholders already in the source
  /\$\$[\s\S]+?\$\$/, // display math
  /\$(?=\S)[^$\n]+?(?<=\S)\$(?!\d)/, // inline math
  /&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/, // entities
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, // email
  /\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b/, // UUID
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/, // hashes
  /\bv?\d+(?:\.\d+){2,}(?:-[\w.]+)?\b|\bv\d+(?:\.\d+)?\b/, // versions
  /\$\{[^}\n]*\}|\{\{[^}\n]*\}\}|\{%[^%\n]*%\}|\{[A-Za-z_][\w.]*\}|%(?:\d+\$)?[sdif]\b|\$\d+\b/, // templates
  new RegExp(String.raw`(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])[\w.\\/-]*` + LINE_SUFFIX), // ./x, ~/x, C:\x
  new RegExp(String.raw`(?<![\w)\]>.])\/[\w.-]+(?:\/[\w.-]+)+` + LINE_SUFFIX), // /usr/bin/x
  new RegExp(String.raw`\b[\w-]{2,}(?:[./][\w-]+)*\.[a-z][a-z0-9]{0,5}\b` + LINE_SUFFIX), // src/a.ts:42
  /(?<![\w-])(?:--[A-Za-z][\w-]*|-[A-Za-z]\b)/, // --flags, -p
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)/, // calls()
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/, // camelCase
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/, // PascalCase
  /\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/, // snake_case, ENV_VARS
  /(?<![\w:]):[a-z0-9_+-]*[a-z][a-z0-9_+-]*:(?![\w:])/, // :emoji:
];

/**
 * Quoted text in a prompt is usually literal: what to write into a file,
 * search for or name something. The model reads it in the user's language
 * fine; translated, it would end up in the user's files in English. Within
 * one line, so a stray quote never swallows a paragraph.
 */
const QUOTE_PATTERNS: readonly RegExp[] = [
  /«[^«»\n]+»/, // «ёлочки»
  /„[^„“”\n]+[“”]/, // „лапки“
  /“[^“”\n]+”/, // “curly”
  /"[^"\n]+"/, // "straight"
];

const anyOf = (patterns: readonly RegExp[]): RegExp =>
  new RegExp(patterns.map((pattern) => `(?:${pattern.source})`).join("|"), "g");

const TEXT_PATTERN = anyOf(TEXT_PATTERNS);
const TEXT_AND_QUOTE_PATTERN = anyOf([...QUOTE_PATTERNS, ...TEXT_PATTERNS]);

export interface MaskOptions {
  /** Also keep quoted text verbatim: for prompts, where quotes mark literals. */
  readonly quotes?: boolean;
}

/** Index of `needle` in `src[from, to)`, or -1. */
const locate = (src: string, needle: string, from: number, to: number): number => {
  const at = src.indexOf(needle, from);
  return at >= 0 && at + needle.length <= to ? at : -1;
};

const located = (spans: readonly Span[], cursor: number): Walk => ({ spans, cursor, ok: true });
const failed = (cursor: number): Walk => ({ spans: [], cursor, ok: false });

const childrenOf = (token: Token): readonly Token[] => {
  if (token.type === "list") return (token as Tokens.List).items;
  if (token.type === "table") {
    const table = token as Tokens.Table;
    return [...table.header, ...table.rows.flat()].flatMap((cell) => cell.tokens);
  }
  return (token as Tokens.Generic).tokens ?? [];
};

/**
 * Nested tokens of blockquotes and list items carry dedented `raw`, so a
 * multi-line code block there is not a substring of the source; its lines are.
 */
const walkLines = (src: string, raw: string, from: number, to: number): Walk => {
  const spans: Span[] = [];
  let cursor = from;
  for (const line of raw.split("\n").filter((candidate) => candidate.trim() !== "")) {
    const at = locate(src, line, cursor, to);
    if (at < 0) return failed(from);
    spans.push([at, at + line.length]);
    cursor = at + line.length;
  }
  return located(spans, cursor);
};

/** `[text](url)` → only `text` stays translatable; shortcut/collapsed references and autolinks are kept whole. */
const walkLink = (src: string, token: Tokens.Link | Tokens.Image, at: number, end: number): Walk => {
  const open = token.type === "image" ? "![" : "[";
  const label = `${open}${token.text}]`;
  const suffix = token.raw.slice(label.length);
  if (!token.raw.startsWith(label) || suffix === "" || suffix === "[]") return located([[at, end]], end);

  const inner = walkTokens(src, token.tokens, at + open.length, at + label.length - 1);
  return located(inner.ok ? [...inner.spans, [end - suffix.length, end]] : [[at, end]], end);
};

const walkToken = (src: string, token: Token, from: number, to: number): Walk => {
  const at = locate(src, token.raw, from, to);
  const end = at + token.raw.length;

  if (PROTECTED.has(token.type)) return at >= 0 ? located([[at, end]], end) : walkLines(src, token.raw, from, to);
  if (token.type === "link" || token.type === "image")
    return at >= 0 ? walkLink(src, token as Tokens.Link | Tokens.Image, at, end) : failed(from);

  const children = childrenOf(token);
  if (at < 0) return children.length > 0 ? walkTokens(src, children, from, to) : located([], from);

  // The nearest container we could place absorbs any failure below it: keeping it whole is always safe.
  const inner = walkTokens(src, children, at, end);
  return located(inner.ok ? inner.spans : [[at, end]], end);
};

const walkTokens = (src: string, tokens: readonly Token[], from: number, to: number): Walk => {
  const spans: Span[] = [];
  let cursor = from;
  for (const token of tokens) {
    const walk = walkToken(src, token, cursor, to);
    if (!walk.ok) return failed(from);
    spans.push(...walk.spans);
    cursor = walk.cursor;
  }
  return located(spans, cursor);
};

/** The complement of sorted, disjoint `spans` within `[0, length)`. */
const gaps = (spans: readonly Span[], length: number): readonly Span[] => {
  const out: Span[] = [];
  let last = 0;
  for (const [start, end] of [...spans, [length, length] as const]) {
    if (start > last) out.push([last, start]);
    last = Math.max(last, end);
  }
  return out;
};

const textSpans = (src: string, protectedSpans: readonly Span[], pattern: RegExp): readonly Span[] =>
  gaps(protectedSpans, src.length).flatMap(([start, end]) =>
    [...src.slice(start, end).matchAll(pattern)].map(
      (match): Span => [start + match.index, start + match.index + match[0].length]
    )
  );

/** Sorts and fuses overlapping or touching spans. */
const merge = (spans: readonly Span[]): readonly Span[] => {
  const out: [start: number, end: number][] = [];
  for (const [start, end] of spans.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
};

const structuralSpans = (src: string): readonly Span[] => {
  const frontMatter = FRONT_MATTER.exec(src)?.[0].length ?? 0;
  const body = walkTokens(src, lexer(src.slice(frontMatter)), frontMatter, src.length);
  return [
    ...(frontMatter > 0 ? [[0, frontMatter] as const] : []),
    ...(body.ok ? body.spans : [[frontMatter, src.length] as const]),
  ];
};

/** Replaces everything untranslatable in `src` with `⟦n⟧` placeholders. */
export const mask = (src: string, options: MaskOptions = {}): Masked => {
  const structural = merge(structuralSpans(src));
  const spans = merge([
    ...structural,
    ...textSpans(src, structural, options.quotes ? TEXT_AND_QUOTE_PATTERN : TEXT_PATTERN),
  ]);
  const parts: string[] = [];
  let last = 0;
  spans.forEach(([start, end], index) => {
    parts.push(src.slice(last, start), placeholder(index));
    last = end;
  });
  parts.push(src.slice(last));
  return { text: parts.join(""), slots: spans.map(([start, end]) => src.slice(start, end)) };
};

const placeholdersIn = (text: string): readonly number[] =>
  [...text.matchAll(PLACEHOLDER)].map((match) => Number(match[1]));

/** True when `translated` holds every placeholder of `masked` exactly once, and nothing else. */
export const verify = (masked: Masked, translated: string): boolean => {
  const found = [...placeholdersIn(translated)].sort((a, b) => a - b);
  return found.length === masked.slots.length && found.every((index, position) => index === position);
};

/** Puts the original spans back; throws `PlaceholderMismatch` when the translation lost or duplicated any. */
export const restore = (masked: Masked, translated: string): string => {
  if (!verify(masked, translated)) throw new PlaceholderMismatch(masked.slots.length, placeholdersIn(translated));
  return translated.replace(PLACEHOLDER, (_, index: string) => masked.slots[Number(index)] ?? "");
};
