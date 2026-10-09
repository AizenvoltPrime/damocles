import { describe, expect, it } from 'vitest';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import { TERMINAL_COLORS, TERMINAL_CUSTOM_ICONS, type TerminalColor, type TerminalCustomIcon, type TerminalProfileOption } from '../../preload/terminal-channels';
import { pickDefaultProfile, pickTerminalColor, pickTerminalIcon, type TerminalAppearance } from '../terminal-pick';

function overlay(answer: OverlayAnswer) {
  const requests: OverlayRequest[] = [];
  return { requests, request: (request: OverlayRequest) => { requests.push(request); return Promise.resolve(answer); } };
}

const APPEARANCE: TerminalAppearance = { icon: 'powershell', customIcon: 'rocket', color: 'green' };
const ICONS = Object.fromEntries(TERMINAL_CUSTOM_ICONS.map((icon) => [icon, `Icon ${icon}`])) as Record<TerminalCustomIcon, string>;
const COLORS = Object.fromEntries(TERMINAL_COLORS.map((color) => [color, color.toUpperCase()])) as Record<TerminalColor, string>;

describe('terminal quick picks', () => {
  it('offers the profile icon and every curated icon in the terminal\'s color, the current one marked', async () => {
    const fake = overlay({ kind: 'quickPick', itemId: 'bug' });
    expect(await pickTerminalIcon(fake, APPEARANCE, { placeholder: 'Icon', profileIcon: 'Default', icons: ICONS }, undefined)).toEqual({ customIcon: 'bug' });
    const request = fake.requests[0] as Extract<OverlayRequest, { kind: 'quickPick' }>;
    expect(request.items).toHaveLength(TERMINAL_CUSTOM_ICONS.length + 1);
    expect(request.items[0]).toEqual({ id: 'default', label: 'Default', glyph: 'powershell', color: 'green', current: false });
    expect(request.items.filter((item) => item.current).map((item) => item.id)).toEqual(['rocket']);
    expect(request.items.find((item) => item.id === 'flask-conical')?.label).toBe('Icon flask-conical');
    expect(request.items.every((item) => item.color === 'green')).toBe(true);
    expect(await pickTerminalIcon(overlay({ kind: 'quickPick', itemId: 'default' }), APPEARANCE, { placeholder: 'Icon', profileIcon: 'Default', icons: ICONS }, undefined)).toEqual({ customIcon: null });
    expect(await pickTerminalIcon(overlay({ kind: 'dismissed' }), APPEARANCE, { placeholder: 'Icon', profileIcon: 'Default', icons: ICONS }, undefined)).toBeUndefined();
  });

  it('offers no color and the eight hues, each row showing the terminal\'s icon', async () => {
    const fake = overlay({ kind: 'quickPick', itemId: 'magenta' });
    expect(await pickTerminalColor(fake, APPEARANCE, { placeholder: 'Color', noColor: 'No color', colors: COLORS }, undefined)).toEqual({ color: 'magenta' });
    const request = fake.requests[0] as Extract<OverlayRequest, { kind: 'quickPick' }>;
    expect(request.items.map((item) => [item.id, item.label, item.color ?? null, item.glyph, item.current])).toEqual([
      ['default', 'No color', null, 'rocket', false],
      ...TERMINAL_COLORS.map((color) => [color, color.toUpperCase(), color, 'rocket', color === 'green']),
    ]);
    expect(await pickTerminalColor(overlay({ kind: 'quickPick', itemId: 'default' }), APPEARANCE, { placeholder: 'Color', noColor: 'No color', colors: COLORS }, undefined)).toEqual({ color: null });
  });

  it('offers the listed profiles with their paths, a user profile in its icon and color, the default marked, and nothing without any', async () => {
    const detected = { args: [], source: 'detected', customIcon: null, color: null } as const;
    const profiles: TerminalProfileOption[] = [
      { id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', icon: 'powershell', isDefault: false, ...detected },
      { id: 'wsl:Ubuntu', name: 'Ubuntu', path: 'C:\\wsl.exe', icon: 'wsl', isDefault: true, ...detected },
      { id: 'user:Dev', name: 'Dev', path: 'C:\\ps.exe', args: ['-NoExit'], source: 'user', icon: 'powershell', customIcon: 'code', color: 'magenta', isDefault: false },
    ];
    const fake = overlay({ kind: 'quickPick', itemId: 'wsl:Ubuntu' });
    expect(await pickDefaultProfile(fake, profiles, 'Profile', undefined)).toBe('wsl:Ubuntu');
    expect(fake.requests[0]).toEqual({
      kind: 'quickPick',
      placeholder: 'Profile',
      items: [
        { id: 'pwsh', label: 'PowerShell', description: 'C:\\pwsh.exe', glyph: 'powershell', current: false },
        { id: 'wsl:Ubuntu', label: 'Ubuntu', description: 'C:\\wsl.exe', glyph: 'wsl', current: true },
        { id: 'user:Dev', label: 'Dev', description: 'C:\\ps.exe', glyph: 'code', color: 'magenta', current: false },
      ],
    });
    const none = overlay({ kind: 'dismissed' });
    expect(await pickDefaultProfile(none, [], 'Profile', undefined)).toBeUndefined();
    expect(none.requests).toEqual([]);
  });
});
