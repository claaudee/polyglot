import { cancel, confirm, intro, isCancel, outro } from "@clack/prompts";
import pc from "picocolors";
import { isActive, type ConfigStore } from "./config.js";
import { MODEL_LANGUAGE, resolveLanguage } from "./languages.js";

const modelLanguage = resolveLanguage(MODEL_LANGUAGE)?.name ?? MODEL_LANGUAGE;

/** Interactive editor over the same `config.json` the proxy reads; Esc leaves it unchanged. */
export const configWizard = async (store: ConfigStore): Promise<void> => {
  intro(pc.bold("pclaude settings"));
  const enabled = await confirm({ message: "Translate prompts and replies?", initialValue: store.get("enabled") });
  if (isCancel(enabled)) {
    cancel("Nothing changed.");
    process.exit(0);
  }
  store.set("enabled", enabled);
  outro(`Saved to ${pc.cyan(store.path)}`);
};

/** One-line status after `enable` / `disable`. */
export const printStatus = (store: ConfigStore): void =>
  console.log(
    isActive(store)
      ? `${pc.green("●")} translation on: the language you write in ⇄ ${modelLanguage}, asked of the session's own model`
      : `${pc.dim("○")} translation off: claude talks to the API directly through pclaude`
  );
