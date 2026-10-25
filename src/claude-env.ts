/**
 * Where Claude Code looks for its API gateway, in order.
 * Copied from claude-code-router's `claudeCodeGatewayEnvKeys`:
 * {@link https://github.com/musistudio/claude-code-router/blob/057abaa1f95519ab8faf999e1ccef2b80ccdeb9e/packages/core/src/profiles/service.ts#L84-L88}
 */
export const CLAUDE_GATEWAY_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE_URL", "CLAUDE_AGENT_API_BASE_URL"] as const;

/** The gateway the caller's environment already points Claude Code at, if any. */
export const configuredGateway = (env: NodeJS.ProcessEnv): string | undefined =>
  CLAUDE_GATEWAY_ENV_KEYS.map((key) => env[key]?.trim()).find(Boolean);

/**
 * Copied from claude-code-router's `mergeNoProxyHosts`:
 * {@link https://github.com/musistudio/claude-code-router/blob/057abaa1f95519ab8faf999e1ccef2b80ccdeb9e/packages/core/src/profiles/service.ts#L2411-L2417}
 */
const mergeNoProxyHosts = (current: string | undefined, hosts: readonly string[]): string => {
  const values = [...(current ?? "").split(","), ...hosts].map((value) => value.trim()).filter(Boolean);
  return [...new Set(values)].join(",");
};

/** The proxy listens on loopback only. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * `env` with Claude Code pointed at the pclaude proxy: every gateway
 * variable it reads, and loopback exempted from any HTTP(S)_PROXY, which
 * would otherwise carry requests for the local proxy off the machine.
 * Adapted from claude-code-router's profile launch and `applyGatewayNoProxyEnv`:
 * {@link https://github.com/musistudio/claude-code-router/blob/057abaa1f95519ab8faf999e1ccef2b80ccdeb9e/packages/core/src/profiles/service.ts#L445-L448}
 * {@link https://github.com/musistudio/claude-code-router/blob/057abaa1f95519ab8faf999e1ccef2b80ccdeb9e/packages/core/src/profiles/service.ts#L2321-L2332}
 */
export const gatewayEnv = (env: NodeJS.ProcessEnv, gateway: string): NodeJS.ProcessEnv => ({
  ...env,
  ...Object.fromEntries(CLAUDE_GATEWAY_ENV_KEYS.map((key) => [key, gateway])),
  NO_PROXY: mergeNoProxyHosts(env["NO_PROXY"], LOOPBACK_HOSTS),
  no_proxy: mergeNoProxyHosts(env["no_proxy"], LOOPBACK_HOSTS),
});
