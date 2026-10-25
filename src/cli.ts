#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { openConfig } from "./config.js";
import { claudeArgs, launch } from "./launcher.js";
import { configWizard, printStatus } from "./ui.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly version: string;
};

const setEnabled = (enabled: boolean) => (): void => {
  const store = openConfig();
  store.set("enabled", enabled);
  printStatus(store);
};

const program = new Command("pclaude")
  .description("Claude Code in your language: prompts go to the model in English, replies come back translated.")
  .version(version)
  .enablePositionalOptions()
  .passThroughOptions()
  .allowUnknownOption()
  .allowExcessArguments()
  .argument("[claude-args...]", "passed to claude as-is (use -- before claude's own --help/--version)")
  .action(async (args: string[]) => {
    process.exitCode = await launch({ args: claudeArgs(args) });
  });

const config = program
  .command("config")
  .description("edit settings interactively")
  .action(() => configWizard(openConfig()));

config
  .command("path")
  .description("print the config.json path (safe to edit by hand)")
  .action(() => console.log(openConfig().path));

program.command("enable").description("turn translation on (applies to running sessions)").action(setEnabled(true));
program.command("disable").description("turn translation off (applies to running sessions)").action(setEnabled(false));

await program.parseAsync();
