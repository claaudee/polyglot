import Conf, { type Schema } from "conf";
import { resolvePaths } from "./paths.js";
import type { Scopes } from "./text/scopes.js";

/**
 * There is no language setting: the translator detects the language of each
 * prompt, the model always works in English, and every reply goes back in
 * the language it was asked in. There is no translator model either: each
 * translation is asked inside the conversation, of the model it talks to.
 */
export interface Settings {
  readonly enabled: boolean;
  readonly chunkTokens: number;
  readonly concurrency: number;
  readonly scopes: Partial<Scopes>;
}

export type ConfigStore = Conf<Settings>;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  chunkTokens: 2000,
  concurrency: 4,
  scopes: {},
};

/** Validates hand edits of `config.json`: a bad value fails loudly instead of silently misbehaving. */
const SCHEMA: Schema<Settings> = {
  enabled: { type: "boolean" },
  chunkTokens: { type: "integer", minimum: 100 },
  concurrency: { type: "integer", minimum: 1, maximum: 32 },
  scopes: {
    type: "object",
    properties: { user: { type: "boolean" }, assistant: { type: "boolean" } },
    additionalProperties: false,
  },
};

/**
 * The one config source for the CLI, the GUI and the proxy. Without
 * `cache`, every read goes to `config.json`, so hand edits and
 * `pclaude disable` apply to the running proxy without a restart.
 */
export const openConfig = (env: NodeJS.ProcessEnv = process.env): ConfigStore =>
  new Conf<Settings>({ cwd: resolvePaths(env).configDir, schema: SCHEMA, defaults: DEFAULT_SETTINGS });

export const isActive = (store: ConfigStore): boolean => store.get("enabled");
