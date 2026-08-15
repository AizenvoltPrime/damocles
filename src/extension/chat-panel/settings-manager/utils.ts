import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { log } from "../../logger";
import type { PermissionUpdate, PermissionRuleValue, PermissionUpdateDestination } from "../../../shared/types/permissions";
import { DEFAULT_MODELS, DEFAULT_CONTEXT_WINDOW } from "../../../shared/types/constants";
import type { EffortLevel } from "../../../shared/types/settings";

const settingsWriteQueue = new Map<string, Promise<void>>();

/** The permission arrays a rule may be filed under; also the guard against a hostile `behavior`. */
const PERMISSION_BEHAVIORS: readonly string[] = ["allow", "deny", "ask"];

/**
 * Serialise writes to one path so two concurrent read-modify-writes cannot interleave and lose the
 * earlier mutation. Keyed on the path, so unrelated files never block each other. A rejecting
 * `writeFn` does not break the chain — the next write is still run.
 *
 * Exported for the MCP writer (`managers/mcp-config-write.ts`): every Damocles-owned settings file
 * must share this one queue, or the guarantee is only as strong as the queue a caller happened to use.
 */
export async function queueSettingsWrite(
  settingsPath: string,
  writeFn: () => Promise<void>
): Promise<void> {
  const pending = settingsWriteQueue.get(settingsPath) ?? Promise.resolve();
  const newPromise = pending.then(writeFn, writeFn);
  settingsWriteQueue.set(settingsPath, newPromise);
  // Drop the entry once it is the last one queued for this path, so the map tracks in-flight writes
  // rather than every path ever written to.
  void newPromise.catch(() => {}).finally(() => {
    if (settingsWriteQueue.get(settingsPath) === newPromise) settingsWriteQueue.delete(settingsPath);
  });
  return newPromise;
}

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

export function getContextWindowForModel(modelId: string): number {
  if (/\[1m\]/.test(modelId)) {
    return 1_000_000;
  }
  const modelInfo = DEFAULT_MODELS.find(m => m.value === modelId);
  return modelInfo?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

export async function updateConfigAtEffectiveScope<T>(
  section: string,
  key: string,
  value: T
): Promise<void> {
  const config = vscode.workspace.getConfiguration(section);
  const inspection = config.inspect<T>(key);
  const folders = vscode.workspace.workspaceFolders;
  const isSingleRoot = folders !== undefined && folders.length === 1;

  let target: vscode.ConfigurationTarget;
  if (isSingleRoot && inspection?.workspaceFolderValue !== undefined) {
    target = vscode.ConfigurationTarget.WorkspaceFolder;
  } else if (inspection?.workspaceValue !== undefined) {
    target = vscode.ConfigurationTarget.Workspace;
  } else {
    target = vscode.ConfigurationTarget.Global;
  }

  await config.update(key, value, target);
}

function formatPermissionPattern(rule: PermissionRuleValue): string {
  if (rule.ruleContent) {
    return `${rule.toolName}(${rule.ruleContent})`;
  }
  return rule.toolName;
}

/** Returns `null` for `'session'`: a session-scoped rule lives in memory and must never be persisted. */
function getSettingsPathForDestination(
  destination: PermissionUpdateDestination,
  workspacePath: string | null
): string | null {
  switch (destination) {
    case 'userSettings':
      return path.join(os.homedir(), ".damocles", "settings.json");
    case 'projectSettings':
      if (workspacePath) {
        return path.join(workspacePath, ".damocles", "settings.json");
      }
      return path.join(os.homedir(), ".damocles", "settings.local.json");
    case 'localSettings':
      if (workspacePath) {
        return path.join(workspacePath, ".damocles", "settings.local.json");
      }
      return path.join(os.homedir(), ".damocles", "settings.local.json");
    case 'session':
      return null;
    default: {
      const unhandled: never = destination;
      throw new Error(`Unhandled permission destination: ${String(unhandled)}`);
    }
  }
}

/**
 * One settings file as a plain object, or `{}` if it is absent, malformed or not an object.
 *
 * The shape check is load-bearing, not defensive typing: `JSON.parse` happily returns `null` for a
 * file containing `null` (a truncating editor, a hand-edit), and the caller immediately indexes the
 * result — which throws, and that throw used to strand the tool call waiting on the approval. The
 * sibling reader in `permission-handler/permission-settings.ts` makes the same check.
 */
async function readSettingsFromPath(settingsPath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await fs.promises.readFile(settingsPath, "utf-8");
  } catch {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log(`[PermissionSettings] ${settingsPath} does not contain a JSON object; starting from an empty one`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    log(`[PermissionSettings] ${settingsPath} is not valid JSON; starting from an empty one`);
    return {};
  }
}

export async function syncPermissionRulesToSettings(
  updates: PermissionUpdate[],
  workspacePath: string | null
): Promise<void> {
  for (const update of updates) {
    if (update.type !== 'addRules') continue;

    // `behavior` indexes an object below, and it arrives off a webview message. Left unchecked,
    // `__proto__` writes the prototype instead of a key and `constructor` puts junk in the user's
    // settings. `destination` two functions up gets an exhaustive check; this deserves the same.
    if (!PERMISSION_BEHAVIORS.includes(update.behavior)) {
      log(`[PermissionSettings] Ignoring permission update with unknown behavior "${String(update.behavior)}"`);
      continue;
    }

    const settingsPath = getSettingsPathForDestination(update.destination, workspacePath);
    if (settingsPath === null) continue;

    // Per-update, so one unwritable destination cannot silently abandon the rules after it.
    try {
      await queueSettingsWrite(settingsPath, async () => {
        const settings = await readSettingsFromPath(settingsPath);

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

        await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
        // Trailing newline, matching `mcp-config-write.ts` and POSIX convention for a text file.
        await fs.promises.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
        log(`[PermissionSettings] Wrote permissions to ${settingsPath}`);
      });
    } catch (err) {
      log(`[PermissionSettings] Failed to write ${settingsPath}: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }
}
