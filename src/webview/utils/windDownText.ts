import type { AgentWindDown } from '@shared/types/wind-down';

/** An extension's file name, or its folder's for an `index` entry file, which names nothing of its own. */
function extensionName(extensionPath: string): string {
  const parts = extensionPath.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? extensionPath;
  return /^index\.[cm]?[jt]s$/i.test(file) && parts.length > 1 ? parts.at(-2)! : file;
}

/** What a stopped agent's card, or the main chat's status bar, says while its run winds down, from core's reading alone. */
export function windDownText(windDown: AgentWindDown, t: (key: string, params: Record<string, unknown>) => string): string {
  const hook = windDown.hooks?.[0];
  if (hook) {
    const scope = t(hook.scope === 'user' ? 'status.windDown.userHooks' : 'status.windDown.projectHooks', {});
    return t('status.windDown.hook', { hook: hook.label, scope });
  }
  if (windDown.phase === 'settle' && windDown.extensions.length > 0) {
    return t('status.windDown.extension', { extension: windDown.extensions.map(extensionName).join(', ') });
  }
  return t(windDown.phase === 'run' ? 'status.windDown.run' : 'status.windDown.finishing', {});
}
