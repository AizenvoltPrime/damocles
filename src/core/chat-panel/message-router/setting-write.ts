import type { HandlerContext, HandlerDependencies } from "./types";
import { CHAT_SETTING_KEYS } from "../../config/chat-settings";
import { settingsFolderOf } from "../../workspace-folders/folder-registry";
import { effectiveScope, type SettingWrite } from "../settings-manager/utils";
import { log } from "../../logger";

/**
 * Runs one settings write for the panel and reports it under `key`, the row's key, as `settingWriteResult` (M7). On
 * success the result names the scope and file the value the setter wrote now comes from, which is where the write landed
 * (D37), or the setter's home scope and no file when the write left that key at its default; on failure the reason,
 * which the chat also shows as a notification. Resolves whether the write succeeded.
 */
export async function writeSetting(
  deps: Pick<HandlerDependencies, "postMessage" | "platform">,
  ctx: HandlerContext,
  key: string,
  failure: (detail: string) => string,
  write: () => Promise<SettingWrite>,
): Promise<boolean> {
  const { postMessage, platform } = deps;
  let written: SettingWrite;
  try {
    written = await write();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    log("[MessageRouter] Error saving %s: %s", key, detail);
    postMessage(ctx.host, { type: "notification", message: failure(detail), notificationType: "error" });
    postMessage(ctx.host, { type: "settingWriteResult", key, ok: false, error: detail });
    return false;
  }
  const folder = CHAT_SETTING_KEYS.has(written.key) ? settingsFolderOf(ctx.folder) : undefined;
  const scope = effectiveScope(platform, written.key, folder);
  const file = scope === undefined ? undefined : platform.settings.scopeFile(scope, folder);
  postMessage(ctx.host, { type: "settingWriteResult", key, ok: true, scope: scope ?? written.home, ...(file !== undefined ? { file } : {}) });
  return true;
}
