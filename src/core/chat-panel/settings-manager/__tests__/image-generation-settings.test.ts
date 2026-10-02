import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { readContributedConfiguration } from "../../../config/contributed-configuration";

const runtime = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../../pi-session/pi-runtime", () => ({
  PiRuntime: {
    get exists() { return runtime.current !== null; },
    get: () => ({ modelRuntime: runtime.current }),
  },
}));

import { SettingsManager } from "..";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import type { PanelHost } from "../../../../platform/window-service";

function imageModel(id: string, input: number, output: number): ImageModel<ImageApi> {
  return { id, name: `${id} name`, provider: "openrouter", api: "openrouter-images", type: "image", output: ["image"], cost: { input, output, cacheRead: 0, cacheWrite: 0 } } as unknown as ImageModel<ImageApi>;
}

const CATALOG = [imageModel("google/gemini-image", 0.3, 30), imageModel("openrouter/auto", -1_000_000, -1_000_000), imageModel("black-forest-labs/flux", 0, 0), imageModel("microsoft/mai-image-2.5", 5, 0)];

function manager(init: Parameters<typeof installFakePlatform>[0] = {}) {
  const platform = installFakePlatform(init);
  const posted: ExtensionToWebviewMessage[] = [];
  const settings = new SettingsManager({ postMessage: (_host, message) => posted.push(message), platform, folders: () => [] });
  return { platform, settings, posted };
}

const host = {} as PanelHost;

describe("image generation settings", () => {
  it("lists only token-priced catalog models, with the setting values and pi's OpenRouter auth", () => {
    runtime.current = { getModelsOfType: () => CATALOG, hasConfiguredAuth: (provider: string) => provider === "openrouter" };
    const { settings, posted } = manager({ settings: { user: { "damocles.imageGeneration.enabled": true, "damocles.imageGeneration.model": "google/gemini-image" } } });

    settings.sendImageGenerationSettings(host);

    expect(posted).toEqual([{
      type: "imageGenerationSettings",
      settings: {
        enabled: true,
        model: "google/gemini-image",
        imageModels: [{ id: "google/gemini-image", name: "google/gemini-image name" }],
        openRouterConfigured: true,
      },
    }]);
  });

  it("posts nothing before pi's runtime exists", () => {
    runtime.current = null;
    const { settings, posted } = manager();
    settings.sendImageGenerationSettings(host);
    expect(posted).toEqual([]);
  });

  it("writes the enabled switch at user scope, from settings and from the Tools panel, even when a project value exists", async () => {
    const { platform, settings } = manager({ settings: { project: { "damocles.imageGeneration.enabled": false } } });

    await settings.setImageGenerationEnabled(true);
    expect(platform.settings.inspect("damocles.imageGeneration.enabled")).toMatchObject({ userValue: true, projectValue: false });

    await settings.setToolGroupEnabled("image", false);
    expect(platform.settings.inspect("damocles.imageGeneration.enabled")).toMatchObject({ userValue: false, projectValue: false });
  });

  it("keeps the model user-only on both hosts, so a repository cannot choose what is billed", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    };
    expect(manifest.contributes.configuration.properties["damocles.imageGeneration.model"]?.scope).toBe("application");
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain("damocles.imageGeneration.model");
    expect(readContributedConfiguration(process.cwd()).userOnlyKeys).toContain("damocles.imageGeneration.model");
  });

  it("writes the model at user scope even when a project value exists, since it decides the spend", async () => {
    const { platform, settings } = manager({ settings: { project: { "damocles.imageGeneration.model": "openai/gpt-image-1" } } });

    await settings.setImageGenerationModel("google/gemini-image");
    expect(platform.settings.inspect("damocles.imageGeneration.model")).toMatchObject({ userValue: "google/gemini-image", projectValue: "openai/gpt-image-1" });
  });
});
