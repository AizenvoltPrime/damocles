import * as vscode from "vscode";
import type { VoiceProvider, VoiceConfig } from "../../../../shared/types/voice";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope } from "../utils";
import { log } from "../../../logger";

const SECRET_PREFIX = "damocles.voice.apiKey:";

export class VoiceManager {
  private readonly postMessage: PostMessageFn;
  private readonly secrets: vscode.SecretStorage;

  constructor(postMessage: PostMessageFn, secrets: vscode.SecretStorage) {
    this.postMessage = postMessage;
    this.secrets = secrets;
  }

  getConfig(): VoiceConfig {
    const config = vscode.workspace.getConfiguration("damocles");
    return {
      provider: config.get<VoiceProvider>("voice.provider", "openai-whisper"),
      language: config.get<string>("voice.language", "en"),
    };
  }

  async setProvider(provider: VoiceProvider): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "voice.provider", provider);
    log("[VoiceManager] setProvider:", provider);
  }

  async setLanguage(language: string): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "voice.language", language);
    log("[VoiceManager] setLanguage:", language);
  }

  async storeApiKey(provider: VoiceProvider, apiKey: string): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + provider, apiKey);
    log("[VoiceManager] storeApiKey for:", provider);
  }

  async deleteApiKey(provider: VoiceProvider): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + provider);
    log("[VoiceManager] deleteApiKey for:", provider);
  }

  async getApiKey(provider: VoiceProvider): Promise<string | undefined> {
    return this.secrets.get(SECRET_PREFIX + provider);
  }

  async hasApiKey(provider: VoiceProvider): Promise<boolean> {
    const key = await this.secrets.get(SECRET_PREFIX + provider);
    return key !== undefined && key.length > 0;
  }

  async sendVoiceConfig(host: WebviewHost): Promise<void> {
    const config = this.getConfig();
    const hasKey = await this.hasApiKey(config.provider);
    log("[VoiceManager] sendVoiceConfig: provider:", config.provider, "language:", config.language, "hasApiKey:", hasKey);
    this.postMessage(host, {
      type: "voiceConfigUpdate",
      config,
      hasApiKey: hasKey,
    });
  }
}
