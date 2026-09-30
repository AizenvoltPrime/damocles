import type { SettingInspection, SettingsScope, SettingsStore } from "../../platform/settings-store";
import { log } from "../logger";
import { DEFAULT_FALLBACK_MODEL, DEFAULT_MODELS, LEGACY_EFFORT_VALUE_MAP, LEGACY_MODEL_MAP } from "../../shared/types/constants";
import type { EffortLevel } from "../../shared/types/settings";

// A store reports a local value only where it can write one: the desktop local file of a trusted project.
const MIGRATED_SCOPES: readonly SettingsScope[] = ["user", "project", "local"];

const SCOPE_VALUE = {
  user: "userValue",
  project: "projectValue",
  local: "localValue",
} as const satisfies Record<SettingsScope, keyof SettingInspection<unknown>>;

export async function migrateLegacyEffortSetting(settings: SettingsStore): Promise<void> {
  const inspect = settings.inspect<EffortLevel | null>("damocles.effort");
  const activeModel = settings.get<string>("damocles.model", "") || DEFAULT_FALLBACK_MODEL;
  for (const scope of MIGRATED_SCOPES) {
    const value = inspect[SCOPE_VALUE[scope]];
    if (value === undefined || value === null) continue;
    const mapInspect = settings.inspect<Record<string, EffortLevel | null>>("damocles.effortByModel");
    const currentMap = mapInspect[SCOPE_VALUE[scope]] ?? {};
    if (!(activeModel in currentMap)) {
      const nextMap = { ...currentMap, [activeModel]: value };
      await settings.update("damocles.effortByModel", nextMap, scope);
      log(`[Migration] Moved damocles.effort=${value} → effortByModel[${activeModel}] (scope=${scope})`);
    }
    await settings.update("damocles.effort", undefined, scope);
  }
}

const TEAM_MODEL_KEYS = ["team.leadModel", "team.implementorModel", "team.reviewerModel"] as const;

export async function migrateLegacyModelSetting(settings: SettingsStore): Promise<void> {
  const mapInspect = settings.inspect<Record<string, EffortLevel | null>>("damocles.effortByModel");
  const modelInspects = (["model", ...TEAM_MODEL_KEYS] as const).map((key) => ({ key, inspect: settings.inspect<string>(`damocles.${key}`) }));
  for (const scope of MIGRATED_SCOPES) {
    const models = modelInspects.map(({ key, inspect }) => ({ key, value: inspect[SCOPE_VALUE[scope]] }));
    const map = mapInspect[SCOPE_VALUE[scope]];
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
      const carried = currentMap[legacyId] ?? null;
      delete nextMap[legacyId];
      mapChanged = true;
      // Non-clobber: keep an existing entry for the mapped id — whether it was present in the stored
      // map OR already written by an earlier legacy id this pass. Two legacy ids can map to the same
      // successor (gpt-5.5 + gpt-5.3-codex → gpt-6-sol); testing nextMap makes that first-wins and
      // deterministic (testing currentMap would let the later id clobber the earlier, last-wins).
      if (Object.hasOwn(nextMap, mappedId)) continue;
      nextMap[mappedId] = clampEffortToModel(carried, mappedId);
    }
    // Value-migrate stored effort levels renamed by pi metadata changes (e.g. DeepSeek xhigh → max in
    // pi 0.80.6). This rewrites the id's own value in place — an upward rename matching pi's direction,
    // NOT clampEffortToModel (which would clamp an unsupported level down to supported[0] = 'high').
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
}

/**
 * Clamps a carried effort level to a target model's supported set. Legacy GPT entries allowed
 * `'none'`, but the current GPT models are codex-strict `['low','medium','high','xhigh','max']`, so an
 * unsupported level (`'none'`) clamps up to the model's lowest supported level (`'low'`).
 */
function clampEffortToModel(effort: EffortLevel | null, modelId: string): EffortLevel | null {
  if (effort === null) return null;
  const model = DEFAULT_MODELS.find((m) => m.value === modelId);
  const supported = model?.supportedEffortLevels;
  if (!supported || supported.includes(effort)) return effort;
  return supported[0] ?? effort;
}

/**
 * Both migrations, run by each host at startup. Best-effort: a rejected update (a read-only or unwritable scope)
 * must never abort startup, and stored legacy values still resolve at read time via migrateLegacyModelValue.
 */
export async function runLegacySettingsMigrations(settings: SettingsStore): Promise<void> {
  try {
    await migrateLegacyEffortSetting(settings);
    await migrateLegacyModelSetting(settings);
  } catch (err) {
    log(`[Migration] Settings migration failed (non-fatal, read-side mapping still applies): ${err instanceof Error ? err.message : String(err)}`);
  }
}
