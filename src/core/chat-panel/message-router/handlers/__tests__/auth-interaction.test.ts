import { describe, expect, it } from "vitest";
import { buildAuthInteraction } from "../auth-interaction";
import { createFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";

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
