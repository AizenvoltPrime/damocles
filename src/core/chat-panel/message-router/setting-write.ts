import type { HandlerContext, HandlerDependencies, PostMessageFn } from "./types";
import type { PanelHost } from "../../../platform/window-service";
import type { SettingsFileScope } from "../../../shared/types/messages";
import { CHAT_SETTING_KEYS } from "../../config/chat-settings";
import { settingsFolderOf } from "../../workspace-folders/folder-registry";
import { effectiveScope, type SettingWrite } from "../settings-manager/utils";
import { settingsViewWriteScope } from "../settings-view-scope";
import { log } from "../../logger";
import { errorTextOf } from "../../l10n";
import type { LocalizedText } from "../../../shared/localized-text";

/** Where a successful write landed, as `settingWriteResult` names it: the scope, and its file where the host keeps one. */
export interface SettingWriteLanding {
  readonly scope: SettingsFileScope;
  readonly file?: string;
}

/**
 * Runs `write` and reports it to `reply` under `key`, the row's key, as `settingWriteResult` (M7). On success the result
 * carries what `landed` says of the write; on failure the reason, which the asking view also shows as a notification
 * worded by `failure`. Resolves whether the write succeeded.
 */
export async function reportSettingWrite(
  postMessage: PostMessageFn,
  reply: PanelHost,
  key: string,
  failure: (detail: LocalizedText) => LocalizedText,
  write: () => Promise<SettingWrite>,
  landed: (written: SettingWrite) => SettingWriteLanding,
): Promise<boolean> {
  let written: SettingWrite;
  try {
    written = await write();
  } catch (err) {
    const detail = errorTextOf(err);
    log("[MessageRouter] Error saving %s: %s", key, err instanceof Error ? err.message : String(err));
    postMessage(reply, { type: "notification", message: failure(detail), notificationType: "error" });
    postMessage(reply, { type: "settingWriteResult", key, ok: false, error: detail });
    return false;
  }
  const { scope, file } = landed(written);
  postMessage(reply, { type: "settingWriteResult", key, ok: true, scope, ...(file !== undefined ? { file } : {}) });
  return true;
}

/**
 * Runs one settings write for the panel and reports it through `reportSettingWrite`. On success the result names the
 * scope and file the value the setter wrote now comes from, which is where the write landed (D37), or the setter's home
 * scope and no file when the write left that key at its default.
 */
export async function writeSetting(
  deps: Pick<HandlerDependencies, "postMessage" | "platform">,
  ctx: Pick<HandlerContext, "reply" | "folder">,
  key: string,
  failure: (detail: LocalizedText) => LocalizedText,
  write: () => Promise<SettingWrite>,
): Promise<boolean> {
  const { postMessage, platform } = deps;
  return reportSettingWrite(postMessage, ctx.reply, key, failure, write, (written) => {
    const folder = CHAT_SETTING_KEYS.has(written.key) ? settingsFolderOf(ctx.folder) : undefined;
    // a scope tab's write landed in that tab's file, whichever file the value comes from now
    const scope = settingsViewWriteScope(folder !== undefined) ?? effectiveScope(platform, written.key, folder);
    const file = scope === undefined ? undefined : platform.settings.scopeFile(scope, folder);
    return { scope: scope ?? written.home, ...(file !== undefined ? { file } : {}) };
  });
}
