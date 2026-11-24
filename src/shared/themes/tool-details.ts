// Reads the persisted `details` of a theme tool result, which another version or a remote host may have written. Apart from
// agent.ts, so a bundle that takes only that file's constants does not take the theme schema.
import { THEME_TOOLS } from '../tool-names';
import { THEME_CAPTURE_REFUSALS, THEME_OUTCOMES, type ThemeLaterChange, type ThemeToolDetails } from './agent';
import { parseThemeActor, parseThemeHistoryChange } from './changes';
import { USER_THEME_ID } from './limits';
import { validateTheme } from './schema';
import { LOOK_KINDS } from './tokens';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function laterChangeOf(raw: unknown): ThemeLaterChange | undefined {
  if (!isRecord(raw)) return undefined;
  const change = parseThemeHistoryChange(raw['change']);
  const actor = parseThemeActor(raw['actor']);
  return change && actor && typeof raw['at'] === 'number' ? { change, actor, at: raw['at'] } : undefined;
}

/**
 * What ThemeToolCard renders of a result's details: undefined unless `tool` names a theme tool, and each field only when it has
 * the shape the card reads, so an outcome, change or theme this Damocles does not know leaves the card plain.
 */
export function parseThemeToolDetails(raw: unknown): ThemeToolDetails | undefined {
  if (!isRecord(raw)) return undefined;
  const { tool, outcome, themeName, looks, note, undone, laterChange, droppedCss, droppedCssMore, theme, screenshot, shotRefused, useArrangement } = raw;
  if (typeof tool !== 'string' || !THEME_TOOLS.has(tool)) return undefined;
  const checked = isRecord(theme) ? validateTheme(theme, { builtin: typeof theme['id'] === 'string' && !USER_THEME_ID.test(theme['id']) }) : undefined;
  const undoneChange = parseThemeHistoryChange(undone);
  const later = laterChangeOf(laterChange);
  return {
    tool: tool as ThemeToolDetails['tool'],
    ...((THEME_OUTCOMES as readonly unknown[]).includes(outcome) ? { outcome: outcome as ThemeToolDetails['outcome'] & string } : {}),
    ...(typeof themeName === 'string' ? { themeName } : {}),
    ...(Array.isArray(looks) ? { looks: LOOK_KINDS.filter((kind) => looks.includes(kind)) } : {}),
    ...(typeof note === 'string' ? { note } : {}),
    ...(undoneChange ? { undone: undoneChange } : {}),
    ...(later ? { laterChange: later } : {}),
    ...(Array.isArray(droppedCss) ? { droppedCss: droppedCss as NonNullable<ThemeToolDetails['droppedCss']> } : {}),
    ...(typeof droppedCssMore === 'number' && Number.isSafeInteger(droppedCssMore) && droppedCssMore > 0 ? { droppedCssMore } : {}),
    ...(checked?.ok === true ? { theme: checked.theme } : {}),
    ...(screenshot === 'sent' || screenshot === 'denied' ? { screenshot } : {}),
    ...((THEME_CAPTURE_REFUSALS as readonly unknown[]).includes(shotRefused) ? { shotRefused: shotRefused as NonNullable<ThemeToolDetails['shotRefused']> } : {}),
    ...(useArrangement === true ? { useArrangement } : {}),
  };
}
