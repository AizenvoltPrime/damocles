import { describe, expect, it } from 'vitest';
import { THEMES_APPLY_MODE_SETTING as TOOLS_APPLY_MODE_SETTING } from '../../../core/pi-session/tools/theme-tools';
import { PREFERRED_LOOK_SETTINGS, SHOW_WALLPAPERS_SETTING as CORE_SHOW_WALLPAPERS_SETTING } from '../../../core/themes';
import { THEMES_STORE_SETTING as CORE_THEMES_STORE_SETTING } from '../../../core/themes/store/install';
import { THEME_APPLY_MODES } from '../../../shared/themes/agent';
import { CHARACTER_MOTIONS as SHARED_CHARACTER_MOTIONS } from '../../../shared/themes/characters';
import { TEXT_SIZE_RANGE } from '../../../shared/themes/style';
import { TOOL_GROUP_SETTINGS } from '../../../shared/types/tools';
import {
  CHARACTER_MOTION_SETTING, CHARACTER_MOTIONS, DESKTOP_CONFIGURATION, SHOW_WALLPAPERS_SETTING, TEXT_SIZE_SETTING, THEMES_AGENT_TOOLS_SETTING, THEMES_APPLY_MODE_SETTING,
  THEMES_APPLY_MODES, THEMES_DARK_SETTING, THEMES_LIGHT_SETTING, THEMES_STORE_SETTING,
} from '../desktop-configuration';

// desktop-configuration.ts imports nothing, so each value it shares with core or the shared theme model is written twice.
// These hold every such pair equal.
describe('the theme settings the desktop configuration repeats', () => {
  it('names each setting as the code that reads or writes it does', () => {
    expect(PREFERRED_LOOK_SETTINGS).toEqual({ dark: THEMES_DARK_SETTING, light: THEMES_LIGHT_SETTING });
    expect(TOOLS_APPLY_MODE_SETTING).toBe(THEMES_APPLY_MODE_SETTING);
    expect(CORE_SHOW_WALLPAPERS_SETTING).toBe(SHOW_WALLPAPERS_SETTING);
    expect(CORE_THEMES_STORE_SETTING).toBe(THEMES_STORE_SETTING);
    expect(TOOL_GROUP_SETTINGS.theme).toBe(THEMES_AGENT_TOOLS_SETTING);
  });

  it('lists the same values, in the same order, for each choice', () => {
    expect([...THEMES_APPLY_MODES]).toEqual([...THEME_APPLY_MODES]);
    expect(DESKTOP_CONFIGURATION[THEMES_APPLY_MODE_SETTING]).toMatchObject({ enum: THEME_APPLY_MODES, default: THEME_APPLY_MODES[0] });
    expect([...CHARACTER_MOTIONS]).toEqual([...SHARED_CHARACTER_MOTIONS]);
    expect(DESKTOP_CONFIGURATION[CHARACTER_MOTION_SETTING]).toMatchObject({ enum: SHARED_CHARACTER_MOTIONS });
  });

  it('declares the text size with the range and default every reader clamps to', () => {
    expect(DESKTOP_CONFIGURATION[TEXT_SIZE_SETTING]).toMatchObject({ type: 'integer', minimum: TEXT_SIZE_RANGE.min, maximum: TEXT_SIZE_RANGE.max, default: TEXT_SIZE_RANGE.default });
  });
});
