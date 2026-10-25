import type { Model, Api } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelInfo, EffortLevel, TeamRole } from '../../shared/types/settings';
import type { OpenAIAuthStatus } from './openai-auth';
import { resolvePiModel, piModelToModelInfo, effortToPiThinking, notInPlanClause, type ModelLookup } from './pi-models';
import { modelDollarBilled } from './account-billing';
import { ROLE_EFFORT_LEVELS } from '../../shared/types/constants';
import { modelLabel } from '../../shared/model-vendor';

/**
 * Settings-driven team role model/effort resolution (Slice 1). The LEAD / IMPLEMENTOR / REVIEWER role
 * models and reasoning efforts are chosen by the USER via six flat `damocles.team.*` settings — never by
 * the AI. `resolveRoleModel(role, deps)` maps a role to its configured slot and returns the resolved pi
 * model + reasoning depth, or a blocking `error`.
 *
 * - **Configured slot** (`roleSettings[role].model !== ''`): resolve the exact model. If it is unknown or
 *   its provider is not signed in, return `{ error }` naming the `damocles.team.*Model` key and the model
 *   value — NO fail-soft. The caller (create_team fail-fast / spawn-time) surfaces the error to the model.
 * - **Unset slot** (`model === ''`): the active panel model, or `{ error }` when it cannot run (signed out,
 *   outside the plan, or none), because a member spawned without a model would run on one pi chose.
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
  /** Whether this role's model bills real dollars, so its cost is a charge rather than an estimate. A
   *  role can run a metered model inside a flat-subscription panel, so the panel value does not answer it. */
  dollarBilled: boolean;
  error?: string;
}

export interface TeamModelDeps {
  registry: ModelLookup;
  openai: OpenAIAuthStatus;
  preferApiKey: boolean;
  /** The active panel model value (the fail-soft target for unset slots). */
  activeModel: string;
  /** The Claude auth mode (`PiRuntime.getClaudeAuthStatus().mode`). Decides billing for Anthropic models. */
  claudeAuthMode: string;
  /** The curated model catalog — `piSupportedModels()`. Source of `supportedEffortLevels` per model. */
  supportedModels: readonly ModelInfo[];
  /** Key providers whose applied key bills a flat subscription (`PiRuntime.flatFeeKeyProviders()`). */
  flatFeeKeyProviders: ReadonlySet<string>;
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
  return model ? modelLabel(piModelToModelInfo(model)) : value;
}

/** The catalog display name for a model value (falls back to the raw value when it is not curated). Used
 *  for the agent-card label when no pi `Model` resolved (an unauthed slot), so the card shows "Opus 5.5"
 *  rather than the raw "claude-opus-5-5". */
function catalogLabel(value: string, supportedModels: readonly ModelInfo[]): string {
  const info = supportedModels.find((m) => m.value === value);
  return info ? modelLabel(info) : value;
}

/**
 * The active model itself, for an UNSET slot. A member is never spawned without a model, since pi would then choose one
 * itself, so an active model that cannot run (signed out, outside the plan, or none) blocks the role with an error.
 */
function resolveActive(role: TeamRole, deps: TeamModelDeps): Omit<ResolvedTeamModel, 'dollarBilled'> {
  const res = resolvePiModel(deps.activeModel, deps.registry, deps.openai, deps.preferApiKey);
  if (res.model && res.authed) return { model: res.model, modelLabel: labelFor(res.model, deps.activeModel) };
  const label = catalogLabel(deps.activeModel, deps.supportedModels);
  const cause = res.model && res.notInPlan
    ? `${notInPlanClause(res.model)}, this chat's model.`
    : res.model
      ? `this chat's model, ${label}, is not signed in.`
      : `this chat has no model it can run.`;
  return { modelLabel: label, error: `Team role "${role}" cannot run: ${cause} Pick another model for the chat, or set ${ROLE_SETTING_KEY[role]}.` };
}

/**
 * The pi thinking level for a slot's stored effort, coerced against the RESOLVED model's supported
 * levels. A slot that is unset, or holds a level the model does not support, takes the model's catalog
 * `defaultEffort`, the same fallback the panel applies. Returns `undefined` (no thinkingLevel) when
 * neither level is supported.
 */
function resolveThinkingLevel(
  resolvedValue: string,
  effort: EffortLevel | null,
  supportedModels: readonly ModelInfo[],
): ThinkingLevel | undefined {
  const info = supportedModels.find((m) => m.value === resolvedValue);
  const supported = (level: EffortLevel | null | undefined): EffortLevel | null =>
    level && ROLE_EFFORT_LEVELS.includes(level) && info?.supportedEffortLevels?.includes(level) ? level : null;
  const level = supported(effort) ?? supported(info?.defaultEffort);
  if (level === null) return undefined;
  return effortToPiThinking(level);
}

/** Compose a ResolvedTeamModel, attaching `thinkingLevel` only when non-undefined. */
function withThinking(base: ResolvedTeamModel, thinkingLevel: ThinkingLevel | undefined): ResolvedTeamModel {
  return thinkingLevel === undefined ? base : { ...base, thinkingLevel };
}

/**
 * Resolve a team role's model + reasoning depth from the user's settings.
 * - Configured slot: exact model; blocking `{ error }` if unknown/unauthed/outside the plan.
 * - Unset slot: the active panel model; blocking `{ error }` if it cannot run.
 * Effort is coerced against the resolved model in both branches (see `resolveThinkingLevel`).
 */
export function resolveRoleModel(role: TeamRole, deps: TeamModelDeps): ResolvedTeamModel {
  const setting = deps.roleSettings[role];
  // Billing follows the model this role actually runs, which is its configured slot or the panel model.
  const billed = modelDollarBilled(setting.model !== '' ? setting.model : deps.activeModel, deps);

  if (setting.model !== '') {
    const res = resolvePiModel(setting.model, deps.registry, deps.openai, deps.preferApiKey);
    if (!res.model || !res.authed) {
      // Branch the cause so the user knows whether to change the setting (unknown model) or sign in
      // (model resolves but its provider is unauthed) — not a merged "not available or not signed in".
      if (res.model && res.notInPlan) {
        return { dollarBilled: billed, error: `Team role "${role}" cannot run: ${notInPlanClause(res.model)}, the model ${ROLE_SETTING_KEY[role]} names. Change the setting to another model.` };
      }
      const cause = !res.model
        ? 'that model is not available. Change the setting to a supported model.'
        : 'its provider is not signed in. Sign in to that provider or change the setting.';
      return {
        dollarBilled: billed,
        error: `Team role "${role}" is configured to model "${setting.model}" (${ROLE_SETTING_KEY[role]}), but ${cause}`,
      };
    }
    const base: ResolvedTeamModel = { model: res.model, modelLabel: labelFor(res.model, setting.model), dollarBilled: billed };
    return withThinking(base, resolveThinkingLevel(setting.model, setting.effort, deps.supportedModels));
  }

  const base: ResolvedTeamModel = { ...resolveActive(role, deps), dollarBilled: billed };
  if (base.error) return base;
  return withThinking(base, resolveThinkingLevel(deps.activeModel, setting.effort, deps.supportedModels));
}
