import * as fs from 'node:fs';
import * as path from 'node:path';
import { vi } from 'vitest';
import type { SettingsStore } from '../../../platform/settings-store';
import type { LookColors, ThemeFile } from '../../../shared/themes/schema';
import type { LookKind } from '../../../shared/themes/tokens';
import type { DraftBody, ThemeDraft } from '../drafts';
import type { ThemeService } from '../index';

export const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const COLORS: LookColors = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
// this app among those that share the themes folder, as a countdown's mark names it
export const OWNER: string = 'a'.repeat(32);
export const AGENT = { kind: 'agent', chatId: 'chat-a', title: 'Make it warm' } as const;

export const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

export const themeJson = (id: string, name = 'Night'): Record<string, unknown> => ({ schemaVersion: 1, id, name, looks: { dark: { colors: COLORS } } });

/** The user's edit of one look's colors, saved as the theme editor saves it: the whole theme. */
export async function recolor(themes: ThemeService, id: string, kind: LookKind, colors: LookColors): Promise<void> {
  const entry = (await themes.list()).find((candidate) => candidate.id === id);
  if (entry?.status !== 'ok') throw new Error(`No theme ${id} to recolor`);
  await themes.saveTheme(id, { ...entry.theme, looks: { ...entry.theme.looks, [kind]: { ...entry.theme.looks[kind], colors } } });
}

export function writeTheme(root: string, id: string, json: unknown = themeJson(id)): string {
  const file = path.join(root, 'themes', id, 'theme.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  return file;
}

/** A settings store over one user settings file, as the desktop store writes it. */
export function fileSettings(settingsFile: string): SettingsStore {
  const read = (): Record<string, unknown> => (fs.existsSync(settingsFile) ? readJson(settingsFile) : {});
  return {
    get: (key: string) => read()[key],
    inspect: () => ({}),
    update: async (key: string, value: unknown) => {
      fs.writeFileSync(settingsFile, JSON.stringify({ ...read(), [key]: value }));
    },
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? settingsFile : undefined),
  } as unknown as SettingsStore;
}

/** A draft as the store wrote it: its first revision. */
export const storedDraft = (themes: Pick<ThemeService, 'drafts'>, body: DraftBody): Promise<ThemeDraft> => themes.drafts.put(body, null);

export const draftOf = (id: string, themeId: string, name = 'Fresh'): DraftBody => ({
  id,
  owner: { authority: 'local', sessionId: AGENT.chatId, toolCallId: 'call-1' },
  createdAt: 1,
  baseThemeId: null,
  baseHash: null,
  theme: themeJson(themeId, name) as unknown as ThemeFile,
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected failure`), { code });

/** Fails every replacement of a file `matches` names, as a full disk would, until restored. */
export function failWrites(matches: (file: string) => boolean, code = 'ENOSPC'): { restore(): void } {
  const rename = fs.promises.rename.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (matches(String(to))) throw errno(code);
    return rename(from, to);
  });
  return { restore: () => spy.mockRestore() };
}

/** Fails every read of a file `matches` names, as a scanner holding it would, until restored. */
export function failReads(matches: (file: string) => boolean, code = 'EBUSY'): { restore(): void } {
  const readFile = fs.promises.readFile.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
  const open = fs.promises.open.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
  const reading = (flags: unknown): boolean => flags === undefined || flags === 'r';
  const spies = [
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...args: unknown[]) => {
      if (typeof args[0] === 'string' && matches(args[0])) throw errno(code);
      return readFile(...args);
    }) as never),
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: unknown[]) => {
      if (typeof args[0] === 'string' && reading(args[1]) && matches(args[0])) throw errno(code);
      return open(...args);
    }) as never),
  ];
  return { restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

export const named = (name: string) => (file: string): boolean => path.basename(file) === name;
