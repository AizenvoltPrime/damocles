import * as vscode from "vscode";
import type { EffortLevel, PanelThinkingState } from "../../../../shared/types/settings";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import {
  assertEffortSupported,
  coerceEffortForModel,
  defaultEffortForModel,
  thinkingDisableAppliesToModel,
} from "../utils";

/**
 * ThinkingManager owns per-panel reasoning controls (disabled toggle, effort
 * level, max thinking tokens). Each per-panel value layers above the workspace
 * defaults exposed via `damocles.thinkingDisabled`, `damocles.effortByModel`,
 * and `damocles.maxThinkingTokens`. Effort and max-tokens are keyed per-(panel,
 * model) so switching models inside a panel preserves prior intent.
 *
 * Per-panel state is in-memory only. The workspace defaults serve as the
 * safety net on reload — matching the existing ModelManager behavior.
 */
export class ThinkingManager {
  private readonly perPanelDisabled: Map<string, boolean> = new Map();
  private readonly perPanelEffortByModel: Map<string, Record<string, EffortLevel | null>> = new Map();
  private readonly perPanelMaxTokensByModel: Map<string, Record<string, number | null>> = new Map();
  private readonly postMessage: PostMessageFn;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
  }

  /** Drop all per-panel state when the panel is disposed. */
  cleanupPanelThinking(panelId: string): void {
    this.perPanelDisabled.delete(panelId);
    this.perPanelEffortByModel.delete(panelId);
    this.perPanelMaxTokensByModel.delete(panelId);
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
    const sourceMaxTokens = this.perPanelMaxTokensByModel.get(sourcePanelId);
    if (sourceMaxTokens) {
      this.perPanelMaxTokensByModel.set(targetPanelId, { ...sourceMaxTokens });
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
  resolveDisabled(panelId: string, model: string, config: vscode.WorkspaceConfiguration): boolean {
    if (!thinkingDisableAppliesToModel(model)) return false;
    const override = this.perPanelDisabled.get(panelId);
    if (override !== undefined) return override;
    return config.get<boolean>("thinkingDisabled", false);
  }

  /**
   * Resolve effort with the per-(panel, model) override layered above
   * `damocles.effortByModel[model]`, then the model's catalog `defaultEffort`.
   * Capability regressions (a stored value no longer in the model's
   * `supportedEffortLevels`) resolve to null so they never leak into SDK
   * options. The catalog default is resolved per request and never written
   * back, so `damocles.effortByModel` stays empty until the user sets a level.
   */
  resolveEffort(panelId: string, model: string, config: vscode.WorkspaceConfiguration): EffortLevel | null {
    const panelMap = this.perPanelEffortByModel.get(panelId);
    const panelOverride = panelMap?.[model];
    if (panelOverride !== undefined) {
      return coerceEffortForModel(model, panelOverride) ?? defaultEffortForModel(model);
    }
    const defaults = config.get<Record<string, EffortLevel | null>>("effortByModel", {}) ?? {};
    return coerceEffortForModel(model, defaults[model] ?? null) ?? defaultEffortForModel(model);
  }

  /** Resolve max thinking tokens with the per-(panel, model) override above the workspace default. */
  resolveMaxTokens(panelId: string, model: string, config: vscode.WorkspaceConfiguration): number | null {
    const panelMap = this.perPanelMaxTokensByModel.get(panelId);
    const panelOverride = panelMap?.[model];
    if (panelOverride !== undefined) {
      return panelOverride;
    }
    return config.get<number | null>("maxThinkingTokens", null);
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

  /** Set the per-(panel, model) max-tokens override. `null` clears the override. */
  setPanelMaxTokens(panelId: string, model: string, tokens: number | null): void {
    let panelMap = this.perPanelMaxTokensByModel.get(panelId);
    if (!panelMap) {
      panelMap = {};
      this.perPanelMaxTokensByModel.set(panelId, panelMap);
    }
    if (tokens === null) {
      delete panelMap[model];
    } else {
      panelMap[model] = tokens;
    }
  }

  /**
   * Broadcast resolved thinking values for the panel's currently-active model
   * plus the workspace defaults keyed by the workspace default model. The
   * webview renders "This Panel" against the active model and "Defaults for
   * New Panels" against the default model — the two scopes are independent
   * by design.
   */
  sendThinkingForPanel(
    host: WebviewHost,
    panelId: string,
    activeModel: string,
    defaultModel: string,
    config: vscode.WorkspaceConfiguration,
  ): void {
    const panel: PanelThinkingState = {
      thinkingDisabled: this.resolveDisabled(panelId, activeModel, config),
      effort: this.resolveEffort(panelId, activeModel, config),
      maxThinkingTokens: this.resolveMaxTokens(panelId, activeModel, config),
    };
    // The defaults column reads the workspace scope directly rather than through the panel resolvers,
    // so both the disable gate and the catalog default must be applied again here or the column
    // disagrees with what a new panel on the default model actually sends.
    const defaults: PanelThinkingState = {
      thinkingDisabled: thinkingDisableAppliesToModel(defaultModel)
        ? config.get<boolean>("thinkingDisabled", false)
        : false,
      effort: coerceEffortForModel(
        defaultModel,
        (config.get<Record<string, EffortLevel | null>>("effortByModel", {}) ?? {})[defaultModel] ?? null,
      ) ?? defaultEffortForModel(defaultModel),
      maxThinkingTokens: config.get<number | null>("maxThinkingTokens", null),
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
