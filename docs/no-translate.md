# Что не переводить

## Как это делают публичные переводчики

| Сервис | Механизм | Источник |
|---|---|---|
| Google Cloud Translation | `translate="no"` / `class="notranslate"` на элементе; работает **только** при `mimeType: text/html`, в plain text пропуск невозможен | [troubleshooting](https://docs.cloud.google.com/translate/troubleshooting) |
| DeepL | `tag_handling=xml\|html` + `ignore_tags` (содержимое тега не переводится), `non_splitting_tags`, `splitting_tags`, `outline_detection=false` | [translating-xml](https://developers.deepl.com/docs/translate/translating-xml), [structured-content](https://developers.deepl.com/docs/xml-and-html-handling/structured-content) |
| smikitky/chatgpt-md-translator (319★) | code fences длиннее N строк заменяются плейсхолдером `(((((hex)))))`, после перевода восстанавливаются; чанки режутся по пустым строкам вне fence | [md-utils.ts](https://github.com/smikitky/chatgpt-md-translator/blob/main/src/utils/md-utils.ts) |

Вывод для pclaude: общий приём — **маскирование**. Непереводимое вырезается до отправки в модель, заменяется непрозрачным токеном, после ответа подставляется обратно. Модель «защищённого» текста не видит, поэтому сломать его не может. Если плейсхолдер потерялся или задвоился, ошибку видно сразу: проверка — `set(placeholders_in) == set(placeholders_out)`, при расхождении ретрай или fallback на оригинал.

## Кандидаты на маскирование (сверх code fences)

Уровень markdown-токенов (`marked` Lexer, `.claude/api/marked.txt`):
1. Fenced/indented code blocks (уже в требованиях)
2. Inline code `` `x` ``
3. HTML-блоки и inline-теги (`<details>`, `<br>`, комментарии `<!-- -->`)
4. URL ссылок/картинок (`[text](url)` → переводим только `text`), autolinks, reference definitions `[id]: url`
5. Front-matter YAML (`---` в начале)
6. Math `$…$`, `$$…$$`; mermaid/diagram fences (частный случай fence)

Уровень текста (regex по оставшимся text-токенам):
7. Пути к файлам и `file:line` (`src/a.ts:42`, `C:\x\y`, `./foo`)
8. Идентификаторы: `camelCase`, `snake_case`, `PascalCase.method()`, `--cli-flags`, `ENV_VARS`
9. Шаблонные плейсхолдеры: `{name}`, `{{x}}`, `${x}`, `%s`, `$1`
10. Email, хэши/UUID, версии `v1.2.3`, числа с единицами
11. Emoji shortcodes `:rocket:`

Специфика Claude Code (структура запроса, а не markdown):
12. `tool_use.input`, `tool_result` (выводы команд/файлов), `thinking`/`redacted_thinking`, `signature` — не трогать целиком
13. Теги `<system-reminder>`, `<command-name>` и прочие XML-обёртки — маскировать тег, содержимое по политике
