# `claude -p` для бенчей (проверено на Claude Code 2.1.306, 2026-10-24)

Пробный запуск:

    echo "Reply with: ok" | claude -p --model haiku --output-format json --no-session-persistence --max-budget-usd 0.05 --tools ""

## Полезные поля JSON-результата
- `total_cost_usd`: стоимость запуска
- `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`
- `usage.output_tokens_details.thinking_tokens`: thinking включён по умолчанию даже у haiku (75 токенов на «ok»)
- `modelUsage.<model>.costUSD`, `contextWindow` (1M), `maxOutputTokens` (128k)
- `is_error`, `subtype`, `num_turns`, `duration_ms`, `ttft_ms`

## Лимиты и флаги
- `--max-budget-usd <amount>`: потолок по стоимости, работает только с `--print`
- `--max-turns` в `--help` **нет** (в 2.1.306 флаг не задокументирован). Вместо него для одноходового запуска: `--tools ""`
- `--effort low|medium|high|xhigh|max`: для бенча «haiku medium» → `--model haiku --effort medium`
- `--no-session-persistence`, `--bare` (без хуков и плагинов), `--system-prompt`: нужны, чтобы бенч был чистым
- Каждый запуск добавляет к входу системный промпт Claude Code (cache_creation ~3.4k токенов): сравнивать надо дельты ru и en, а не абсолютные значения
