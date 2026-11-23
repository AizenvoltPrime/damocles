// libadwaita's default colors, GTK's own look, from https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/css-variables.html.
import { parseHex } from '../color';
import type { LookColors } from '../schema';
import type { LookKind } from '../tokens';
import { opaqueOver } from './palette';

// GTK has no info role; libadwaita's blue, its default accent, stands in.
export const LIBADWAITA_INFO = '#3584e4';

// rgb(0 0 6 / 80%)
const TEXT_LIGHT = '#000006cc';

// The GTK3 compatibility names, references that follow the file's own definitions (libadwaita's _compat-colors.scss).
const COMPAT_COLORS: Readonly<Record<string, string>> = {
  theme_bg_color: '@window_bg_color', theme_fg_color: '@window_fg_color', theme_base_color: '@view_bg_color',
  theme_text_color: '@view_fg_color', theme_selected_bg_color: '@accent_bg_color', theme_selected_fg_color: '@accent_fg_color',
};

// The UI colors per kind.
const UI_COLORS: Readonly<Record<LookKind, Readonly<Record<string, string>>>> = {
  light: {
    window_bg_color: '#fafafb', window_fg_color: TEXT_LIGHT, view_bg_color: '#ffffff', view_fg_color: TEXT_LIGHT,
    accent_bg_color: '#3584e4', accent_fg_color: '#ffffff', accent_color: '#0461be',
    destructive_bg_color: '#e01b24', destructive_fg_color: '#ffffff', destructive_color: '#c30000',
    success_bg_color: '#2ec27e', success_fg_color: '#ffffff', success_color: '#007c3d',
    warning_bg_color: '#e5a50a', warning_fg_color: 'rgb(0 0 0 / 80%)', warning_color: '#905400',
    error_bg_color: '#e01b24', error_fg_color: '#ffffff', error_color: '#c30000',
    headerbar_bg_color: '#ffffff', headerbar_fg_color: TEXT_LIGHT, sidebar_bg_color: '#ebebed', sidebar_fg_color: TEXT_LIGHT,
    card_bg_color: '#ffffff', card_fg_color: TEXT_LIGHT, dialog_bg_color: '#fafafb', dialog_fg_color: TEXT_LIGHT,
    popover_bg_color: '#ffffff', popover_fg_color: TEXT_LIGHT,
  },
  dark: {
    window_bg_color: '#222226', window_fg_color: '#ffffff', view_bg_color: '#1d1d20', view_fg_color: '#ffffff',
    accent_bg_color: '#3584e4', accent_fg_color: '#ffffff', accent_color: '#81d0ff',
    destructive_bg_color: '#c01c28', destructive_fg_color: '#ffffff', destructive_color: '#ff938c',
    success_bg_color: '#26a269', success_fg_color: '#ffffff', success_color: '#78e9ab',
    warning_bg_color: '#cd9309', warning_fg_color: 'rgb(0 0 0 / 80%)', warning_color: '#ffc252',
    error_bg_color: '#c01c28', error_fg_color: '#ffffff', error_color: '#ff938c',
    headerbar_bg_color: '#2e2e32', headerbar_fg_color: '#ffffff', sidebar_bg_color: '#2e2e32', sidebar_fg_color: '#ffffff',
    card_bg_color: 'rgb(255 255 255 / 8%)', card_fg_color: '#ffffff', dialog_bg_color: '#36363a', dialog_fg_color: '#ffffff',
    popover_bg_color: '#36363a', popover_fg_color: '#ffffff',
  },
};

// The GNOME palette and the accent choices, the same for both kinds.
const PALETTE: Readonly<Record<string, string>> = {
  blue_1: '#99c1f1', blue_2: '#62a0ea', blue_3: '#3584e4', blue_4: '#1c71d8', blue_5: '#1a5fb4',
  green_1: '#8ff0a4', green_2: '#57e389', green_3: '#33d17a', green_4: '#2ec27e', green_5: '#26a269',
  yellow_1: '#f9f06b', yellow_2: '#f8e45c', yellow_3: '#f6d32d', yellow_4: '#f5c211', yellow_5: '#e5a50a',
  orange_1: '#ffbe6f', orange_2: '#ffa348', orange_3: '#ff7800', orange_4: '#e66100', orange_5: '#c64600',
  red_1: '#f66151', red_2: '#ed333b', red_3: '#e01b24', red_4: '#c01c28', red_5: '#a51d2d',
  purple_1: '#dc8add', purple_2: '#c061cb', purple_3: '#9141ac', purple_4: '#813d9c', purple_5: '#613583',
  brown_1: '#cdab8f', brown_2: '#b5835a', brown_3: '#986a44', brown_4: '#865e3c', brown_5: '#63452c',
  light_1: '#ffffff', light_2: '#f6f5f4', light_3: '#deddda', light_4: '#c0bfbc', light_5: '#9a9996',
  dark_1: '#77767b', dark_2: '#5e5c64', dark_3: '#3d3846', dark_4: '#241f31', dark_5: '#000000',
  accent_blue: '#3584e4', accent_teal: '#2190a4', accent_green: '#3a944a', accent_yellow: '#c88800', accent_orange: '#ed5b00',
  accent_red: '#e62d42', accent_pink: '#d56199', accent_purple: '#9141ac', accent_slate: '#6f8396',
};

/** Every color libadwaita's stylesheet defines for `kind`, by its `@define-color` name; only the compatibility names hold a reference. */
export const LIBADWAITA_COLORS: Readonly<Record<LookKind, ReadonlyMap<string, string>>> = {
  light: new Map(Object.entries({ ...PALETTE, ...UI_COLORS.light, ...COMPAT_COLORS })),
  dark: new Map(Object.entries({ ...PALETTE, ...UI_COLORS.dark, ...COMPAT_COLORS })),
};

const seedsOf = (kind: LookKind): LookColors => {
  const colors = UI_COLORS[kind];
  const background = colors['view_bg_color']!;
  const text = opaqueOver(parseHex(colors['view_fg_color']!), background)!;
  return {
    background, panel: colors['window_bg_color']!, text, accent: colors['accent_bg_color']!,
    success: colors['success_bg_color']!, warning: colors['warning_bg_color']!, danger: colors['error_bg_color']!, info: LIBADWAITA_INFO,
  };
};

/** libadwaita's look of each kind as Damocles seeds: the fills, and the view's colors as the background and text. */
export const LIBADWAITA_SEEDS: Readonly<Record<LookKind, LookColors>> = { light: seedsOf('light'), dark: seedsOf('dark') };
