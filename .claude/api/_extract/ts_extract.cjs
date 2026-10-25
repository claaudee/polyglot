#!/usr/bin/env node
// Extracts the public API surface (signatures + JSDoc, no bodies) from .d.ts/.ts files
// into a plain-text reference file. Usage:
//   node ts_extract.cjs --ts <typescript pkg dir> --name N --version V --source URL [--source URL]
//     --scope "..." --out FILE --root DIR [--exclude REGEX] [--include REGEX] FILE...
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const fail = (msg) => {
  process.stderr.write(`ts_extract: ${msg}\n`);
  process.exit(1);
};

const parseArgs = (argv) =>
  argv.reduce(
    (acc, arg, i, all) => {
      if (acc.skip) return { ...acc, skip: false };
      if (!arg.startsWith("--")) return { ...acc, files: [...acc.files, arg] };
      const key = arg.slice(2);
      const value = all[i + 1];
      if (value === undefined) fail(`missing value for ${arg}`);
      const prev = acc.opts[key];
      const next = key === "source" ? [...(prev ?? []), value] : value;
      return { ...acc, skip: true, opts: { ...acc.opts, [key]: next } };
    },
    { opts: {}, files: [], skip: false },
  );

const { opts, files } = parseArgs(process.argv.slice(2));
["ts", "name", "version", "source", "scope", "out", "root"].forEach((k) => opts[k] || fail(`--${k} is required`));
if (files.length === 0) fail("no input files");
files.forEach((f) => fs.existsSync(f) || fail(`input not found: ${f}`));
if (!fs.existsSync(opts.ts)) fail(`typescript not found: ${opts.ts}`);

const ts = require(path.resolve(opts.ts));
const exclude = opts.exclude ? new RegExp(opts.exclude) : null;
const include = opts.include ? new RegExp(opts.include) : null;

const DROP_TAGS = /^@(author|since|license|copyright|module|packageDocumentation|category)\b/;

const docOf = (node, sf) => {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const jsdoc = ranges.map((r) => sf.text.slice(r.pos, r.end)).filter((t) => t.startsWith("/**")).at(-1);
  if (!jsdoc) return null;
  const lines = jsdoc
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\* ?/, "").replace(/	/g, "  ").trimEnd());
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const dedent = indents.length ? Math.min(...indents) : 0;
  // Markdown fence markers are dropped (the file is plain text); the example code itself is kept.
  const kept = lines.map((l) => l.slice(dedent)).filter((l) => !/^\s*```/.test(l)).reduce(
    (acc, l) => {
      const tag = l.match(/^@\w+/);
      const dropping = tag ? DROP_TAGS.test(l) : acc.dropping;
      return { dropping, out: dropping ? acc.out : [...acc.out, l] };
    },
    { dropping: false, out: [] },
  ).out;
  const trimmed = kept.join("\n").trim();
  return trimmed || null;
};

const tagsOf = (doc) => ({
  internal: /(^|\n)@internal\b/.test(doc ?? ""),
  deprecated: /(^|\n)@deprecated\b/.test(doc ?? ""),
  hidden: /(^|\n)@(hidden|ignore|private)\b/.test(doc ?? ""),
});

const renderDoc = (doc, indent) => {
  const pad = " ".repeat(indent);
  if (!doc) return `${pad}/** (undocumented) */`;
  const lines = doc.split("\n");
  return lines.length === 1
    ? `${pad}/** ${lines[0]} */`
    : [`${pad}/**`, ...lines.map((l) => `${pad} * ${l}`.trimEnd()), `${pad} */`].join("\n");
};

const nameOf = (node) => {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map((d) => d.name.getText()).join(", ");
  return node.name ? node.name.getText() : "";
};

const modifiersOf = (node) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []);
const hasModifier = (node, kind) => modifiersOf(node).some((m) => m.kind === kind);
const isExported = (node) => hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword);

const isPrivateMember = (m) =>
  hasModifier(m, ts.SyntaxKind.PrivateKeyword) ||
  hasModifier(m, ts.SyntaxKind.ProtectedKeyword) ||
  (m.name && (ts.isPrivateIdentifier(m.name) || /^_/.test(m.name.getText())));

// JSDoc line prefixes inside inline object types collapse to a space.
const squash = (text) => text.replace(/\r?\n\s*\*(?!\/) ?/g, " ").replace(/\s*\r?\n\s*/g, " ").replace(/\s+/g, " ").trim();

// Text of a node with every function/method body and variable initializer removed.
const signatureText = (node, sf) => {
  const body = node.body && !ts.isModuleDeclaration(node) ? node.body : null;
  const initializer = node.initializer && !ts.isEnumMember(node) && !ts.isParameter(node) ? node.initializer : null;
  const cut = body ?? initializer;
  const start = node.getStart(sf);
  const end = cut ? cut.getFullStart() : node.getEnd();
  const raw = sf.text.slice(start, end).replace(/[=\s]*$/, "").replace(/;$/, "");
  return squash(raw);
};

const memberLines = (members, sf, indent) =>
  members
    .filter((m) => !isPrivateMember(m))
    .filter((m) => !ts.isClassStaticBlockDeclaration(m) && !ts.isSemicolonClassElement(m))
    .map((m) => ({ m, doc: docOf(m, sf) }))
    .filter(({ doc }) => {
      const t = tagsOf(doc);
      return !t.internal && !t.deprecated && !t.hidden;
    })
    .flatMap(({ m, doc }) => [renderDoc(doc, indent), `${" ".repeat(indent)}${signatureText(m, sf)}`]);

const headerText = (node, sf) => {
  const membersStart = node.members.pos;
  return squash(sf.text.slice(node.getStart(sf), membersStart).replace(/\{\s*$/, ""));
};

// Names listed in `export { _Lexer as Lexer }` / `export = _exports`: bundlers prefix public declarations with `_`.
const exportedNamesOf = (sf) =>
  new Set(
    sf.statements.flatMap((s) => {
      if (ts.isExportAssignment(s)) return [s.expression.getText(sf)];
      if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause))
        return s.exportClause.elements.map((e) => (e.propertyName ?? e.name).getText(sf));
      return [];
    }),
  );

const renderDecl = (node, sf, indent, inAmbient) => {
  const pad = " ".repeat(indent);
  const name = nameOf(node);
  if (/^_/.test(name) && !sf.exportedNames.has(name)) return [];
  if (exclude && exclude.test(name)) return [];
  if (include && indent === 2 && !include.test(name)) return [];
  const doc = docOf(node, sf);
  const t = tagsOf(doc);
  if (t.internal || t.deprecated || t.hidden) return [];

  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    return [`${pad}${name}`, renderDoc(doc, indent + 2), `${pad}  ${headerText(node, sf)}`, ...memberLines(node.members, sf, indent + 2), ""];
  }
  // `type X = { ... }` is an interface in disguise: expand its members with their docs instead of squashing.
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    const header = squash(sf.text.slice(node.getStart(sf), node.type.getStart(sf))).replace(/=$/, "").trim();
    return [`${pad}${name}`, renderDoc(doc, indent + 2), `${pad}  ${header}`, ...memberLines(node.type.members, sf, indent + 2), ""];
  }
  if (ts.isEnumDeclaration(node)) {
    const members = node.members.flatMap((m) => [renderDoc(docOf(m, sf), indent + 2), `${pad}  ${squash(m.getText(sf))}`]);
    return [`${pad}${name}`, renderDoc(doc, indent + 2), `${pad}  ${headerText(node, sf)}`, ...members, ""];
  }
  if (ts.isModuleDeclaration(node)) {
    const block = node.body && ts.isModuleBlock(node.body) ? node.body.statements : [];
    return [`${pad}${name}/`, renderDoc(doc, indent + 2), ...block.flatMap((s) => renderStatement(s, sf, indent + 2, true)), ""];
  }
  return [renderDoc(doc, indent), `${pad}${signatureText(node, sf)}`];
};

const DECL_KINDS = new Set([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
]);

const renderStatement = (node, sf, indent, inAmbient) => {
  const pad = " ".repeat(indent);
  if (ts.isExportDeclaration(node)) {
    // Bundled .d.mts files end with a bare `export { a, b as c }` list; keep it as the public index.
    return [`${pad}${squash(node.getText(sf)).replace(/;$/, "")}`];
  }
  if (ts.isExportAssignment(node)) return [`${pad}${squash(node.getText(sf)).replace(/;$/, "")}`];
  if (!DECL_KINDS.has(node.kind)) return [];
  if (!inAmbient && !isExported(node)) return [];
  return renderDecl(node, sf, indent, inAmbient);
};

const renderFile = (file) => {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  sf.exportedNames = exportedNamesOf(sf);
  // In declaration files every top-level declaration is part of the surface (export lists come separately).
  const ambient = /\.d\.[cm]?ts$/.test(file);
  const body = sf.statements.flatMap((s) => renderStatement(s, sf, 2, ambient));
  const rel = path.relative(opts.root, file).split(path.sep).join("/");
  return body.length ? [`${rel}/`, ...body, ""] : [];
};

const lines = files.flatMap(renderFile);
const typeCount = lines.filter((l) => /^ {2}\S/.test(l) && !/^ {2}\/\*\*/.test(l)).length;
const header = [
  `# ${opts.name} ${opts.version}`,
  ...opts.source.map((s) => `Source: ${s}`),
  `Collected: ${new Date().toISOString().slice(0, 10)}`,
  `Scope: ${opts.scope}`,
  `Declarations: ${typeCount}`,
  "",
];
fs.mkdirSync(path.dirname(opts.out), { recursive: true });
fs.writeFileSync(opts.out, [...header, ...lines].join("\n").replace(/\n{3,}/g, "\n\n"));
process.stdout.write(`${opts.out}: ${typeCount} top-level declarations, ${lines.length} lines\n`);
