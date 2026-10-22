import type { Platform } from "../../../../platform/platform";
import { readExploreSetting } from "../../../pi-session/subagents/cheap-model";
import { EXPLORE_EFFORT_SETTING, EXPLORE_MODEL_SETTING } from "../../../../shared/explore-settings";
import { assertEffortSupported, type SettingWrite } from "../utils";
import { DEFAULT_MODELS, supportedStoredEffort } from "../../../../shared/types/constants";
import type { EffortLevel } from "../../../../shared/types/settings";
import { log } from "../../../logger";
import { t } from "../../../l10n";

export class ExploreManager {
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  /** Explore is read with no folder, so its settings are user-level only (application scope). */
  async setModel(model: string): Promise<SettingWrite> {
    if (model !== "" && !DEFAULT_MODELS.some((m) => m.value === model)) throw new Error(t("Model \"{0}\" is not a known model", model));
    const config = this.platform.settings;
    await config.update(EXPLORE_MODEL_SETTING, model === "" ? undefined : model, "user");
    // Default takes no effort, and a picked model keeps only one it supports.
    const storedEffort = config.get<string>(EXPLORE_EFFORT_SETTING, "");
    if (storedEffort !== "" && supportedStoredEffort(model, storedEffort) === null) {
      await config.update(EXPLORE_EFFORT_SETTING, undefined, "user");
    }
    log("[ExploreManager] setModel: %s", model || "(default)");
    return { key: EXPLORE_MODEL_SETTING, home: "user" };
  }

  async setEffort(effort: EffortLevel | null): Promise<SettingWrite> {
    const { model } = readExploreSetting(this.platform.settings);
    if (effort !== null && model === "") throw new Error(t("Default runs Explore at medium effort. Choose a model to set one."));
    assertEffortSupported(model, effort);
    await this.platform.settings.update(EXPLORE_EFFORT_SETTING, effort ?? undefined, "user");
    log("[ExploreManager] setEffort: %s", effort ?? "(default)");
    return { key: EXPLORE_EFFORT_SETTING, home: "user" };
  }
}
