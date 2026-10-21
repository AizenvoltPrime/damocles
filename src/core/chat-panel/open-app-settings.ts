import type { Platform } from "../../platform/platform";
import type { PanelHost } from "../../platform/window-service";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { SettingsAccountId, SettingsSectionId } from "../../shared/settings-sections";

/**
 * Opens the settings for the chat on `host`: in its panel, brought to the front, where the host keeps them there
 * (`settingsInPanel`), else the app's. Under `settingsInPanel` a caller whose chat has closed passes another panel's host;
 * with none (`host` undefined) there is nowhere to show them.
 */
export function openAppSettingsFor(
  platform: Pick<Platform, "capabilities" | "window">,
  postMessage: (host: PanelHost, message: ExtensionToWebviewMessage) => void,
  host: PanelHost | undefined,
  section?: SettingsSectionId,
  account?: SettingsAccountId,
): void {
  if (!platform.capabilities.settingsInPanel) {
    platform.window.openAppSettings(section, account);
    return;
  }
  if (host === undefined) return;
  // A retained panel in a background tab would open the settings out of sight.
  host.reveal();
  postMessage(host, {
    type: "openSettingsPanel",
    ...(section !== undefined ? { section } : {}),
    ...(account !== undefined ? { account } : {}),
  });
}
