import { describe, expect, it } from 'vitest';
import { inputChunks, parseAccelerator, terminalKeyAction } from '../terminal/terminal-keys';
import { terminalProfilesModel, terminalProjectsModel } from '../overlay/quick-pick';
import { glyphLook } from '../terminal/terminal-icons';
import type { TerminalProfileOption } from '../../preload/terminal-channels';

const key = (code: string, mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>> = {}): KeyboardEvent =>
  ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe('terminal keys', () => {
  const pass = ['CmdOrCtrl+P', 'CmdOrCtrl+Shift+P', 'Ctrl+`', 'F6', 'Shift+F6'].map((accelerator) => parseAccelerator(accelerator, false)!);

  it('parses accelerators into the chord they fire on the platform', () => {
    expect(parseAccelerator('CmdOrCtrl+Shift+P', false)).toEqual({ ctrl: true, shift: true, alt: false, meta: false, code: 'KeyP' });
    expect(parseAccelerator('CmdOrCtrl+P', true)).toEqual({ ctrl: false, shift: false, alt: false, meta: true, code: 'KeyP' });
    expect(parseAccelerator('Ctrl+`', false)?.code).toBe('Backquote');
    expect(parseAccelerator('CmdOrCtrl+,', false)?.code).toBe('Comma');
    expect(parseAccelerator('Ctrl+Hyper+P', false)).toBeUndefined();
  });

  it('passes only the skip list to the app on Windows and Linux; Ctrl+K and Ctrl+C without a selection reach the pty', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(terminalKeyAction(key('KeyP', { ctrlKey: true }), platform, false, pass)).toBe('pass');
      expect(terminalKeyAction(key('KeyP', { ctrlKey: true, shiftKey: true }), platform, false, pass)).toBe('pass');
      expect(terminalKeyAction(key('F6'), platform, false, pass)).toBe('pass');
      expect(terminalKeyAction(key('KeyK', { ctrlKey: true }), platform, false, pass)).toBeUndefined();
      expect(terminalKeyAction(key('KeyC', { ctrlKey: true }), platform, false, pass)).toBeUndefined();
      expect(terminalKeyAction(key('KeyB', { ctrlKey: true, shiftKey: true }), platform, false, pass)).toBeUndefined();
    }
  });

  it('copies and pastes with Ctrl+Shift+C and V, finds with Ctrl+F, and leaves every Cmd chord to macOS', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(terminalKeyAction(key('KeyC', { ctrlKey: true, shiftKey: true }), platform, true, pass)).toBe('copy');
      expect(terminalKeyAction(key('KeyV', { ctrlKey: true, shiftKey: true }), platform, false, pass)).toBe('paste');
      expect(terminalKeyAction(key('KeyF', { ctrlKey: true }), platform, false, pass)).toBe('find');
    }
    expect(terminalKeyAction(key('KeyF', { metaKey: true }), 'darwin', false, pass)).toBe('find');
    expect(terminalKeyAction(key('KeyC', { metaKey: true }), 'darwin', true, pass)).toBe('pass');
    expect(terminalKeyAction(key('KeyC', { ctrlKey: true }), 'darwin', true, pass)).toBeUndefined();
  });

  // VS Code's Windows bindings (CopyAndClearSelection, Paste); Linux keeps Ctrl+C as SIGINT and Ctrl+V as a literal next.
  it('copies and clears a selection with Ctrl+C and pastes with Ctrl+V on Windows only', () => {
    expect(terminalKeyAction(key('KeyC', { ctrlKey: true }), 'win32', true, pass)).toBe('copyAndClear');
    expect(terminalKeyAction(key('KeyV', { ctrlKey: true }), 'win32', false, pass)).toBe('paste');
    expect(terminalKeyAction(key('KeyC', { ctrlKey: true }), 'linux', true, pass)).toBeUndefined();
    expect(terminalKeyAction(key('KeyV', { ctrlKey: true }), 'linux', false, pass)).toBeUndefined();
  });

  it('splits a paste under the input bound without splitting a surrogate pair', () => {
    expect(inputChunks('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(inputChunks('abc😀d', 4)).toEqual(['abc', '😀d']);
    expect(inputChunks('', 4)).toEqual([]);
    expect(inputChunks('x'.repeat(65_536 * 2 + 1)).map((chunk) => chunk.length)).toEqual([65_536, 65_536, 1]);
  });
});

describe('new-terminal quick pick', () => {
  const profiles: TerminalProfileOption[] = [
    { id: 'pwsh', name: 'PowerShell', path: 'C:/pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: false },
    { id: 'cmd', name: 'Command Prompt', path: 'C:/cmd.exe', args: [], source: 'detected', icon: 'cmd', customIcon: null, color: null, isDefault: true },
    { id: 'user:Dev', name: 'Developer PowerShell', path: 'C:/pwsh.exe', args: ['-NoExit'], source: 'user', icon: 'powershell', customIcon: 'wrench', color: 'magenta', isDefault: false },
  ];
  const labels = { isDefault: 'Default', current: 'Current' };

  it('lists the default profile first and marks it', () => {
    const rows = terminalProfilesModel(profiles, '', labels).rows.flatMap((row) => (row.kind === 'item' ? [row.item] : []));
    expect(rows.map((item) => [item.id, item.badge])).toEqual([['cmd', 'Default'], ['pwsh', undefined], ['user:Dev', undefined]]);
  });

  it('draws a user profile with its own icon in its colour', () => {
    const rows = terminalProfilesModel(profiles, '', labels).rows.flatMap((row) => (row.kind === 'item' ? [row.item] : []));
    const user = rows.find((item) => item.id === 'user:Dev')!;
    expect(user.icon).toBe(glyphLook('wrench').icon);
    expect(user.iconColor).toBe('var(--terminal-tint-5)');
  });

  it('filters profiles and projects by name', () => {
    expect(terminalProfilesModel(profiles, 'developer', labels).rows).toHaveLength(1);
    const projects = [{ key: 'a', name: 'alpha', path: '/a', current: true }, { key: 'b', name: 'beta', path: '/b', current: false }];
    const items = terminalProjectsModel(projects, '', labels).rows.flatMap((row) => (row.kind === 'item' ? [row.item] : []));
    expect(items.map((item) => [item.id, item.badge])).toEqual([['a', 'Current'], ['b', undefined]]);
    expect(terminalProjectsModel(projects, 'bet', labels).rows).toHaveLength(1);
  });
});
