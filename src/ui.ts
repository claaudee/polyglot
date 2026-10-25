import { cancel, confirm, group, intro, outro, select, text } from "@clack/prompts";
import pc from "picocolors";
import { EFFORTS, isActive, type ConfigStore } from "./config.js";
import { MODEL_LANGUAGE, resolveLanguage } from "./languages.js";

const modelLanguage = resolveLanguage(MODEL_LANGUAGE)?.name ?? MODEL_LANGUAGE;

const positiveInteger =
  (min: number) =>
  (value: string | undefined): string | undefined =>
    Number.isInteger(Number(value)) && Number(value) >= min ? undefined : `a whole number ≥ ${min}`;

/** Interactive editor over the same `config.json` the proxy reads; Esc leaves it unchanged. */
export const configWizard = async (store: ConfigStore): Promise<void> => {
  intro(pc.bold("pclaude settings"));
  const answers = await group(
    {
      enabled: () => confirm({ message: "Translate prompts and replies?", initialValue: store.get("enabled") }),
      model: () =>
        text({
          message: "Translator model",
          initialValue: store.get("model"),
          validate: (value) => (value?.trim() ? undefined : "required"),
        }),
      effort: () =>
        select({
          message: "Translator effort",
          options: EFFORTS.map((effort) => ({ value: effort })),
          initialValue: store.get("effort"),
        }),
      chunkTokens: () =>
        text({ message: "Tokens per translation chunk", initialValue: String(store.get("chunkTokens")), validate: positiveInteger(100) }),
      concurrency: () =>
        text({ message: "Chunks translated in parallel", initialValue: String(store.get("concurrency")), validate: positiveInteger(1) }),
    },
    {
      onCancel: () => {
        cancel("Nothing changed.");
        process.exit(0);
      },
    }
  );

  store.set({
    ...store.store,
    ...answers,
    model: answers.model.trim(),
    chunkTokens: Number(answers.chunkTokens),
    concurrency: Number(answers.concurrency),
  });
  outro(`Saved to ${pc.cyan(store.path)}`);
};

/** One-line status after `enable` / `disable`. */
export const printStatus = (store: ConfigStore): void =>
  console.log(
    isActive(store)
      ? `${pc.green("●")} translation on: the language you write in ⇄ ${modelLanguage} via ${store.get("model")}`
      : `${pc.dim("○")} translation off: claude talks to the API directly through pclaude`
  );
