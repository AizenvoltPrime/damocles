import type { Component } from 'vue';
import {
  Activity,
  Bot,
  Bug,
  Cloud,
  Code,
  Container,
  Cpu,
  Database,
  DollarSign,
  Fish,
  FlaskConical,
  Flame,
  Gauge,
  GitBranch,
  Globe,
  Heart,
  Monitor,
  Package,
  Percent,
  Rocket,
  Server,
  Sparkles,
  SquareChevronRight,
  SquareTerminal,
  Star,
  Terminal,
  Wrench,
  Zap,
} from 'lucide-vue-next';
import { TERMINAL_COLORS, type TerminalColor, type TerminalCustomIcon, type TerminalGlyph, type TerminalIcon, type TerminalInfo } from '../../preload/terminal-channels';

// Each shell's glyph and --d-* colour: PowerShell's chevron in info blue, Git Bash in Git's warm hue, the Unix shells by their prompt.
export const TERMINAL_ICON: Readonly<Record<TerminalIcon, { readonly icon: Component; readonly color: string }>> = {
  powershell: { icon: SquareChevronRight, color: 'var(--d-info)' },
  cmd: { icon: SquareTerminal, color: 'var(--d-muted)' },
  'git-bash': { icon: GitBranch, color: 'var(--d-warning)' },
  wsl: { icon: Container, color: 'var(--d-success)' },
  bash: { icon: DollarSign, color: 'var(--d-success)' },
  zsh: { icon: Percent, color: 'var(--d-accent)' },
  fish: { icon: Fish, color: 'var(--d-accent)' },
  shell: { icon: Terminal, color: 'var(--d-muted)' },
};

// Change Icon...'s curated set, drawn in the terminal's colour or the muted text colour.
const CUSTOM_ICON: Readonly<Record<TerminalCustomIcon, Component>> = {
  terminal: Terminal,
  'square-terminal': SquareTerminal,
  code: Code,
  bug: Bug,
  rocket: Rocket,
  server: Server,
  database: Database,
  cloud: Cloud,
  container: Container,
  package: Package,
  'git-branch': GitBranch,
  globe: Globe,
  cpu: Cpu,
  monitor: Monitor,
  'flask-conical': FlaskConical,
  activity: Activity,
  gauge: Gauge,
  zap: Zap,
  flame: Flame,
  sparkles: Sparkles,
  star: Star,
  heart: Heart,
  wrench: Wrench,
  bot: Bot,
};

const isProfileIcon = (glyph: TerminalGlyph): glyph is TerminalIcon => Object.hasOwn(TERMINAL_ICON, glyph);

/** A Change Color... hue as the style.css tint that keeps 3:1 against the panels in both themes. */
export function colorTint(color: TerminalColor): string {
  return `var(--terminal-tint-${TERMINAL_COLORS.indexOf(color)})`;
}

/** A glyph in `color`, else in its profile's own colour (a custom icon's is the muted text colour). */
export function glyphLook(glyph: TerminalGlyph, color?: TerminalColor | null): { readonly icon: Component; readonly color: string } {
  if (color) return { icon: isProfileIcon(glyph) ? TERMINAL_ICON[glyph].icon : CUSTOM_ICON[glyph], color: colorTint(color) };
  return isProfileIcon(glyph) ? TERMINAL_ICON[glyph] : { icon: CUSTOM_ICON[glyph], color: 'var(--d-muted)' };
}

/** What a terminal's row and tab draw: its custom icon or its profile's, in its colour or the glyph's own. */
export function terminalGlyph(terminal: Pick<TerminalInfo, 'icon' | 'customIcon' | 'color'>): { readonly icon: Component; readonly color: string } {
  return glyphLook(terminal.customIcon ?? terminal.icon, terminal.color);
}
