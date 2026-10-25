import type { ConfigStore } from "../config.js";
import { AgentEngine } from "./agent-engine.js";
import type { TranslationEngine } from "./engine.js";

export interface EngineContext {
  /** The proxy's upstream: where the translator's own Claude Code sends requests. */
  readonly baseURL: string;
}

/** The translator always runs on the user's Claude subscription via the Agent SDK; there is no direct API path. */
export const createEngine = (store: ConfigStore, env: NodeJS.ProcessEnv, context: EngineContext): TranslationEngine =>
  new AgentEngine({ model: store.get("model"), effort: store.get("effort"), baseURL: context.baseURL, env });
