import * as vscode from "vscode";
import type {
  VoiceProvider,
  VoiceConfig,
  VoiceMode,
  GpuPreference,
  TtsVoiceId,
} from "../../../../shared/types/voice";
import { TTS_VOICE_IDS, DEFAULT_TTS_VOICE } from "../../../../shared/types/voice";
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
      mode: config.get<VoiceMode>("voice.mode", "push-to-talk"),
      wakeWord: config.get<string>("voice.wakeWord", "hey_jarvis"),
      wakeWordSensitivity: config.get<number>("voice.wakeWordSensitivity", 0.5),
      ttsEnabled: config.get<boolean>("voice.tts.enabled", false),
      ttsVoice: this.coerceVoice(config.get<string>("voice.tts.voice", DEFAULT_TTS_VOICE)),
      localGpu: config.get<GpuPreference>("voice.localGpu", "auto"),
      endOfTurnSilenceMs: config.get<number>("voice.endOfTurnSilenceMs", 800),
      maxUtteranceMs: config.get<number>("voice.maxUtteranceMs", 30000),
      autoSubmit: config.get<boolean>("voice.autoSubmit", true),
      diagnostics: config.get<boolean>("voice.diagnostics", false),
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

  async setMode(mode: VoiceMode): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "voice.mode", mode);
    log("[VoiceManager] setMode:", mode);
  }

  async setWakeWord(wakeWord: string): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "voice.wakeWord", wakeWord);
    log("[VoiceManager] setWakeWord:", wakeWord);
  }

  async setWakeWordSensitivity(sensitivity: number): Promise<void> {
    if (sensitivity < 0.1 || sensitivity > 0.95) {
      throw new Error(`wakeWordSensitivity out of range [0.1, 0.95]: ${sensitivity}`);
    }
    await updateConfigAtEffectiveScope("damocles", "voice.wakeWordSensitivity", sensitivity);
    log("[VoiceManager] setWakeWordSensitivity:", sensitivity);
  }

  async setTtsEnabled(enabled: boolean): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "voice.tts.enabled", enabled);
    log("[VoiceManager] setTtsEnabled:", enabled);
  }

  async setTtsVoice(voice: TtsVoiceId): Promise<void> {
    const safe = this.coerceVoice(voice);
    await updateConfigAtEffectiveScope("damocles", "voice.tts.voice", safe);
    log("[VoiceManager] setTtsVoice:", safe);
  }

  private coerceVoice(value: string): TtsVoiceId {
    return (TTS_VOICE_IDS as readonly string[]).includes(value)
      ? (value as TtsVoiceId)
      : DEFAULT_TTS_VOICE;
  }

  async setGpuPreference(pref: GpuPreference): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "voice.localGpu", pref);
    log("[VoiceManager] setGpuPreference:", pref);
  }

  async setEndOfTurnSilenceMs(ms: number): Promise<void> {
    if (!Number.isInteger(ms) || ms < 300 || ms > 3000) {
      throw new Error(`endOfTurnSilenceMs out of range [300, 3000]: ${ms}`);
    }
    await updateConfigAtEffectiveScope("damocles", "voice.endOfTurnSilenceMs", ms);
    log("[VoiceManager] setEndOfTurnSilenceMs:", ms);
  }

  async setMaxUtteranceMs(ms: number): Promise<void> {
    if (!Number.isInteger(ms) || ms < 5000 || ms > 120000) {
      throw new Error(`maxUtteranceMs out of range [5000, 120000]: ${ms}`);
    }
    await updateConfigAtEffectiveScope("damocles", "voice.maxUtteranceMs", ms);
    log("[VoiceManager] setMaxUtteranceMs:", ms);
  }

  async setAutoSubmit(autoSubmit: boolean): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "voice.autoSubmit", autoSubmit);
    log("[VoiceManager] setAutoSubmit:", autoSubmit);
  }

  async setDiagnostics(diagnostics: boolean): Promise<void> {
    await updateConfigAtEffectiveScope("damocles", "voice.diagnostics", diagnostics);
    log("[VoiceManager] setDiagnostics:", diagnostics);
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
    log(
      "[VoiceManager] sendVoiceConfig: provider:", config.provider,
      "language:", config.language,
      "mode:", config.mode,
      "hasApiKey:", hasKey,
    );
    this.postMessage(host, {
      type: "voiceConfigUpdate",
      config,
      hasApiKey: hasKey,
    });
  }
}
