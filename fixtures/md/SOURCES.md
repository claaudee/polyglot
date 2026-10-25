# MD fixtures: источники

Скачаны 2026-10-24 через `gh api .../contents/<path>?ref=<sha>` (raw). Оценка токенов ≈ байты / 4.
Повторная нарезка спецификаций: `node scripts/split-spec-fixtures.mjs fixtures/md/spec-raw fixtures/md/spec-cases`.

## real/: реальные сложные документы

| Файл | ≈токенов | Чем сложен | Источник | Лицензия |
|---|---|---|---|---|
| real/gh-docs-basic-formatting.md | 6164 | liquid {% %}, вложенные fences, таблицы, footnotes, alerts, HTML-комментарии | [github/docs@02c25d1](https://github.com/github/docs/blob/02c25d16369fe27f9bdb28d1201f6b452f0d21dd/content/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax.md) | CC-BY-4.0 |
| real/gh-docs-creating-diagrams.md | 1493 | mermaid, geoJSON, topoJSON, STL fences | [github/docs@02c25d1](https://github.com/github/docs/blob/02c25d16369fe27f9bdb28d1201f6b452f0d21dd/content/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams.md) | CC-BY-4.0 |
| real/gh-docs-writing-mathematical-expressions.md | 1251 | math $…$, $$…$$, `$…$` | [github/docs@02c25d1](https://github.com/github/docs/blob/02c25d16369fe27f9bdb28d1201f6b452f0d21dd/content/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions.md) | CC-BY-4.0 |
| real/gh-docs-organizing-information-with-tables.md | 1005 | GFM-таблицы с inline code и выравниванием | [github/docs@02c25d1](https://github.com/github/docs/blob/02c25d16369fe27f9bdb28d1201f6b452f0d21dd/content/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-tables.md) | CC-BY-4.0 |
| real/gh-docs-organizing-information-with-collapsed-sections.md | 615 | <details>/<summary> HTML | [github/docs@02c25d1](https://github.com/github/docs/blob/02c25d16369fe27f9bdb28d1201f6b452f0d21dd/content/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections.md) | CC-BY-4.0 |
| real/gh-docs-creating-and-highlighting-code-blocks.md | 954 | fences в fences (4 backticks), языки | [github/docs@02c25d1](https://github.com/github/docs/blob/02c25d16369fe27f9bdb28d1201f6b452f0d21dd/content/get-started/writing-on-github/working-with-advanced-formatting/creating-and-highlighting-code-blocks.md) | CC-BY-4.0 |
| real/gh-docs-autolinked-references-and-urls.md | 1323 | autolinks, #123, SHA, user/repo | [github/docs@02c25d1](https://github.com/github/docs/blob/02c25d16369fe27f9bdb28d1201f6b452f0d21dd/content/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls.md) | CC-BY-4.0 |
| real/gh-docs-about-tasklists.md | 1196 | task lists, вложенные списки | [github/docs@02c25d1](https://github.com/github/docs/blob/02c25d16369fe27f9bdb28d1201f6b452f0d21dd/content/get-started/writing-on-github/working-with-advanced-formatting/about-tasklists.md) | CC-BY-4.0 |
| real/node-readline.md | 10655 | много code fences (cjs/mjs), <!-- YAML --> блоки, ref-ссылки | [nodejs/node@41b1e68](https://github.com/nodejs/node/blob/41b1e6845a40a2328d6fb208462aac97d89b3ccc/doc/api/readline.md) | MIT |
| real/node-fs.md | 79469 | очень большой, сотни code fences, YAML-комментарии, ref-ссылки, таблицы | [nodejs/node@41b1e68](https://github.com/nodejs/node/blob/41b1e6845a40a2328d6fb208462aac97d89b3ccc/doc/api/fs.md) | MIT |
| real/awesome-readme.md | 19582 | длинные списки ссылок, HTML-шапка, badges, бэдж-картинки | [sindresorhus/awesome@bc98e51](https://github.com/sindresorhus/awesome/blob/bc98e517ddca672f55f9857d714fc3ea3c3540b2/readme.md) | CC0-1.0 |

## spec-raw/ → spec-cases/: эталонные пограничные случаи

Один `.md` на пример, `cases.json` — `{section, ext, markdown, html, file}`. Для теста round-trip: после маскирования, перевода и восстановления HTML-рендер должен совпасть с `html`.

| Каталог | Примеров | Источник | Лицензия |
|---|---|---|---|
| spec-cases/commonmark | 652 | [commonmark-spec@0.31.2 spec.txt](https://github.com/commonmark/commonmark-spec/blob/0.31.2/spec.txt) | CC-BY-SA-4.0 |
| spec-cases/gfm-extensions | 24 | [cmark-gfm@27d942c test/spec.txt](https://github.com/github/cmark-gfm/blob/27d942c8b0a62d192f616e5bf3578f4b6a89e180/test/spec.txt) (только extension-примеры) | CC-BY-SA-4.0 |
| spec-cases/markdown-it-commonmark_extras | 73 | [markdown-it@a8c00d4 commonmark_extras.txt](https://github.com/markdown-it/markdown-it/blob/a8c00d474ec9b304fad9b71c16d6fa8b4909279e/test/fixtures/markdown-it/commonmark_extras.txt) | MIT |
| spec-cases/markdown-it-fatal | 5 | [markdown-it@a8c00d4 fatal.txt](https://github.com/markdown-it/markdown-it/blob/a8c00d474ec9b304fad9b71c16d6fa8b4909279e/test/fixtures/markdown-it/fatal.txt) | MIT |
| spec-cases/markdown-it-linkify | 19 | [markdown-it@a8c00d4 linkify.txt](https://github.com/markdown-it/markdown-it/blob/a8c00d474ec9b304fad9b71c16d6fa8b4909279e/test/fixtures/markdown-it/linkify.txt) | MIT |
| spec-cases/markdown-it-normalize | 16 | [markdown-it@a8c00d4 normalize.txt](https://github.com/markdown-it/markdown-it/blob/a8c00d474ec9b304fad9b71c16d6fa8b4909279e/test/fixtures/markdown-it/normalize.txt) | MIT |
| spec-cases/markdown-it-strikethrough | 15 | [markdown-it@a8c00d4 strikethrough.txt](https://github.com/markdown-it/markdown-it/blob/a8c00d474ec9b304fad9b71c16d6fa8b4909279e/test/fixtures/markdown-it/strikethrough.txt) | MIT |
| spec-cases/markdown-it-tables | 38 | [markdown-it@a8c00d4 tables.txt](https://github.com/markdown-it/markdown-it/blob/a8c00d474ec9b304fad9b71c16d6fa8b4909279e/test/fixtures/markdown-it/tables.txt) | MIT |
| spec-cases/markdown-it-xss | 13 | [markdown-it@a8c00d4 xss.txt](https://github.com/markdown-it/markdown-it/blob/a8c00d474ec9b304fad9b71c16d6fa8b4909279e/test/fixtures/markdown-it/xss.txt) | MIT |
