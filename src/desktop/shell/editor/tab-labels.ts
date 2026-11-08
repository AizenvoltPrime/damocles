import type { ShellEditorTab, ShellHost, ShellProject } from '../../preload/shell-channels';
import { parseRootKey } from '../../preload/folder-root';

/** The name of the host a tab's file is on, or undefined for this computer's. */
export function tabHostName(tab: Pick<ShellEditorTab, 'host' | 'projectKey'>, projects: readonly ShellProject[], hosts: readonly ShellHost[]): string | undefined {
  const projectKey = parseRootKey(tab.projectKey)?.projectKey;
  const authority = tab.host ?? projects.find((project) => project.key === projectKey)?.authority.key;
  if (authority === undefined || authority === 'local') return undefined;
  return hosts.find((host) => host.authorityKey === authority)?.name ?? projects.find((project) => project.authority.key === authority)?.authority.name;
}

// Tabs that are no file of a path, so no description tells them apart.
const PATHLESS: ReadonlySet<ShellEditorTab['kind']> = new Set(['untitled', 'changes', 'review', 'timeline', 'merge', 'browser', 'terminal']);

const foldersOf = (displayPath: string): string[] => displayPath.split(/[\\/]+/).filter((segment) => segment !== '').slice(0, -1);
const separatorOf = (displayPath: string): string => (displayPath.includes('\\') && !displayPath.startsWith('/') ? '\\' : '/');

/**
 * VS Code's labels for same-named tabs: a tab whose title another open file tab shares gets a description, its host's name
 * (thisComputer for this computer's) when the two are on different hosts, then the shortest trailing run of its folders no
 * same-named tab on its host ends with. Tabs with a title of their own get none.
 */
export function tabDescriptions(tabs: readonly ShellEditorTab[], hostName: (tab: ShellEditorTab) => string | undefined, thisComputer: string): Map<string, string> {
  const groups = new Map<string, ShellEditorTab[]>();
  for (const tab of tabs) {
    if (PATHLESS.has(tab.kind) || tab.browser) continue;
    groups.set(tab.title, [...(groups.get(tab.title) ?? []), tab]);
  }
  const descriptions = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const hostOf = new Map(group.map((tab) => [tab.id, hostName(tab)]));
    const mixedHosts = new Set(hostOf.values()).size > 1;
    for (const tab of group) {
      const parts: string[] = [];
      if (mixedHosts) parts.push(hostOf.get(tab.id) ?? thisComputer);
      const folders = foldersOf(tab.displayPath);
      const others = group.filter((other) => other.id !== tab.id && hostOf.get(other.id) === hostOf.get(tab.id)).map((other) => foldersOf(other.displayPath).join('\0'));
      if (others.length > 0) {
        const suffixes = (length: number) => folders.slice(-length);
        const length = [...folders.keys()].map((index) => index + 1).find((count) => others.every((other) => !`\0${other}`.endsWith(`\0${suffixes(count).join('\0')}`)));
        if (length !== undefined) parts.push(suffixes(length).join(separatorOf(tab.displayPath)));
      }
      if (parts.length > 0) descriptions.set(tab.id, parts.join(' · '));
    }
  }
  return descriptions;
}
