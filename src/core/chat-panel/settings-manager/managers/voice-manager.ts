import type { Platform } from "../../../../platform/platform";
import type {
  VoiceProvider,
  VoiceConfig,
  VoiceMode,
  GpuPreference,
  TtsVoiceId,
} from "../../../../shared/types/voice";
import { TTS_VOICE_IDS, DEFAULT_TTS_VOICE } from "../../../../shared/types/voice";
import type { PanelHost } from "../../../../platform/window-service";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope, type SettingWrite } from "../utils";
import { log } from "../../../logger";

const SECRET_PREFIX = "damocles.voice.apiKey:";

export class VoiceManager {
  private readonly postMessage: PostMessageFn;
  private readonly platform: Platform;

  constructor(postMessage: PostMessageFn, platform: Platform) {
    this.postMessage = postMessage;
    this.platform = platform;
  }

  getConfig(): VoiceConfig {
    const config = this.platform.settings;
    return {
      provider: config.get<VoiceProvider>("damocles.voice.provider", "openai-whisper"),
      language: config.get<string>("damocles.voice.language", "en"),
      mode: config.get<VoiceMode>("damocles.voice.mode", "push-to-talk"),
      wakeWord: config.get<string>("damocles.voice.wakeWord", "hey_jarvis"),
      wakeWordSensitivity: config.get<number>("damocles.voice.wakeWordSensitivity", 0.5),
      ttsEnabled: config.get<boolean>("damocles.voice.tts.enabled", false),
      ttsVoice: this.coerceVoice(config.get<string>("damocles.voice.tts.voice", DEFAULT_TTS_VOICE)),
      localGpu: config.get<GpuPreference>("damocles.voice.localGpu", "auto"),
      endOfTurnSilenceMs: config.get<number>("damocles.voice.endOfTurnSilenceMs", 800),
      maxUtteranceMs: config.get<number>("damocles.voice.maxUtteranceMs", 30000),
      autoSubmit: config.get<boolean>("damocles.voice.autoSubmit", true),
      diagnostics: config.get<boolean>("damocles.voice.diagnostics", false),
    };
  }

  async setProvider(provider: VoiceProvider): Promise<SettingWrite> {
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.provider", provider);
    log("[VoiceManager] setProvider:", provider);
    return written;
  }

  async setLanguage(language: string): Promise<SettingWrite> {
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.language", language);
    log("[VoiceManager] setLanguage:", language);
    return written;
  }

  async setMode(mode: VoiceMode): Promise<SettingWrite> {
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.mode", mode);
    log("[VoiceManager] setMode:", mode);
    return written;
  }

  async setWakeWord(wakeWord: string): Promise<SettingWrite> {
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.wakeWord", wakeWord);
    log("[VoiceManager] setWakeWord:", wakeWord);
    return written;
  }

  async setWakeWordSensitivity(sensitivity: number): Promise<SettingWrite> {
    if (sensitivity < 0.1 || sensitivity > 0.95) {
      throw new Error(`wakeWordSensitivity out of range [0.1, 0.95]: ${sensitivity}`);
    }
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.wakeWordSensitivity", sensitivity);
    log("[VoiceManager] setWakeWordSensitivity:", sensitivity);
    return written;
  }

  async setTtsEnabled(enabled: boolean): Promise<SettingWrite> {
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.tts.enabled", enabled);
    log("[VoiceManager] setTtsEnabled:", enabled);
    return written;
  }

  async setTtsVoice(voice: TtsVoiceId): Promise<SettingWrite> {
    const safe = this.coerceVoice(voice);
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.tts.voice", safe);
    log("[VoiceManager] setTtsVoice:", safe);
    return written;
  }

  private coerceVoice(value: string): TtsVoiceId {
    return (TTS_VOICE_IDS as readonly string[]).includes(value)
      ? (value as TtsVoiceId)
      : DEFAULT_TTS_VOICE;
  }

  async setGpuPreference(pref: GpuPreference): Promise<SettingWrite> {
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.localGpu", pref);
    log("[VoiceManager] setGpuPreference:", pref);
    return written;
  }

  async setEndOfTurnSilenceMs(ms: number): Promise<SettingWrite> {
    if (!Number.isInteger(ms) || ms < 300 || ms > 3000) {
      throw new Error(`endOfTurnSilenceMs out of range [300, 3000]: ${ms}`);
    }
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.endOfTurnSilenceMs", ms);
    log("[VoiceManager] setEndOfTurnSilenceMs:", ms);
    return written;
  }

  async setMaxUtteranceMs(ms: number): Promise<SettingWrite> {
    if (!Number.isInteger(ms) || ms < 5000 || ms > 120000) {
      throw new Error(`maxUtteranceMs out of range [5000, 120000]: ${ms}`);
    }
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.maxUtteranceMs", ms);
    log("[VoiceManager] setMaxUtteranceMs:", ms);
    return written;
  }

  async setAutoSubmit(autoSubmit: boolean): Promise<SettingWrite> {
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.autoSubmit", autoSubmit);
    log("[VoiceManager] setAutoSubmit:", autoSubmit);
    return written;
  }

  async setDiagnostics(diagnostics: boolean): Promise<SettingWrite> {
    const written = await updateConfigAtEffectiveScope(this.platform, "damocles.voice.diagnostics", diagnostics);
    log("[VoiceManager] setDiagnostics:", diagnostics);
    return written;
  }

  async storeApiKey(provider: VoiceProvider, apiKey: string): Promise<void> {
    await this.platform.secrets.store(SECRET_PREFIX + provider, apiKey);
    log("[VoiceManager] storeApiKey for:", provider);
  }

  async deleteApiKey(provider: VoiceProvider): Promise<void> {
    await this.platform.secrets.delete(SECRET_PREFIX + provider);
    log("[VoiceManager] deleteApiKey for:", provider);
  }

  async getApiKey(provider: VoiceProvider): Promise<string | undefined> {
    return this.platform.secrets.get(SECRET_PREFIX + provider);
  }

  async hasApiKey(provider: VoiceProvider): Promise<boolean> {
    const key = await this.platform.secrets.get(SECRET_PREFIX + provider);
    return key !== undefined && key.length > 0;
  }

  async sendVoiceConfig(host: PanelHost): Promise<void> {
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
