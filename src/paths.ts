import { join } from "node:path";
import envPaths from "env-paths";

/** Per-OS locations of pclaude's files. */
export interface PolyglotPaths {
  readonly configDir: string;
  readonly logFile: string;
  readonly statsFile: string;
}

/** `PCLAUDE_HOME` puts everything under one directory (tests, portable setups); otherwise the OS conventions apply. */
export const resolvePaths = (env: NodeJS.ProcessEnv = process.env): PolyglotPaths => {
  const home = env["PCLAUDE_HOME"];
  const dirs = home
    ? { config: home, log: home, data: home }
    : envPaths("pclaude", { suffix: "" });
  return {
    configDir: dirs.config,
    logFile: join(dirs.log, "pclaude.log"),
    statsFile: join(dirs.data, "stats.db"),
  };
};
