import pino, { type Logger } from "pino";
import { resolvePaths } from "./paths.js";

let logger: Logger | undefined;

/** File logger, opened on first use; never writes to the terminal Claude Code owns. */
export const log = (): Logger => {
  logger ??= pino(
    { level: process.env["PCLAUDE_LOG_LEVEL"] ?? "info" },
    pino.destination({ dest: resolvePaths().logFile, mkdir: true, sync: false })
  );
  return logger;
};

/** Records a swallowed (fail-open) error under a scope. Logging itself must never throw. */
export const debugLog = (scope: string, error: unknown): void => {
  try {
    log().warn({ scope, err: error }, typeof error === "string" ? error : "fail-open");
  } catch {
    // nowhere left to report to
  }
};
