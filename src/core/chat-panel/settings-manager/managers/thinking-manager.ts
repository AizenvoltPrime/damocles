import type { SettingsFolder, SettingsStore } from "../../../../platform/settings-store";
import type { EffortLevel, PanelThinkingState } from "../../../../shared/types/settings";
import type { PanelHost } from "../../../../platform/window-service";
import type { PostMessageFn } from "../types";
import {
  assertEffortSupported,
  coerceEffortForModel,
  defaultEffortForModel,
  thinkingDisableAppliesToModel,
} from "../utils";
import { DEFAULT_MODELS, effortByModelEntry } from "../../../../shared/types/constants";
import { effortToPiThinking } from "../../../pi-session/pi-models";

/**
 * ThinkingManager owns per-panel reasoning controls (disabled toggle, effort
 * level). Each per-panel value layers above the workspace defaults exposed via
 * `damocles.thinkingDisabled` and `damocles.effortByModel`. Effort is keyed
 * per-(panel, model) so switching models inside a panel preserves prior intent.
 *
 * Per-panel state is in-memory only; a resumed conversation takes the level its
 * session file recorded (restoreRecordedLevel), else the workspace defaults apply.
 */
export class ThinkingManager {
  private readonly perPanelDisabled: Map<string, boolean> = new Map();
  private readonly perPanelEffortByModel: Map<string, Record<string, EffortLevel | null>> = new Map();
  private readonly postMessage: PostMessageFn;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
  }

  /** Drop all per-panel state when the panel is disposed. */
  cleanupPanelThinking(panelId: string): void {
    this.perPanelDisabled.delete(panelId);
    this.perPanelEffortByModel.delete(panelId);
  }

  /**
   * Copy per-panel thinking state from a source panel to a newly created one.
   * Used by panel cloning so the cloned panel inherits its source's
   * per-(panel, model) thinking matrix.
   */
  copyPanelStateTo(sourcePanelId: string, targetPanelId: string): void {
    const sourceDisabled = this.perPanelDisabled.get(sourcePanelId);
    if (sourceDisabled !== undefined) {
      this.perPanelDisabled.set(targetPanelId, sourceDisabled);
    }
    const sourceEffort = this.perPanelEffortByModel.get(sourcePanelId);
    if (sourceEffort) {
      this.perPanelEffortByModel.set(targetPanelId, { ...sourceEffort });
    }
  }

  /**
   * Resolve thinking-disabled with the per-panel override layered above the workspace default.
   *
   * The model gates the whole resolution: a stored `true` counts only where the settings panel shows the
   * switch (`thinkingDisableApplies`). Anywhere else it would send a level the UI does not show and append
   * the prompt's no-thinking section. One gate here, because a second place to apply it is a second place
   * to forget it.
   */
  resolveDisabled(panelId: string, model: string, settings: SettingsStore, folder: SettingsFolder | undefined): boolean {
    if (!thinkingDisableAppliesToModel(model)) return false;
    const override = this.perPanelDisabled.get(panelId);
    if (override !== undefined) return override;
    return settings.get<boolean>("damocles.thinkingDisabled", false, folder);
  }

  /**
   * Resolve effort with the per-(panel, model) override layered above
   * the model's `damocles.effortByModel` entry (`effortByModelEntry`), then the model's catalog `defaultEffort`.
   * Capability regressions (a stored value no longer in the model's
   * `supportedEffortLevels`) resolve to null so they never leak into SDK
   * options. The catalog default is resolved per request and never written
   * back, so `damocles.effortByModel` stays empty until the user sets a level.
   */
  resolveEffort(panelId: string, model: string, settings: SettingsStore, folder: SettingsFolder | undefined): EffortLevel | null {
    const panelMap = this.perPanelEffortByModel.get(panelId);
    const panelOverride = panelMap?.[model];
    if (panelOverride !== undefined) {
      return coerceEffortForModel(model, panelOverride) ?? defaultEffortForModel(model);
    }
    const defaults = settings.get<Record<string, EffortLevel | null>>("damocles.effortByModel", {}, folder) ?? {};
    return coerceEffortForModel(model, effortByModelEntry(defaults, model)) ?? defaultEffortForModel(model);
  }

  /** Set the per-panel disabled override. */
  setPanelDisabled(panelId: string, disabled: boolean): void {
    this.perPanelDisabled.set(panelId, disabled);
  }

  /**
   * Set the per-(panel, model) effort override. Throws when the requested
   * effort is not in the model's `supportedEffortLevels`. `null` clears the
   * override and lets resolution fall through to the workspace default.
   */
  setPanelEffort(panelId: string, model: string, effort: EffortLevel | null): void {
    assertEffortSupported(model, effort);
    let panelMap = this.perPanelEffortByModel.get(panelId);
    if (!panelMap) {
      panelMap = {};
      this.perPanelEffortByModel.set(panelId, panelMap);
    }
    if (effort === null) {
      delete panelMap[model];
    } else {
      panelMap[model] = effort;
    }
  }

  /**
   * A resumed conversation's recorded pi thinking level, the level it ran at after pi's clamp, as this panel's reasoning for
   * `model`: the first effort the model lists that maps to it, and thinking off or on where the model offers the switch.
   */
  restoreRecordedLevel(panelId: string, model: string, level: string): void {
    if (thinkingDisableAppliesToModel(model)) this.perPanelDisabled.set(panelId, level === "off");
    const effort = DEFAULT_MODELS.find((info) => info.value === model)?.supportedEffortLevels?.find((candidate) => effortToPiThinking(candidate) === level);
    if (effort) this.setPanelEffort(panelId, model, effort);
  }

  /**
   * Broadcast resolved thinking values for the panel's currently-active model
   * plus the workspace defaults keyed by the workspace default model. The
   * webview renders "This Panel" against the active model and "Defaults for
   * New Panels" against the default model — the two scopes are independent
   * by design.
   */
  sendThinkingForPanel(
    host: PanelHost,
    panelId: string,
    activeModel: string,
    defaultModel: string,
    settings: SettingsStore,
    folder: SettingsFolder | undefined,
  ): void {
    const panel: PanelThinkingState = {
      thinkingDisabled: this.resolveDisabled(panelId, activeModel, settings, folder),
      effort: this.resolveEffort(panelId, activeModel, settings, folder),
    };
    // The defaults column reads the workspace scope directly rather than through the panel resolvers,
    // so both the disable gate and the catalog default must be applied again here or the column
    // disagrees with what a new panel on the default model actually sends.
    const defaults: PanelThinkingState = {
      thinkingDisabled: thinkingDisableAppliesToModel(defaultModel)
        ? settings.get<boolean>("damocles.thinkingDisabled", false, folder)
        : false,
      effort: coerceEffortForModel(
        defaultModel,
        effortByModelEntry(settings.get<Record<string, EffortLevel | null>>("damocles.effortByModel", {}, folder) ?? {}, defaultModel),
      ) ?? defaultEffortForModel(defaultModel),
    };
    this.postMessage(host, {
      type: "panelThinkingUpdate",
      panel,
      panelModel: activeModel,
      defaults,
      defaultsModel: defaultModel,
    });
  }
}
