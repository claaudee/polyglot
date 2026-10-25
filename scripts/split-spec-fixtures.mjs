#!/usr/bin/env node
// Splits CommonMark/GFM spec.txt and markdown-it fixture files into one .md file per example
// plus cases.json (markdown + expected HTML) for round-trip tests.
// Usage: node scripts/split-spec-fixtures.mjs <spec-raw dir> <out dir>
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [rawDir, outDir] = process.argv.slice(2);
if (!rawDir || !outDir) {
  console.error("usage: split-spec-fixtures.mjs <spec-raw dir> <out dir>");
  process.exit(1);
}

const FENCE = "`".repeat(32);
// Spec files show tabs as U+2192.
const untab = (s) => s.replaceAll("→", "\t");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "misc";

const parseSpec = (text, { extensionsOnly }) =>
  text.split("\n").reduce(
    (acc, line) => {
      if (acc.mode === "text") {
        const heading = line.match(/^#{1,6} (.+)$/);
        if (heading) return { ...acc, section: heading[1] };
        const open = line.match(new RegExp(`^${FENCE} example(?: (\\w+))?$`));
        return open ? { ...acc, mode: "md", cur: { section: acc.section, ext: open[1] ?? null, md: [], html: [] } } : acc;
      }
      if (line === FENCE) {
        const keep = !extensionsOnly || acc.cur.ext;
        return { ...acc, mode: "text", cases: keep ? [...acc.cases, acc.cur] : acc.cases, cur: null };
      }
      if (acc.mode === "md" && line === ".") return { ...acc, mode: "html" };
      acc.cur[acc.mode].push(line);
      return acc;
    },
    { mode: "text", section: "", cur: null, cases: [] },
  ).cases.map((c) => ({ section: c.section, ext: c.ext, markdown: untab(c.md.join("\n") + "\n"), html: untab(c.html.join("\n") + "\n") }));

// markdown-it format: title lines, ".", markdown, ".", html, "." repeated.
const parseMarkdownIt = (text, file) =>
  text.split(/\r?\n/).reduce(
    (acc, line) => {
      if (line === ".") {
        const next = { title: "md", md: "html", html: "title" }[acc.mode];
        if (acc.mode === "html") return { mode: next, title: [], md: [], html: [], cases: [...acc.cases, { section: acc.title.join(" ").trim() || file, ext: null, markdown: acc.md.join("\n") + "\n", html: acc.html.join("\n") + "\n" }] };
        return { ...acc, mode: next };
      }
      return { ...acc, [acc.mode]: [...acc[acc.mode], line] };
    },
    { mode: "title", title: [], md: [], html: [], cases: [] },
  ).cases;

const sources = readdirSync(rawDir).flatMap((file) => {
  const text = readFileSync(join(rawDir, file), "utf8");
  if (file.startsWith("commonmark-spec")) return [{ name: "commonmark", cases: parseSpec(text, { extensionsOnly: false }) }];
  // GFM spec repeats CommonMark 0.29; only its extension examples (tables, strikethrough, autolinks, tasklists, tagfilter) are new.
  if (file.startsWith("gfm-spec")) return [{ name: "gfm-extensions", cases: parseSpec(text, { extensionsOnly: true }) }];
  if (file.startsWith("markdown-it-")) return [{ name: file.replace(/\.txt$/, ""), cases: parseMarkdownIt(text, file) }];
  return [];
});

const written = sources.map(({ name, cases }) => {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const indexed = cases.map((c, i) => ({ ...c, file: `${String(i + 1).padStart(4, "0")}-${slug(c.section)}.md` }));
  indexed.forEach((c) => writeFileSync(join(dir, c.file), c.markdown));
  writeFileSync(join(dir, "cases.json"), JSON.stringify(indexed, null, 2));
  return `${name}: ${indexed.length}`;
});
console.log(written.join("\n"));
