import { constants } from "node:os";
import { execa, ExecaError } from "execa";
import pc from "picocolors";
import { gatewayEnv } from "./claude-env.js";
import { resolvePaths } from "./paths.js";
import { startProxy } from "./proxy/server.js";

export interface LaunchOptions {
  /** Passed to `claude` untouched. */
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly command?: string;
}

/** Signals a terminal does not deliver to the whole process group, so `claude` only sees them if we forward them. */
const FORWARDED = ["SIGTERM", "SIGHUP"] as const;

/**
 * The main model must think and answer in English — that is where the
 * tokens are saved; pclaude translates the answer back. Claude Code's own
 * `language` setting would make it answer in the user's language instead,
 * so `--settings` (which outranks user and project settings) pins it for
 * this session only. It goes first so it stays a root option ahead of any
 * subcommand or `--`.
 */
export const claudeArgs = (args: readonly string[]): readonly string[] => [
  "--settings",
  JSON.stringify({ language: "English" }),
  ...args,
];

const exitCodeOf =(result: { readonly exitCode?: number; readonly signal?: keyof typeof constants.signals }): number =>
  result.exitCode ?? (result.signal ? 128 + constants.signals[result.signal] : 1);

/**
 * `pclaude` = proxy + `claude` pointed at it. The proxy reads the caller's
 * gateway variables as its upstream before `claude` gets ours, so
 * existing gateways stay in the chain. Resolves to `claude`'s exit code.
 */
export const launch = async ({ args, env = process.env, command = "claude" }: LaunchOptions): Promise<number> => {
  const proxy = await startProxy({ paths: resolvePaths(env), env });

  // Ctrl+C reaches both processes from the terminal; it is claude's to handle, not ours.
  const ignore = (): void => {};
  process.on("SIGINT", ignore);
  try {
    const subprocess = execa(command, args, {
      stdio: "inherit",
      reject: false,
      extendEnv: false,
      env: gatewayEnv(env, proxy.url),
    });
    const forward = (signal: NodeJS.Signals): void => void subprocess.kill(signal);
    FORWARDED.forEach((signal) => process.on(signal, forward));

    const result = await subprocess.finally(() => FORWARDED.forEach((signal) => process.off(signal, forward)));
    if (result instanceof ExecaError && result.exitCode === undefined && !result.signal) {
      console.error(pc.red(`pclaude: ${result.shortMessage}`));
      return 127;
    }
    return exitCodeOf(result);
  } finally {
    process.off("SIGINT", ignore);
    await proxy.close();
  }
};
