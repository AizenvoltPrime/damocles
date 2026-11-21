// A permission rules file's read and its notices, shared by core's evaluator and main's relay of this computer's user
// rules to remote chats (docs/invariants.md "Permissions and plan mode").
import * as fs from "fs";
import { checkConfigPath } from "../config/local-config-path";
import { isMissing } from "../local-links";
import { l } from "../l10n";
import type { LocalizedText } from "../../shared/localized-text";

/** A rules file's text; or that it, or a folder on its path, is missing; or why it could not be checked or read. */
export type RuleFileText = { readonly text: string } | { readonly missing: true } | { readonly unreadable: LocalizedText };

export async function readRuleFileText(filePath: string, baseFolder: string): Promise<RuleFileText> {
  try {
    if ((await checkConfigPath(baseFolder, filePath)) !== "ok") return { unreadable: l("it links to a network share or WSL path") };
    return { text: await fs.promises.readFile(filePath, "utf-8") };
  } catch (err) {
    if (isMissing(err)) return { missing: true };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return { unreadable: l("its drive did not answer") };
    if (code === "ELOOP") return { unreadable: l("a link on its path loops") };
    return { unreadable: code === undefined ? l("an unknown error") : l("error {0}", code) };
  }
}

/** Why a call is blocked, and the notice, while a rules file that was never read cannot be read. */
export function unreadableRulesText(file: string, reason: LocalizedText): LocalizedText {
  return l("The permission rules in {0} could not be read ({1}) and were not read before, so Damocles blocks every tool call that settings rules decide until it can read them. Make the drive or file reachable; a link on its path that loops or leads onto a network share must be fixed.", file, reason);
}

/** The notice when a rules file that was read before starts failing. */
export function keptRulesText(file: string, reason: LocalizedText): LocalizedText {
  return l("The permission rules in {0} could not be read ({1}), so Damocles keeps the rules it last read from it. Make the drive or file reachable; a link on its path that loops or leads onto a network share must be fixed.", file, reason);
}
