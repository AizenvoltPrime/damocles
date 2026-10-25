import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { buildAuthInteraction } from "../auth-interaction";
import { createFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";
import { log } from "../../../../logger";

function interactionFor(platform: FakePlatform) {
  return buildAuthInteraction({ signal: new AbortController().signal, cancelSentinel: "cancelled", logPrefix: "[test]", platform });
}

describe("buildAuthInteraction select prompts", () => {
  it("answers pi's Anthropic login method question with the browser login, whatever the option order", async () => {
    const platform = createFakePlatform();
    const interaction = interactionFor(platform);
    const options = [
      { id: "copy_code", label: "Copy code login (headless)" },
      { id: "browser", label: "Browser login (default)" },
    ];

    await expect(interaction.prompt({ type: "select", message: "Select Anthropic login method:", options })).resolves.toBe("browser");
    expect(platform.dialogs.inputBoxCalls).toHaveLength(0);
  });

  it("refuses any other choice instead of picking an option for the user", async () => {
    const platform = createFakePlatform();
    const interaction = interactionFor(platform);
    const options = [
      { id: "org-personal", label: "Personal" },
      { id: "org-work", label: "Work" },
    ];

    await expect(interaction.prompt({ type: "select", message: "Select an organization:", options })).rejects.toThrow(
      'Sign-in asked a question Damocles cannot answer: "Select an organization:"',
    );
    expect(platform.dialogs.inputBoxCalls).toHaveLength(0);
  });

  it("refuses a login method question with an option it does not know", async () => {
    const platform = createFakePlatform();
    const interaction = interactionFor(platform);
    const options = [
      { id: "browser", label: "Browser login (default)" },
      { id: "passkey", label: "Passkey" },
    ];

    await expect(interaction.prompt({ type: "select", message: "Select Anthropic login method:", options })).rejects.toThrow(/cannot answer/);
  });
});

describe("buildAuthInteraction defaults, as the Claude and ChatGPT sign-ins use them", () => {
  it("opens a sign-in page at once and shows a device code as a toast", () => {
    const platform = createFakePlatform();
    const interaction = interactionFor(platform);

    interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?x=1" });
    interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://example.com/device" });

    expect(platform.shell.openedExternal).toEqual(["https://claude.ai/oauth/authorize?x=1"]);
    expect(platform.notifications.calls.map((c) => c.message)).toEqual(["Enter code ABCD-EFGH at https://example.com/device to finish signing in."]);
  });

  it("logs only the type of progress and info, never pi's text, and asks a text prompt in the input box", async () => {
    const platform = createFakePlatform();
    platform.dialogs.answerInputBox(() => "typed");
    const interaction = interactionFor(platform);

    // OpenRouter's text names its loopback callback path (pi-ai openrouter.js:124)
    const callback = "http://localhost:3000/oauth/callback/0b7c5d1e-8f1a-4c39-9a51-2f6c1e3b7d40";
    interaction.notify({ type: "progress", message: `Listening for OpenRouter OAuth callback on ${callback}` });
    interaction.notify({ type: "info", message: "Note" });

    expect(vi.mocked(log)).toHaveBeenCalledWith("%s %s", "[test]", "progress");
    expect(vi.mocked(log)).toHaveBeenCalledWith("%s %s", "[test]", "info");
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("/oauth/callback/");
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain("Note");
    await expect(interaction.prompt({ type: "text", message: "Domain?" })).resolves.toBe("typed");
    expect(platform.dialogs.inputBoxCalls.map((c) => c.options.prompt)).toEqual(["Domain?"]);
  });
});

describe("buildAuthInteraction callbacks", () => {
  it("hands the device code, page URL, progress and text prompt to the caller instead of the host UI", async () => {
    const platform = createFakePlatform();
    const seen: string[] = [];
    const interaction = buildAuthInteraction({
      signal: new AbortController().signal,
      cancelSentinel: "cancelled",
      logPrefix: "[test]",
      platform,
      deviceCode: (e) => seen.push(`code ${e.userCode}`),
      authUrl: (e) => seen.push(`url ${e.url}`),
      progress: (e) => seen.push(`progress ${e.message}`),
      text: async (p) => `answer to ${p.message}`,
    });

    interaction.notify({ type: "device_code", userCode: "C1", verificationUri: "https://example.com/d" });
    interaction.notify({ type: "auth_url", url: "https://example.com/a" });
    interaction.notify({ type: "progress", message: "P" });

    expect(seen).toEqual(["code C1", "url https://example.com/a", "progress P"]);
    await expect(interaction.prompt({ type: "text", message: "Q" })).resolves.toBe("answer to Q");
    expect(platform.shell.openedExternal).toEqual([]);
    expect(platform.notifications.calls).toEqual([]);
    expect(platform.dialogs.inputBoxCalls).toEqual([]);
  });
});
