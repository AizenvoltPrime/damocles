import type { SettingInspection, SettingsScope, SettingsStore } from "../../platform/settings-store";
import { log } from "../logger";
import { DEFAULT_FALLBACK_MODEL, LEGACY_EFFORT_VALUE_MAP, LEGACY_MODEL_MAP, carryRetiredEffort, supportedStoredEffort } from "../../shared/types/constants";
import type { EffortLevel } from "../../shared/types/settings";
import { EXPLORE_EFFORT_SETTING, EXPLORE_MODEL_SETTING } from "../../shared/explore-settings";

// A store reports a local value only where it can write one: the desktop local file of a trusted project.
const MIGRATED_SCOPES: readonly SettingsScope[] = ["user", "project", "local"];

const SCOPE_VALUE = {
  user: "userValue",
  project: "projectValue",
  local: "localValue",
} as const satisfies Record<SettingsScope, keyof SettingInspection<unknown>>;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs one scope of a migration; a failure is logged and leaves the other scopes to run. */
async function inScope(migration: string, scope: SettingsScope, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    log(`[Migration] ${migration} failed (scope=${scope}, non-fatal): ${describeError(err)}`);
  }
}

export async function migrateLegacyEffortSetting(settings: SettingsStore): Promise<void> {
  const inspect = settings.inspect<EffortLevel | null>("damocles.effort");
  const activeModel = settings.get<string>("damocles.model", "") || DEFAULT_FALLBACK_MODEL;
  for (const scope of MIGRATED_SCOPES) {
    const value = inspect[SCOPE_VALUE[scope]];
    if (value === undefined || value === null) continue;
    await inScope("damocles.effort", scope, async () => {
      const mapInspect = settings.inspect<Record<string, EffortLevel | null>>("damocles.effortByModel");
      const currentMap = mapInspect[SCOPE_VALUE[scope]] ?? {};
      if (!(activeModel in currentMap)) {
        const nextMap = { ...currentMap, [activeModel]: value };
        await settings.update("damocles.effortByModel", nextMap, scope);
        log(`[Migration] Moved damocles.effort=${value} → effortByModel[${activeModel}] (scope=${scope})`);
      }
      await settings.update("damocles.effort", undefined, scope);
    });
  }
}

const MODEL_KEYS = ["model", "team.leadModel", "team.implementorModel", "team.reviewerModel", "background.model", "memory.judge", "explore.model"] as const;

export async function migrateLegacyModelSetting(settings: SettingsStore): Promise<void> {
  const mapInspect = settings.inspect<Record<string, EffortLevel | null>>("damocles.effortByModel");
  const modelInspects = MODEL_KEYS.map((key) => ({ key, inspect: settings.inspect<string>(`damocles.${key}`) }));
  for (const scope of MIGRATED_SCOPES) {
    await inScope("retired model ids", scope, () => migrateLegacyModelScope(settings, scope, modelInspects, mapInspect[SCOPE_VALUE[scope]]));
  }
}

async function migrateLegacyModelScope(
  settings: SettingsStore,
  scope: SettingsScope,
  modelInspects: readonly { key: (typeof MODEL_KEYS)[number]; inspect: SettingInspection<string> }[],
  map: Record<string, EffortLevel | null> | undefined,
): Promise<void> {
  const models = modelInspects.map(({ key, inspect }) => ({ key, value: inspect[SCOPE_VALUE[scope]] }));
  // Migrate each model value that is a legacy id at this scope. Independent of the effort re-key
  // below: a scope can hold legacy effort entries with no model value set (or vice versa).
  // Own-property lookups guard against inherited keys ("toString", "constructor") on a stored value
  // resolving to a prototype member instead of a real mapping.
  for (const { key, value } of models) {
    const mapped = value != null && Object.hasOwn(LEGACY_MODEL_MAP, value) ? LEGACY_MODEL_MAP[value] : undefined;
    if (!mapped) continue;
    await settings.update(`damocles.${key}`, mapped, scope);
    log(`[Migration] damocles.${key}=${value} → ${mapped} (scope=${scope})`);
  }
  // Re-key effortByModel entries stored under a legacy id to the mapped id at the same scope.
  const currentMap = map ?? {};
  let mapChanged = false;
  const nextMap: Record<string, EffortLevel | null> = { ...currentMap };
  for (const legacyId of Object.keys(currentMap)) {
    const mappedId = Object.hasOwn(LEGACY_MODEL_MAP, legacyId) ? LEGACY_MODEL_MAP[legacyId] : undefined;
    if (!mappedId) continue;
    delete nextMap[legacyId];
    mapChanged = true;
    // Non-clobber: keep an existing entry for the mapped id, whether it was present in the stored
    // map OR already written by an earlier legacy id this pass. Two legacy ids can map to the same
    // successor (gpt-5.5 + gpt-5.3-codex → gpt-6.1-sol); testing nextMap makes that first-wins and
    // deterministic (testing currentMap would let the later id clobber the earlier, last-wins).
    // effortByModelEntry reads an unmigrated map with the same first-wins rule.
    if (Object.hasOwn(nextMap, mappedId)) continue;
    nextMap[mappedId] = carryRetiredEffort(mappedId, currentMap[legacyId] ?? null);
  }
  // Value-migrate stored effort levels renamed by pi metadata changes (e.g. DeepSeek xhigh → max in
  // pi 0.80.6). This rewrites the id's own value in place, an upward rename matching pi's direction,
  // NOT a clamp (which would clamp an unsupported level down to supported[0] = 'high').
  // Idempotent: after one pass the renamed old level no longer appears, so a re-run is a no-op.
  for (const modelId of Object.keys(nextMap)) {
    const renames = Object.hasOwn(LEGACY_EFFORT_VALUE_MAP, modelId) ? LEGACY_EFFORT_VALUE_MAP[modelId] : undefined;
    if (!renames) continue;
    const value = nextMap[modelId];
    if (value == null || !Object.hasOwn(renames, value)) continue;
    const renamed = renames[value];
    if (!renamed || renamed === value) continue;
    nextMap[modelId] = renamed;
    mapChanged = true;
  }
  if (mapChanged) {
    await settings.update("damocles.effortByModel", nextMap, scope);
    log(`[Migration] Migrated damocles.effortByModel legacy entries (retired-model re-key / renamed effort levels) (scope=${scope})`);
  }
}

/** Removes a stored `damocles.maxThinkingTokens`, a setting pi never read, at every scope that holds one. */
export async function removeMaxThinkingTokensSetting(settings: SettingsStore): Promise<void> {
  const inspect = settings.inspect<number | null>("damocles.maxThinkingTokens");
  for (const scope of MIGRATED_SCOPES) {
    if (inspect[SCOPE_VALUE[scope]] === undefined) continue;
    await inScope("damocles.maxThinkingTokens", scope, async () => {
      await settings.update("damocles.maxThinkingTokens", undefined, scope);
      log(`[Migration] Removed damocles.maxThinkingTokens (scope=${scope})`);
    });
  }
}

const RETIRED_EXPLORE_KEYS = ["damocles.explore.enabled", "damocles.explore.provider", "damocles.explore.modelByProvider"] as const;

/** Whether the StepFun key is stored; undefined when the store could not answer. */
export type StepfunKeyStored = () => Promise<boolean | undefined>;

/**
 * Moves the retired Explore provider settings to `damocles.explore.model`: an enabled StepFun Explore becomes Step 5 Preview
 * when the StepFun key is stored, anything else Default, and the retired keys are removed at every scope. Everything stays
 * for a later launch when the key store cannot answer or the model cannot be written.
 */
export async function migrateExploreSettings(settings: SettingsStore, stepfunKeyStored: StepfunKeyStored): Promise<void> {
  const held = MIGRATED_SCOPES.filter((scope) => RETIRED_EXPLORE_KEYS.some((key) => settings.inspect(key)[SCOPE_VALUE[scope]] !== undefined));
  if (held.length === 0) return;
  if (!(await moveExploreChoice(settings, stepfunKeyStored))) return;
  for (const scope of held) {
    await inScope("retired Explore provider settings", scope, async () => {
      for (const key of RETIRED_EXPLORE_KEYS) {
        if (settings.inspect(key)[SCOPE_VALUE[scope]] === undefined) continue;
        await settings.update(key, undefined, scope);
        log(`[Migration] Removed ${key} (scope=${scope})`);
      }
    });
  }
}

/** Writes the user's Explore model, then drops an effort it does not take; false when the choice could not be moved. */
async function moveExploreChoice(settings: SettingsStore, stepfunKeyStored: StepfunKeyStored): Promise<boolean> {
  if (settings.inspect(EXPLORE_MODEL_SETTING).userValue !== undefined) return true;
  // The Explore model is user-only, so only the user file's retired keys decide it and a project's are dropped.
  const enabled = settings.inspect<boolean>("damocles.explore.enabled").userValue ?? false;
  const provider = settings.inspect<string>("damocles.explore.provider").userValue ?? "openrouter";
  let model = "";
  if (enabled === true && provider === "stepfun") {
    const keyed = await stepfunKeyStored().catch(() => undefined);
    if (keyed === undefined) {
      log("[Migration] Kept the retired Explore provider settings for a later launch: the StepFun key could not be read");
      return false;
    }
    // Without its key a StepFun Explore ran on Default.
    if (keyed) model = "step-5-preview";
  }
  if (model !== "") {
    try {
      await settings.update(EXPLORE_MODEL_SETTING, model, "user");
    } catch (err) {
      log(`[Migration] ${EXPLORE_MODEL_SETTING} failed (scope=user, non-fatal): ${describeError(err)}`);
      return false;
    }
    log(`[Migration] ${EXPLORE_MODEL_SETTING}=${model} from the retired Explore provider settings (scope=user)`);
  }
  // Default takes no effort, and a picked model keeps only one it supports.
  const effort = settings.inspect<string>(EXPLORE_EFFORT_SETTING).userValue;
  if (effort !== undefined && supportedStoredEffort(model, effort) === null) {
    await inScope(EXPLORE_EFFORT_SETTING, "user", async () => {
      await settings.update(EXPLORE_EFFORT_SETTING, undefined, "user");
      log(`[Migration] Removed ${EXPLORE_EFFORT_SETTING}=${effort}, which ${model || "Default"} does not take (scope=user)`);
    });
  }
  return true;
}

/**
 * The startup migrations, run by each host. Best-effort: each migration and each scope runs on its own, so a rejected
 * update (a read-only or unwritable scope) skips only that scope and never aborts startup. Retired model ids, in a
 * model setting or as an `effortByModel` key, also resolve when read (`migrateLegacyModelValue`, `effortByModelEntry`).
 */
export async function runLegacySettingsMigrations(settings: SettingsStore, stepfunKeyStored: StepfunKeyStored): Promise<void> {
  const migrations: readonly (readonly [string, () => Promise<void>])[] = [
    ["damocles.effort", () => migrateLegacyEffortSetting(settings)],
    ["retired model ids", () => migrateLegacyModelSetting(settings)],
    ["damocles.maxThinkingTokens", () => removeMaxThinkingTokensSetting(settings)],
    ["retired Explore provider settings", () => migrateExploreSettings(settings, stepfunKeyStored)],
  ];
  for (const [name, migrate] of migrations) {
    try {
      await migrate();
    } catch (err) {
      log(`[Migration] ${name} failed (non-fatal): ${describeError(err)}`);
    }
  }
}
