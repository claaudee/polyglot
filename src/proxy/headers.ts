import type { IncomingMessage } from "node:http";

/**
 * Hop-by-hop and framing headers: they describe one connection, so they never
 * cross the proxy in either direction; fetch sets its own.
 * Copied from claude-code-router's `transportHeaderNames`:
 * {@link https://github.com/musistudio/claude-code-router/blob/057abaa1f95519ab8faf999e1ccef2b80ccdeb9e/packages/core/src/gateway/core-runtime/upstream-header-sanitizer.ts#L75-L88}
 * plus `proxy-connection`, which some clients still send.
 */
const transportHeaderNames = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Copied from claude-code-router's `proxyMetadataHeaderNames`:
 * {@link https://github.com/musistudio/claude-code-router/blob/057abaa1f95519ab8faf999e1ccef2b80ccdeb9e/packages/core/src/gateway/core-runtime/upstream-header-sanitizer.ts#L69-L73}
 */
const proxyMetadataHeaderNames = new Set(["forwarded", "via", "x-real-ip"]);

const headerValues = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * The client's headers as they go upstream: its sign-in, betas and client
 * identity pass untouched; transport headers, the ones its `Connection`
 * header names, and proxy metadata do not. The reply must come back
 * uncompressed, since the proxy reads it.
 * Adapted from claude-code-router's `mergeUpstreamProviderHeaders`, minus
 * the provider-auth swap (pclaude forwards the client's own sign-in):
 * {@link https://github.com/musistudio/claude-code-router/blob/057abaa1f95519ab8faf999e1ccef2b80ccdeb9e/packages/core/src/gateway/core-runtime/upstream-header-sanitizer.ts#L187-L224}
 */
export const upstreamRequestHeaders = (headers: IncomingMessage["headers"]): Record<string, string> => {
  const connectionHeaders = new Set(transportHeaderNames);
  for (const value of headerValues(headers.connection))
    for (const name of value.split(",")) {
      const normalized = name.trim().toLowerCase();
      if (normalized) connectionHeaders.add(normalized);
    }

  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (
      !normalized ||
      value === undefined ||
      proxyMetadataHeaderNames.has(normalized) ||
      normalized.startsWith("x-forwarded-") ||
      connectionHeaders.has(normalized)
    )
      continue;
    forwarded[normalized] = Array.isArray(value) ? value.join(",") : value;
  }
  return { ...forwarded, "accept-encoding": "identity" };
};

/** The upstream reply's headers as the client gets them: no transport headers, as the body is re-framed. */
export const clientResponseHeaders = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!transportHeaderNames.has(name)) headers[name] = value;
  });
  return headers;
};
