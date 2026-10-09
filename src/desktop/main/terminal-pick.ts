import type { WebContents } from 'electron';
import { MAX_OVERLAY_ITEMS, type OverlayAnswer, type OverlayQuickPickItem, type OverlayRequest } from '../preload/overlay-channels';
import {
  TERMINAL_COLORS,
  TERMINAL_CUSTOM_ICONS,
  type TerminalColor,
  type TerminalCustomIcon,
  type TerminalIcon,
  type TerminalProfileOption,
  type TerminalProjectOption,
} from '../preload/terminal-channels';

export interface TerminalPickOverlay {
  request(request: OverlayRequest, returnFocus: WebContents | undefined): Promise<OverlayAnswer>;
}

export interface TerminalPick {
  readonly profileId: string;
  readonly projectKey: string;
}

/**
 * New Terminal's quick pick in the overlay: a profile, then a project (skipped with one project, or by Shift on a profile).
 * Resolves the choice, which parseOverlayAnswer has checked is one the request offered, or undefined for Escape.
 */
export async function pickNewTerminal(
  overlay: TerminalPickOverlay,
  profiles: readonly TerminalProfileOption[],
  projects: readonly TerminalProjectOption[],
  returnFocus: WebContents | undefined,
): Promise<TerminalPick | undefined> {
  if (profiles.length === 0 || projects.length === 0) return undefined;
  const request: OverlayRequest = { kind: 'newTerminal', profiles: profiles.slice(0, MAX_OVERLAY_ITEMS), projects: projects.slice(0, MAX_OVERLAY_ITEMS) };
  const answer = await overlay.request(request, returnFocus);
  return answer.kind === 'newTerminal' ? { profileId: answer.profileId, projectKey: answer.projectKey } : undefined;
}

// The quick pick row that clears a custom icon or color; no icon or color has this name.
const DEFAULT_ITEM = 'default';

export interface TerminalAppearance {
  // the profile's icon, shown when there is no custom one
  readonly icon: TerminalIcon;
  readonly customIcon: TerminalCustomIcon | null;
  readonly color: TerminalColor | null;
}

// The chosen item's id, which parseOverlayAnswer has checked the request offered; undefined for Escape.
async function quickPick(overlay: TerminalPickOverlay, placeholder: string, items: OverlayQuickPickItem[], returnFocus: WebContents | undefined): Promise<string | undefined> {
  const answer = await overlay.request({ kind: 'quickPick', placeholder, items }, returnFocus);
  return answer.kind === 'quickPick' ? answer.itemId : undefined;
}

/** Change Icon...: the profile's icon (null) or a custom one, each drawn in the terminal's color; undefined for Escape. */
export async function pickTerminalIcon(
  overlay: TerminalPickOverlay,
  appearance: TerminalAppearance,
  labels: { readonly placeholder: string; readonly profileIcon: string; readonly icons: Readonly<Record<TerminalCustomIcon, string>> },
  returnFocus: WebContents | undefined,
): Promise<{ readonly customIcon: TerminalCustomIcon | null } | undefined> {
  const tint = appearance.color === null ? {} : { color: appearance.color };
  const items: OverlayQuickPickItem[] = [
    { id: DEFAULT_ITEM, label: labels.profileIcon, glyph: appearance.icon, ...tint, current: appearance.customIcon === null },
    ...TERMINAL_CUSTOM_ICONS.map((icon) => ({ id: icon, label: labels.icons[icon], glyph: icon, ...tint, current: icon === appearance.customIcon })),
  ];
  const picked = await quickPick(overlay, labels.placeholder, items, returnFocus);
  if (picked === undefined) return undefined;
  return { customIcon: TERMINAL_CUSTOM_ICONS.find((icon) => icon === picked) ?? null };
}

/** Change Color...: no color (null) or one of the eight hues, each row showing the terminal's icon in it; undefined for Escape. */
export async function pickTerminalColor(
  overlay: TerminalPickOverlay,
  appearance: TerminalAppearance,
  labels: { readonly placeholder: string; readonly noColor: string; readonly colors: Readonly<Record<TerminalColor, string>> },
  returnFocus: WebContents | undefined,
): Promise<{ readonly color: TerminalColor | null } | undefined> {
  const glyph = appearance.customIcon ?? appearance.icon;
  const items: OverlayQuickPickItem[] = [
    { id: DEFAULT_ITEM, label: labels.noColor, glyph, current: appearance.color === null },
    ...TERMINAL_COLORS.map((color) => ({ id: color, label: labels.colors[color], glyph, color, current: color === appearance.color })),
  ];
  const picked = await quickPick(overlay, labels.placeholder, items, returnFocus);
  if (picked === undefined) return undefined;
  return { color: TERMINAL_COLORS.find((color) => color === picked) ?? null };
}

/** Select Default Profile: one of the listed profiles (a user profile in its icon and color), the current default marked; undefined for Escape. */
export async function pickDefaultProfile(
  overlay: TerminalPickOverlay,
  profiles: readonly TerminalProfileOption[],
  placeholder: string,
  returnFocus: WebContents | undefined,
): Promise<string | undefined> {
  if (profiles.length === 0) return undefined;
  const items = profiles.slice(0, MAX_OVERLAY_ITEMS).map((profile): OverlayQuickPickItem => ({
    id: profile.id,
    label: profile.name,
    description: profile.path,
    glyph: profile.customIcon ?? profile.icon,
    ...(profile.color !== null ? { color: profile.color } : {}),
    current: profile.isDefault,
  }));
  return quickPick(overlay, placeholder, items, returnFocus);
}
