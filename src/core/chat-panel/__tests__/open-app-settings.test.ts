import { describe, expect, it, vi } from "vitest";
import type { PanelHost } from "../../../platform/window-service";
import { openAppSettingsFor } from "../open-app-settings";

function host(settingsInPanel: boolean) {
  const openAppSettings = vi.fn();
  const posted: { target: PanelHost; message: unknown }[] = [];
  const platform = { capabilities: { settingsInPanel }, window: { openAppSettings } } as never;
  const post = (target: PanelHost, message: unknown): void => void posted.push({ target, message });
  return { platform, post, posted, openAppSettings };
}

const chat = { reveal: vi.fn() } as unknown as PanelHost;

describe("openAppSettingsFor", () => {
  it("opens the section in the chat's own panel, brought to the front, where settings live there", () => {
    const { platform, post, posted, openAppSettings } = host(true);
    openAppSettingsFor(platform, post, chat, "voice");
    expect(chat.reveal).toHaveBeenCalledOnce();
    expect(posted).toEqual([{ target: chat, message: { type: "openSettingsPanel", section: "voice" } }]);
    expect(openAppSettings).not.toHaveBeenCalled();
  });

  it("opens nothing in a panel for a chat that has closed", () => {
    const { platform, post, posted } = host(true);
    openAppSettingsFor(platform, post, undefined, "voice");
    expect(posted).toEqual([]);
  });

  it("opens the app's settings otherwise, whether or not the chat is open", () => {
    const { platform, post, posted, openAppSettings } = host(false);
    openAppSettingsFor(platform, post, undefined, "voice");
    openAppSettingsFor(platform, post, chat, "accounts", "openai");
    expect(openAppSettings.mock.calls).toEqual([["voice", undefined], ["accounts", "openai"]]);
    expect(posted).toEqual([]);
  });
});
