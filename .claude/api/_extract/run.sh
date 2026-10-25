#!/usr/bin/env bash
# Regenerates .claude/api/*.txt from unpacked npm tarballs (pkgs/) and the claude-code-router clone (ccr/).
# Usage: run.sh <workdir with pkgs/ and ccr/> <output dir>
set -euo pipefail
W="${1:?workdir}"; O="${2:?out dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
P="$W/pkgs"; R=https://registry.npmjs.org
x() { node "$HERE/ts_extract.cjs" --ts "$P/typescript/package" "$@"; }

S="$P/anthropic-ai__sdk/package"
x --name anthropic-sdk --version 1.3.0 --source "$R/@anthropic-ai/sdk/-/sdk-1.3.0.tgz" --root "$S" --out "$O/anthropic-sdk.txt" \
  --scope "client options, errors, SSE Stream, APIPromise, MessageStream, Messages resource and core message/stream/usage types. Excluded: beta, batches, files, models, server tools (browser/computer/code-execution/web-fetch/web-search/tool-search/text-editor/memory), citations, containers, skills." \
  --exclude '^(Browser|Computer|Response(Browser|Computer)|BROWSER_|COMPUTER_|BashCodeExecution|CodeExecution|EncryptedCodeExecution|TextEditorCodeExecution|WebFetch|WebSearch|ToolSearch|ToolTextEditor|ToolBash|MemoryTool|Citation(?!sDelta)|Container|Skill|ServerToolCaller|Diagnostics|CacheMiss|ImageTransformations|Batches|Beta)' \
  "$S/client.d.ts" "$S/core/error.d.ts" "$S/core/streaming.d.ts" "$S/core/api-promise.d.ts" "$S/lib/MessageStream.d.ts" "$S/resources/messages/messages.d.ts"

x --name clack-prompts --version "1.8.1 (+ @clack/core 1.5.1)" --source "$R/@clack/prompts/-/prompts-1.8.1.tgz" --source "$R/@clack/core/-/core-1.5.1.tgz" \
  --root "$P" --out "$O/clack-prompts.txt" --scope "full public API of @clack/prompts and the @clack/core primitives it re-exports" \
  "$P/clack__prompts/package/dist/index.d.mts" "$P/clack__core/package/dist/index.d.mts"

x --name cli-table3 --version 0.6.5 --source "$R/cli-table3/-/cli-table3-0.6.5.tgz" --root "$P/cli-table3/package" --out "$O/cli-table3.txt" \
  --scope "full public API" "$P/cli-table3/package/index.d.ts"

x --name commander --version 15.0.0 --source "$R/commander/-/commander-15.0.0.tgz" --root "$P/commander/package" --out "$O/commander.txt" \
  --scope "full public API (Command, Option, Argument, Help, errors)" "$P/commander/package/typings/index.d.ts"

x --name conf --version 16.0.0 --source "$R/conf/-/conf-16.0.0.tgz" --root "$P/conf/package" --out "$O/conf.txt" \
  --scope "full public API (Conf class, Options, schema/migrations types)" "$P/conf/package/dist/source/index.d.ts" "$P/conf/package/dist/source/types.d.ts"

x --name env-paths --version 4.0.0 --source "$R/env-paths/-/env-paths-4.0.0.tgz" --root "$P/env-paths/package" --out "$O/env-paths.txt" \
  --scope "full public API" "$P/env-paths/package/index.d.ts"

E="$P/execa/package"
x --name execa --version 10.2.1 --source "$R/execa/-/execa-10.2.1.tgz" --root "$E" --out "$O/execa.txt" \
  --scope "full public API: execa/execaNode/$ methods, options, result, subprocess, errors, ipc, pipe, stdio, transforms" \
  "$E/index.d.ts" $(find "$E/types" -name '*.d.ts' | sort)

x --name picocolors --version 1.1.1 --source "$R/picocolors/-/picocolors-1.1.1.tgz" --root "$P/picocolors/package" --out "$O/picocolors.txt" \
  --scope "full public API" "$P/picocolors/package/picocolors.d.ts" "$P/picocolors/package/types.d.ts"

x --name pino --version 10.4.0 --source "$R/pino/-/pino-10.4.0.tgz" --root "$P/pino/package" --out "$O/pino.txt" \
  --scope "full public API (pino namespace, LoggerOptions, transports, destination, child loggers, levels)" "$P/pino/package/pino.d.ts"

A="$P/opentelemetry__api-logs/package/build/esm"; L="$P/opentelemetry__sdk-logs/package/dist"; RS="$P/opentelemetry__resources/package/dist"
x --name opentelemetry-logs --version "api-logs 0.223.0, sdk-logs 3.0.0, exporter-logs-otlp-http 0.300.0, resources 3.0.0, pino-opentelemetry-transport 4.0.2, instrumentation-pino 0.70.0" \
  --source "$R/@opentelemetry/api-logs/-/api-logs-0.223.0.tgz" --source "$R/@opentelemetry/sdk-logs/-/sdk-logs-3.0.0.tgz" \
  --source "$R/@opentelemetry/exporter-logs-otlp-http/-/exporter-logs-otlp-http-0.300.0.tgz" --source "$R/@opentelemetry/resources/-/resources-3.0.0.tgz" \
  --source "$R/pino-opentelemetry-transport/-/pino-opentelemetry-transport-4.0.2.tgz" --source "$R/@opentelemetry/instrumentation-pino/-/instrumentation-pino-0.70.0.tgz" \
  --root "$P" --out "$O/opentelemetry-logs.txt" \
  --scope "logs signal only: api-logs (Logger, LogRecord, SeverityNumber, logs global), sdk-logs (LoggerProvider, processors, exporters; node platform), OTLP HTTP log exporter (node), resources (resourceFromAttributes, detectors), pino-opentelemetry-transport, instrumentation-pino. Excluded: browser platform, internal/, traces/metrics." \
  "$A/index.d.ts" "$A/api/logs.d.ts" $(ls "$A"/types/*.d.ts) \
  $(ls "$L"/*.d.mts "$L"/export/*.d.mts "$L"/config/*.d.mts) "$L/platform/node/export/BatchLogRecordProcessor.d.mts" \
  "$P/opentelemetry__exporter-logs-otlp-http/package/dist/platform/node/OTLPLogExporter.d.mts" \
  "$RS/index.d.mts" "$RS/Resource.d.mts" "$RS/detect-resources.d.mts" "$RS/types.d.mts" "$RS/config.d.mts" \
  $(ls "$P"/pino-opentelemetry-transport/package/types/*.d.ts) \
  "$P/opentelemetry__instrumentation-pino/package/dist/instrumentation.d.mts" "$P/opentelemetry__instrumentation-pino/package/dist/types.d.mts"

x --name marked --version 18.1.1 --source "$R/marked/-/marked-18.1.1.tgz" --root "$P/marked/package" --out "$O/marked.txt" \
  --scope "full public API (Lexer, Tokens, Parser, Renderer, walkTokens, extensions)" "$P/marked/package/lib/marked.d.ts"

C="$W/ccr/packages/core/src"; SHA="$(git -C "$W/ccr" rev-parse HEAD)"
x --name claude-code-router --version "core 3.1.3 @ $SHA" --source "https://github.com/musistudio/claude-code-router/tree/$SHA/packages/core/src" \
  --root "$C" --out "$O/claude-code-router.txt" \
  --scope "exported API of the gateway HTTP path: server entrypoint, request handler, HTTP io, request pipeline, upstream executor, header sanitizer, request rewrite. Excluded: UI, electron, providers catalog, hosted web search, context archive, storage, MCP." \
  "$C/entrypoints/server.ts" "$C/gateway/http/request-handler.ts" "$C/gateway/http/io.ts" "$C/gateway/request/pipeline.ts" \
  "$C/gateway/upstream/executor.ts" "$C/gateway/core-runtime/upstream-header-sanitizer.ts" "$C/routing/rewrite.ts"

# Merge every per-library file into one reference with a table of contents (header lines are copied from each file).
PARTS=(anthropic-sdk claude-code-router clack-prompts opentelemetry-logs pino execa conf commander marked cli-table3 env-paths picocolors)
{
  echo "# API reference (merged)"
  echo "Generated: $(date +%F) by .claude/api/_extract/run.sh"
  echo
  echo "Contents:"
  for n in "${PARTS[@]}"; do echo "  $(head -1 "$O/$n.txt" | sed 's/^# //')  [$(grep -m1 '^Declarations:' "$O/$n.txt")]"; done
  for n in "${PARTS[@]}"; do printf '\n%s\n' "$(printf '=%.0s' {1..100})"; cat "$O/$n.txt"; done
} > "$O/all.txt"
echo "$O/all.txt: $(wc -l < "$O/all.txt") lines"
