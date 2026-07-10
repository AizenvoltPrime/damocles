import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelInfo, EffortLevel, TeamRole } from '../../shared/types/settings';
import type { OpenAIAuthStatus } from './openai-auth';
import { resolvePiModel, piModelToModelInfo, effortToPiThinking, type ModelLookup } from './pi-models';

/**
 * Settings-driven team role model/effort resolution (Slice 1). The LEAD / IMPLEMENTOR / REVIEWER role
 * models and reasoning efforts are chosen by the USER via six flat `damocles.team.*` settings — never by
 * the AI. `resolveRoleModel(role, deps)` maps a role to its configured slot and returns the resolved pi
 * model + reasoning depth, or a blocking `error`.
 *
 * - **Configured slot** (`roleSettings[role].model !== ''`): resolve the exact model. If it is unknown or
 *   its provider is not signed in, return `{ error }` naming the `damocles.team.*Model` key and the model
 *   value — NO fail-soft. The caller (create_team fail-fast / spawn-time) surfaces the error to the model.
 * - **Unset slot** (`model === ''`): fail soft to the active panel model (authed → that model, else no
 *   `model` so the caller degrades to the engine default; the label still reflects the active model).
 * - **Effort** (both branches): the slot's stored effort is coerced at resolution time against the
 *   RESOLVED model's `supportedEffortLevels`; unsupported → no `thinkingLevel` (silent coercion, by
 *   design). Coercion is LOCAL to this module so it stays vscode-free and pure-mock-testable.
 *
 * This module carries no provider policy: cross-provider selection is fully user-driven, and there is no
 * forced-Opus/xhigh behavior.
 */

// `SpecialistKind` / `TeamRole` are defined once in `shared/types/settings` (single source of truth,
// shared across the extension/webview message boundary) and re-exported here for resolver callers.
export type { SpecialistKind, TeamRole } from '../../shared/types/settings';

/** A role's resolved settings snapshot. `model === ''` means unset (use the active panel model). */
export interface TeamRoleSetting {
  model: string;
  effort: EffortLevel | null;
}

export interface ResolvedTeamModel {
  model?: Model<Api>;
  modelLabel?: string;
  /** Reasoning depth for this agent's session, derived from the role's configured effort (coerced against
   *  the resolved model's supported levels); unset when no effort applies. */
  thinkingLevel?: ThinkingLevel;
  error?: string;
}

export interface TeamModelDeps {
  registry: ModelLookup;
  openai: OpenAIAuthStatus;
  preferApiKey: boolean;
  /** The active panel model value (the fail-soft target for unset slots). */
  activeModel: string;
  /** The curated model catalog — `piSupportedModels()`. Source of `supportedEffortLevels` per model. */
  supportedModels: readonly ModelInfo[];
  /** The user's per-role model/effort settings (read fresh from vscode config by the caller). */
  roleSettings: Record<TeamRole, TeamRoleSetting>;
}

/** The `damocles.team.*Model` setting key that configures a given role — named in blocking errors. */
const ROLE_SETTING_KEY: Record<TeamRole, string> = {
  lead: 'damocles.team.leadModel',
  implementor: 'damocles.team.implementorModel',
  reviewer: 'damocles.team.reviewerModel',
};

/** The short display label for a resolved pi model (falls back to the raw value). */
function labelFor(model: Model<Api> | undefined, value: string): string {
  return model ? piModelToModelInfo(model).displayName : value;
}

/** The catalog display name for a model value (falls back to the raw value when it is not curated). Used
 *  for the agent-card label when no pi `Model` resolved (an unauthed slot), so the card shows "Opus 4.8"
 *  rather than the raw "claude-opus-4-8". */
function catalogLabel(value: string, supportedModels: readonly ModelInfo[]): string {
  return supportedModels.find((m) => m.value === value)?.displayName ?? value;
}

/**
 * Resolve the active model itself as a fail-soft fallback for an UNSET slot. Requires `authed`: an
 * unauthed-but-resolvable active model would spawn an unusable session that fails at runtime, so we
 * return no `model` and let the caller degrade to the engine default instead (the label still reflects
 * the active model for the agent card).
 */
function resolveActive(deps: TeamModelDeps): ResolvedTeamModel {
  const res = resolvePiModel(deps.activeModel, deps.registry, deps.openai, deps.preferApiKey);
  if (res.model && res.authed) return { model: res.model, modelLabel: labelFor(res.model, deps.activeModel) };
  return { modelLabel: catalogLabel(deps.activeModel, deps.supportedModels) };
}

/**
 * The pi thinking level for a slot's stored effort, coerced against the RESOLVED model's supported
 * levels. Returns `undefined` (no thinkingLevel) when: no model resolved, no effort set, or the model
 * does not support the effort (silent coercion by design).
 */
function resolveThinkingLevel(
  resolvedValue: string | undefined,
  effort: EffortLevel | null,
  supportedModels: readonly ModelInfo[],
): ThinkingLevel | undefined {
  if (resolvedValue === undefined || effort === null) return undefined;
  const info = supportedModels.find((m) => m.value === resolvedValue);
  if (!info?.supportedEffortLevels?.includes(effort)) return undefined;
  return effortToPiThinking(effort);
}

/** Compose a ResolvedTeamModel, attaching `thinkingLevel` only when non-undefined. */
function withThinking(base: ResolvedTeamModel, thinkingLevel: ThinkingLevel | undefined): ResolvedTeamModel {
  return thinkingLevel === undefined ? base : { ...base, thinkingLevel };
}

/**
 * Resolve a team role's model + reasoning depth from the user's settings.
 * - Configured slot: exact model; blocking `{ error }` if unknown/unauthed.
 * - Unset slot: fail soft to the active panel model.
 * Effort is coerced against the resolved model in both branches (see `resolveThinkingLevel`).
 */
export function resolveRoleModel(role: TeamRole, deps: TeamModelDeps): ResolvedTeamModel {
  const setting = deps.roleSettings[role];

  if (setting.model !== '') {
    const res = resolvePiModel(setting.model, deps.registry, deps.openai, deps.preferApiKey);
    if (!res.model || !res.authed) {
      // Branch the cause so the user knows whether to change the setting (unknown model) or sign in
      // (model resolves but its provider is unauthed) — not a merged "not available or not signed in".
      const cause = !res.model
        ? 'that model is not available. Change the setting to a supported model.'
        : 'its provider is not signed in. Sign in to that provider or change the setting.';
      return {
        error: `Team role "${role}" is configured to model "${setting.model}" (${ROLE_SETTING_KEY[role]}), but ${cause}`,
      };
    }
    const base: ResolvedTeamModel = { model: res.model, modelLabel: labelFor(res.model, setting.model) };
    return withThinking(base, resolveThinkingLevel(setting.model, setting.effort, deps.supportedModels));
  }

  const base = resolveActive(deps);
  // Effort applies only when a model actually resolved (unset + unauthed → no model → no thinkingLevel).
  const resolvedValue = base.model ? deps.activeModel : undefined;
  return withThinking(base, resolveThinkingLevel(resolvedValue, setting.effort, deps.supportedModels));
}
