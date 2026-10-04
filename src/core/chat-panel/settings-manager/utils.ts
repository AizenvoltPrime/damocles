import type { Platform } from "../../../platform/platform";
import type { SettingsFolder, SettingsScope } from "../../../platform/settings-store";
import * as path from "path";
import * as os from "os";
import { log } from "../../logger";
import { writeJsonConfig } from "../../config/json-config-write";
import { parseSettingsText } from "../../config/settings-file";
import { t } from "../../l10n";
import type { PermissionUpdate, PermissionRuleValue, PermissionUpdateDestination } from "../../../shared/types/permissions";
import { DEFAULT_MODELS, DEFAULT_CONTEXT_WINDOW, thinkingDisableApplies } from "../../../shared/types/constants";
import type { EffortLevel } from "../../../shared/types/settings";

/** The permission arrays a rule may be filed under; also the guard against a hostile `behavior`. */
const PERMISSION_BEHAVIORS: readonly string[] = ["allow", "deny", "ask"];

/**
 * Throws when `effort` is not in the model's `supportedEffortLevels`. Used by
 * setters that must reject invalid input loudly. `null` is always accepted
 * because it represents "clear the override".
 */
export function assertEffortSupported(model: string, effort: EffortLevel | null): void {
  if (effort === null) return;
  const modelInfo = DEFAULT_MODELS.find(m => m.value === model);
  if (!modelInfo?.supportedEffortLevels?.includes(effort)) {
    throw new Error(`Effort "${effort}" is not supported by model "${model}"`);
  }
}

/**
 * Returns `effort` if the model supports it, otherwise `null`. Used by
 * resolvers reading stored values that may have been recorded against a
 * model whose capabilities have since changed.
 */
export function coerceEffortForModel(model: string, effort: EffortLevel | null): EffortLevel | null {
  if (!effort) return null;
  const modelInfo = DEFAULT_MODELS.find(m => m.value === model);
  if (!modelInfo?.supportedEffortLevels?.includes(effort)) return null;
  return effort;
}

/**
 * The catalog effort for a model the user has set no effort for, validated the same way a stored value
 * is so a catalog typo cannot ship a level the model does not advertise. `null` when the model has no
 * catalog default, which leaves the level unset and lets pi apply its own.
 */
export function defaultEffortForModel(model: string): EffortLevel | null {
  return coerceEffortForModel(model, DEFAULT_MODELS.find(m => m.value === model)?.defaultEffort ?? null);
}

export function thinkingDisableAppliesToModel(model: string): boolean {
  return thinkingDisableApplies(DEFAULT_MODELS.find(m => m.value === model));
}

export function getContextWindowForModel(modelId: string): number {
  if (/\[1m\]/.test(modelId)) {
    return 1_000_000;
  }
  const modelInfo = DEFAULT_MODELS.find(m => m.value === modelId);
  return modelInfo?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

const SCOPE_RANK: Readonly<Record<SettingsScope, number>> = { user: 0, project: 1, local: 2 };

/** The highest scope holding a value for the key, which is the one its effective value comes from; undefined when only the default applies. */
export function effectiveScope(platform: Pick<Platform, "settings">, fullKey: string, folder: SettingsFolder | undefined): SettingsScope | undefined {
  const inspection = platform.settings.inspect<unknown>(fullKey, folder);
  if (inspection.localValue !== undefined) return "local";
  if (inspection.projectValue !== undefined) return "project";
  if (inspection.userValue !== undefined) return "user";
  return undefined;
}

/** What a settings setter wrote: the full key and its section's home scope (D37), which settingWriteResult reports. */
export interface SettingWrite {
  readonly key: string;
  readonly home: SettingsScope;
}

/**
 * Writes at `home` (D37: the section's scope), or where the value that wins is read from when that file ranks higher, so
 * the change always takes effect. `folder` is the chat's for a key read per chat, else undefined. A store reports a local
 * value only where it can write one.
 */
export async function updateConfigAtEffectiveScope<T>(
  platform: Pick<Platform, "settings">,
  key: string,
  value: T,
  options: { home?: SettingsScope; folder?: SettingsFolder | undefined } = {},
): Promise<SettingWrite> {
  const home = options.home ?? "user";
  const held = effectiveScope(platform, key, options.folder);
  const scope = held !== undefined && SCOPE_RANK[held] > SCOPE_RANK[home] ? held : home;
  await platform.settings.update(key, value, scope, options.folder);
  return { key, home };
}

function formatPermissionPattern(rule: PermissionRuleValue): string {
  if (rule.ruleContent) {
    return `${rule.toolName}(${rule.ruleContent})`;
  }
  return rule.toolName;
}

interface SettingsDestination {
  readonly path: string;
  /** Set for a repository's own `.damocles`, which a symlink must not lead out of. */
  readonly confineTo?: string;
}

/** Returns `null` for `'session'`: a session-scoped rule lives in memory and must never be persisted. */
function getSettingsDestination(
  destination: PermissionUpdateDestination,
  workspacePath: string | null
): SettingsDestination | null {
  const inWorkspace = (file: string): SettingsDestination => {
    const dir = path.join(workspacePath!, ".damocles");
    return { path: path.join(dir, file), confineTo: dir };
  };
  switch (destination) {
    case 'userSettings':
      return { path: path.join(os.homedir(), ".damocles", "settings.json") };
    case 'projectSettings':
      if (workspacePath) return inWorkspace("settings.json");
      return { path: path.join(os.homedir(), ".damocles", "settings.local.json") };
    case 'localSettings':
      if (workspacePath) return inWorkspace("settings.local.json");
      return { path: path.join(os.homedir(), ".damocles", "settings.local.json") };
    case 'session':
      return null;
    default: {
      const unhandled: never = destination;
      throw new Error(`Unhandled permission destination: ${String(unhandled)}`);
    }
  }
}

class UnparseableSettingsFile extends Error {}

/**
 * Writes each rule into its destination settings file. Resolves to one message for the user per destination that
 * was not written; a failed write never throws, so it cannot strand the approval that asked for it.
 */
export async function syncPermissionRulesToSettings(
  updates: PermissionUpdate[],
  workspacePath: string | null
): Promise<string[]> {
  const failures: string[] = [];
  for (const update of updates) {
    if (update.type !== 'addRules') continue;

    // `behavior` indexes an object below, and it arrives off a webview message. Left unchecked,
    // `__proto__` writes the prototype instead of a key and `constructor` puts junk in the user's
    // settings. `destination` two functions up gets an exhaustive check; this deserves the same.
    if (!PERMISSION_BEHAVIORS.includes(update.behavior)) {
      log(`[PermissionSettings] Ignoring permission update with unknown behavior "${String(update.behavior)}"`);
      continue;
    }

    const destination = getSettingsDestination(update.destination, workspacePath);
    if (destination === null) continue;
    const settingsPath = destination.path;

    // Per-update, so one unwritable destination cannot silently abandon the rules after it.
    try {
      await writeJsonConfig(settingsPath, (content) => {
        let settings: Record<string, unknown>;
        try {
          settings = content === undefined ? {} : parseSettingsText(content, settingsPath);
        } catch (err) {
          // The file also holds the user's other settings, which rewriting it from nothing would lose.
          throw new UnparseableSettingsFile(t('{0} does not parse, so it was not overwritten: {1}', settingsPath, err instanceof Error ? err.message : String(err)));
        }

        if (!settings['permissions'] || typeof settings['permissions'] !== 'object') {
          settings['permissions'] = {};
        }
        const permissions = settings['permissions'] as Record<string, unknown>;

        const arrayKey = update.behavior;
        if (!Array.isArray(permissions[arrayKey])) {
          permissions[arrayKey] = [];
        }
        const targetArray = permissions[arrayKey] as string[];

        for (const rule of update.rules) {
          const pattern = formatPermissionPattern(rule);
          if (!targetArray.includes(pattern)) {
            targetArray.push(pattern);
            log(`[PermissionSettings] Adding "${pattern}" to ${arrayKey} in ${settingsPath}`);
          }
        }

        // Trailing newline, matching `mcp-config-write.ts` and POSIX convention for a text file.
        return `${JSON.stringify(settings, null, 2)}\n`;
      }, destination.confineTo !== undefined ? { confineTo: destination.confineTo } : {});
      log(`[PermissionSettings] Wrote permissions to ${settingsPath}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`[PermissionSettings] Failed to write ${settingsPath}: ${reason}`);
      failures.push(t('The permission rule was not saved. {0}', err instanceof UnparseableSettingsFile ? reason : t('Could not save {0}: {1}', settingsPath, reason)));
    }
  }
  return failures;
}
