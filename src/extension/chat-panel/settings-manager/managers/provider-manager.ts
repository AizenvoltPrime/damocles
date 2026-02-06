import * as vscode from "vscode";
import type { ProviderProfile } from "../../../../shared/types/settings";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import { updateConfigAtEffectiveScope } from "../utils";
import { log } from "../../../logger";

export class ProviderManager {
  private static readonly PROFILE_SECRET_PREFIX = "damocles.profile:";

  private profiles: ProviderProfile[] = [];
  private activeProfile: string | null = null;
  private perPanelActiveProfile: Map<string, string | null> = new Map();
  private profilesLoaded = false;
  private readonly postMessage: PostMessageFn;
  private readonly secrets: vscode.SecretStorage;

  constructor(postMessage: PostMessageFn, secrets: vscode.SecretStorage) {
    this.postMessage = postMessage;
    this.secrets = secrets;
  }

  async loadProfiles(): Promise<void> {
    if (this.profilesLoaded) {
      return;
    }

    const config = vscode.workspace.getConfiguration("damocles");
    const storedProfiles = config.get<ProviderProfile[]>("providerProfiles", []);
    this.activeProfile = config.get<string | null>("activeProviderProfile", null);

    this.profiles = await Promise.all(
      storedProfiles.map(async (profile) => {
        const secretKey = ProviderManager.PROFILE_SECRET_PREFIX + profile.name;
        const envJson = await this.secrets.get(secretKey);
        const env = envJson ? JSON.parse(envJson) as Record<string, string> : profile.env || {};
        return { name: profile.name, env };
      })
    );

    this.profilesLoaded = true;
  }

  async createProfile(profile: ProviderProfile): Promise<void> {
    if (this.profiles.some(p => p.name === profile.name)) {
      throw new Error(`Profile "${profile.name}" already exists`);
    }

    const secretKey = ProviderManager.PROFILE_SECRET_PREFIX + profile.name;
    await this.secrets.store(secretKey, JSON.stringify(profile.env));

    this.profiles = [...this.profiles, profile];
    const profileNames = this.profiles.map(p => ({ name: p.name }));
    await updateConfigAtEffectiveScope("damocles", "providerProfiles", profileNames);
    log("[ProviderManager] createProfile:", profile.name);
  }

  async updateProfile(originalName: string, profile: ProviderProfile): Promise<boolean> {
    const index = this.profiles.findIndex(p => p.name === originalName);
    if (index === -1) {
      throw new Error(`Profile "${originalName}" not found`);
    }

    if (originalName !== profile.name && this.profiles.some(p => p.name === profile.name)) {
      throw new Error(`Profile "${profile.name}" already exists`);
    }

    const oldSecretKey = ProviderManager.PROFILE_SECRET_PREFIX + originalName;
    const newSecretKey = ProviderManager.PROFILE_SECRET_PREFIX + profile.name;

    if (originalName !== profile.name) {
      await this.secrets.delete(oldSecretKey);
    }
    await this.secrets.store(newSecretKey, JSON.stringify(profile.env));

    this.profiles = [
      ...this.profiles.slice(0, index),
      profile,
      ...this.profiles.slice(index + 1),
    ];
    const profileNames = this.profiles.map(p => ({ name: p.name }));
    await updateConfigAtEffectiveScope("damocles", "providerProfiles", profileNames);

    const needsRestart = this.activeProfile === originalName;
    if (needsRestart) {
      this.activeProfile = profile.name;
      await updateConfigAtEffectiveScope("damocles", "activeProviderProfile", profile.name);
    }

    log("[ProviderManager] updateProfile:", originalName, "->", profile.name);
    return needsRestart;
  }

  async deleteProfile(profileName: string): Promise<boolean> {
    const profile = this.profiles.find(p => p.name === profileName);
    if (!profile) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    const secretKey = ProviderManager.PROFILE_SECRET_PREFIX + profileName;
    await this.secrets.delete(secretKey);

    this.profiles = this.profiles.filter(p => p.name !== profileName);
    const profileNames = this.profiles.map(p => ({ name: p.name }));
    await updateConfigAtEffectiveScope("damocles", "providerProfiles", profileNames);

    const needsRestart = this.activeProfile === profileName;
    if (needsRestart) {
      this.activeProfile = null;
      await updateConfigAtEffectiveScope("damocles", "activeProviderProfile", null);
    }

    log("[ProviderManager] deleteProfile:", profileName);
    return needsRestart;
  }

  async setActiveProfile(profileName: string | null): Promise<boolean> {
    if (profileName === this.activeProfile) {
      return false;
    }

    if (profileName !== null) {
      const profile = this.profiles.find(p => p.name === profileName);
      if (!profile) {
        throw new Error(`Profile "${profileName}" not found`);
      }
    }

    this.activeProfile = profileName;
    await updateConfigAtEffectiveScope("damocles", "activeProviderProfile", profileName);
    log("[ProviderManager] setActiveProfile:", profileName);
    return true;
  }

  getActiveEnv(): Record<string, string> | undefined {
    if (!this.activeProfile) {
      return undefined;
    }
    const profile = this.profiles.find(p => p.name === this.activeProfile);
    return profile?.env;
  }

  initPanelProfile(panelId: string): void {
    this.perPanelActiveProfile.set(panelId, this.activeProfile);
  }

  cleanupPanelProfile(panelId: string): void {
    this.perPanelActiveProfile.delete(panelId);
  }

  getActiveProfileForPanel(panelId: string): string | null {
    return this.perPanelActiveProfile.get(panelId) ?? this.activeProfile;
  }

  setActiveProfileForPanel(panelId: string, profileName: string | null): boolean {
    const currentProfile = this.perPanelActiveProfile.get(panelId) ?? this.activeProfile;
    if (profileName === currentProfile) {
      return false;
    }

    if (profileName !== null) {
      const profile = this.profiles.find(p => p.name === profileName);
      if (!profile) {
        throw new Error(`Profile "${profileName}" not found`);
      }
    }

    this.perPanelActiveProfile.set(panelId, profileName);
    return true;
  }

  getActiveEnvForPanel(panelId: string): Record<string, string> | undefined {
    const profileName = this.perPanelActiveProfile.has(panelId)
      ? this.perPanelActiveProfile.get(panelId)
      : this.activeProfile;
    if (!profileName) {
      return undefined;
    }
    const profile = this.profiles.find(p => p.name === profileName);
    return profile?.env;
  }

  sendProfilesForPanel(host: WebviewHost, panelId: string): void {
    const activeProfileForPanel = this.perPanelActiveProfile.has(panelId)
      ? this.perPanelActiveProfile.get(panelId)!
      : this.activeProfile;
    this.postMessage(host, {
      type: "providerProfilesUpdate",
      profiles: this.profiles,
      activeProfile: activeProfileForPanel,
      defaultProfile: this.activeProfile,
    });
  }

  async setDefaultProfile(profileName: string | null): Promise<void> {
    if (profileName !== null) {
      const profile = this.profiles.find(p => p.name === profileName);
      if (!profile) {
        throw new Error(`Profile "${profileName}" not found`);
      }
    }

    this.activeProfile = profileName;
    await updateConfigAtEffectiveScope("damocles", "activeProviderProfile", profileName);
    log("[ProviderManager] setDefaultProfile:", profileName);
  }
}
