// The user's theme commands (docs/invariants.md "Desktop themes"): Toggle Theme, Reset Theme to Default and Undo Theme Change
// from the menu and the palette, and Settings › Appearance's actions. Core writes every theme file; main does itself only what
// must work while the engine is down (the Mode row and Reset), and it puts a theme's window arrangement in place.
import { BUILTIN_THEME_ID, DEFAULT_THEME_ID } from '../../shared/themes/builtin';
import { arrangementApplies, parseArrangement } from '../../shared/themes/arrangement';
import type { ThemeHistoryChange } from '../../shared/themes/changes';
import type { Arrangement } from '../../shared/themes/schema';
import type { LookKind } from '../../shared/themes/tokens';
import { THEME_SETTING, THEMES_DARK_SETTING, THEMES_LIGHT_SETTING, type ThemePreference } from '../local-services/desktop-configuration';
import type { OverlayThemeResult } from '../preload/overlay-channels';
import type { CoreClient } from './core-client';
import type { ThemeAction } from './overlay-settings';
import type { ShownTheme } from './themes/appearance';
import { shownChange, themeCopyName, type LibraryEntry } from './themes/theme-files';

export type ThemeCommandsClient = Pick<
  CoreClient,
  'themesHold' | 'themesSetMode' | 'themesReset' | 'themesPick' | 'themesUndo' | 'themesRestore' | 'themesDuplicate' | 'themesRename' | 'themesDelete' | 'themesSetScheduleMode'
  | 'themesSetScheduleRules' | 'themesResumeSchedule'
>;

export interface ThemeCommandsDeps {
  // this computer's core, once it is ready; undefined while the engine is down or being replaced
  client(): ThemeCommandsClient | undefined;
  readonly settings: { get<T>(key: string): T | undefined; update(key: string, value: unknown, target: 'user'): Promise<void> };
  // the look on screen without a transient preview
  shown(): Pick<ShownTheme, 'kind' | 'decidedBy'>;
  // the look without a transient preview, forced colors and safe start: what shows once those end
  decided(): Pick<ShownTheme, 'decidedBy' | 'touches'>;
  // the kind on screen, a transient preview's included
  shownKind(): LookKind;
  // the preferred look setting of a kind, as a theme id
  preferred(kind: LookKind): string;
  // main's clock for schedules
  now(): number;
  entry(themeId: string): LibraryEntry | undefined;
  selectedProject(): string | undefined;
  // this run shows the built-in look, with the banner that gives the user's theme back
  safeStart(): void;
  // the window's arrangement now, and one put in place at a density
  arrangement(): Arrangement;
  applyArrangement(arrangement: Arrangement, density?: number): void;
  // Settings closes and the editor dock opens on the theme; false when it could not
  openEditor(themeId: string): Promise<boolean>;
  revealThemeFile(themeId: string): Promise<void>;
  // the project's Project look dialog
  openProjectLook(projectKey: string): void;
  // a notification with action buttons, answered with the chosen action's index
  notice(severity: 'info' | 'warning', message: string, actions: readonly string[]): Promise<number | undefined>;
  t(message: string, ...args: string[]): string;
  log(line: string): void;
}

const ENGINE_DOWN = "This computer's Damocles engine is not running.";
// What decides the look from data only the engine writes (appearance.json, projects.json), which a Reset by main leaves standing.
const ENGINE_DECIDED: ReadonlySet<ShownTheme['decidedBy']> = new Set(['schedule', 'override', 'project']);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class ThemeCommands {
  private readonly deps: ThemeCommandsDeps;

  constructor(deps: ThemeCommandsDeps) {
    this.deps = deps;
  }

  /**
   * Toggle Theme flips the fixed mode. While the schedule decides, the preferred look of the other kind holds over it until
   * its next rule start. While the selected project's own theme decides, neither would change the screen, so nothing is
   * written and a notice offers the project's look.
   */
  async toggle(): Promise<void> {
    const { deps } = this;
    const decidedBy = deps.shown().decidedBy;
    if (decidedBy === 'project') {
      const projectKey = deps.selectedProject();
      void deps.notice('info', deps.t("This project has its own look, which decides the theme, so the title bar's theme button changed nothing."), [deps.t('Open Project Look')]).then((chosen) => {
        if (chosen === 0 && projectKey !== undefined) deps.openProjectLook(projectKey);
      }).catch((err: unknown) => deps.log(`[themes] the Toggle Theme notice failed: ${errorText(err)}`));
      return;
    }
    const other: LookKind = deps.shownKind() === 'dark' ? 'light' : 'dark';
    const client = deps.client();
    if (client && (decidedBy === 'schedule' || decidedBy === 'override')) {
      const themeId = deps.preferred(other);
      const entry = deps.entry(themeId);
      const usable = entry?.status === 'ok' && entry.theme.looks[other] !== undefined;
      await client.themesHold({ themeId: usable ? themeId : BUILTIN_THEME_ID, kind: other, at: deps.now() });
      return;
    }
    await deps.settings.update(THEME_SETTING, other, 'user');
  }

  /** The Mode row: core writes it, turning a schedule off for System; main writes the setting itself while the engine is down. */
  async setMode(mode: ThemePreference): Promise<void> {
    const client = this.deps.client();
    if (client) await client.themesSetMode({ mode });
    else await this.deps.settings.update(THEME_SETTING, mode, 'user');
  }

  /**
   * Reset Theme to Default: both preferred looks back to the default theme (DEFAULT_THEME_ID, System colors), the schedule and
   * the selected project's own look off. While the engine is down main writes the two settings itself; a look the schedule, a
   * held pick or the project still decides, or that the project's touches still change, then steps aside for this run through
   * safe start, judged from the look beneath forced colors and safe start. Where the preferred looks alone decide, the default
   * theme shows with no safe start.
   */
  async reset(): Promise<void> {
    const { deps } = this;
    const client = deps.client();
    if (client) {
      await client.themesReset(deps.selectedProject());
      return;
    }
    deps.log('[themes] the engine is not running, so main resets the preferred looks itself');
    for (const key of [THEMES_DARK_SETTING, THEMES_LIGHT_SETTING]) await deps.settings.update(key, DEFAULT_THEME_ID, 'user');
    const decided = deps.decided();
    if (!ENGINE_DECIDED.has(decided.decidedBy) && (decided.touches?.length ?? 0) === 0) return;
    deps.log('[themes] the schedule, a held pick or a project look still decides the look, which the engine writes; this run shows the Damocles look');
    deps.safeStart();
  }

  /** Undo Theme Change from the View menu or the palette; never disabled, so it says when there is nothing to undo. */
  async undoCommand(): Promise<void> {
    const { deps } = this;
    const client = deps.client();
    if (!client) {
      void deps.notice('warning', deps.t(ENGINE_DOWN), []);
      return;
    }
    const undone = await this.undo(client);
    void deps.notice('info', undone ? deps.t('The last theme change was undone.') : deps.t('There is no theme change to undo.'), []);
  }

  /** What a theme command the user ran from the menu, the palette or a shortcut does when it fails: the log and a notification. */
  failed(action: string): (err: unknown) => void {
    return (err) => {
      this.deps.log(`[themes] ${action} failed: ${errorText(err)}`);
      void this.deps.notice('warning', this.deps.t('Damocles could not change the theme: {0}', errorText(err)), []);
    };
  }

  /** A Settings › Appearance action. Only what core must write needs the engine; the rest works while it is down. */
  async act(action: ThemeAction): Promise<OverlayThemeResult> {
    const { deps } = this;
    try {
      switch (action.action) {
        case 'edit':
          return (await deps.openEditor(action.themeId)) ? { ok: true } : { ok: false, error: deps.t('Damocles could not open the theme editor.') };
        case 'showFile':
          await deps.revealThemeFile(action.themeId);
          return { ok: true };
        case 'reset':
          await this.reset();
          return { ok: true };
        case 'mode':
          await this.setMode(action.mode);
          return { ok: true };
        default:
      }
      const client = deps.client();
      if (!client) return { ok: false, error: deps.t(ENGINE_DOWN) };
      switch (action.action) {
        case 'pick':
          await this.pick(client, action.themeId, action.kind);
          return { ok: true };
        case 'duplicate': {
          const entry = deps.entry(action.themeId);
          const name = action.name ?? (entry?.status === 'ok' ? themeCopyName(action.themeId, entry.theme.name, deps) : undefined);
          if (name === undefined) return { ok: false, error: deps.t('The theme {0} is missing, broken or needs a newer Damocles.', action.themeId) };
          return { ok: true, themeId: (await client.themesDuplicate(action.themeId, name)).themeId };
        }
        case 'rename':
          await client.themesRename(action.themeId, action.name);
          return { ok: true };
        case 'delete':
          await client.themesDelete(action.themeId);
          return { ok: true };
        case 'undo': {
          const undone = await this.undo(client, action.entryId);
          return { ok: true, ...(undone ? { undone: shownChange(undone, deps) } : {}) };
        }
        case 'restore':
          await this.restore(client, action.entryId);
          return { ok: true };
        case 'scheduleMode':
          await client.themesSetScheduleMode({ choice: action.choice, showing: deps.shown().kind });
          return { ok: true };
        case 'schedule':
          await client.themesSetScheduleRules({ rules: action.rules });
          return { ok: true };
        case 'resume':
          await client.themesResumeSchedule();
          return { ok: true };
      }
    } catch (err) {
      deps.log(`[themes] ${action.action}${'themeId' in action ? ` of ${action.themeId}` : ''} failed: ${errorText(err)}`);
      return { ok: false, error: errorText(err) };
    }
  }

  // A manual pick: a theme with a window arrangement it may apply puts it in place, and Undo gives the previous one back.
  // A pick core recorded no entry for moves nothing: no Undo would give the arrangement from before back.
  // The arrangement is checked again here, as one core sends is, so main applies only what parseArrangement reads.
  private async pick(client: ThemeCommandsClient, themeId: string, kind: LookKind): Promise<void> {
    const { deps } = this;
    const entry = deps.entry(themeId);
    const theme = entry?.status === 'ok' && arrangementApplies(entry.theme) ? entry.theme : undefined;
    const layout = theme ? parseArrangement(theme.layout) : undefined;
    if (theme && !layout) deps.log(`[themes] the window arrangement of ${themeId} is not valid, so the pick leaves the window as it is`);
    const { recorded } = await client.themesPick({ themeId, kind, at: deps.now(), ...(layout ? { arrangementBefore: deps.arrangement() } : {}) });
    if (recorded && theme && layout) deps.applyArrangement(layout, theme.style?.density ?? 1);
  }

  private async undo(client: ThemeCommandsClient, expected?: string): Promise<ThemeHistoryChange | undefined> {
    const { undone, arrangement } = await client.themesUndo(expected);
    const parsed = arrangement === undefined ? undefined : parseArrangement(arrangement);
    if (parsed) this.deps.applyArrangement(parsed);
    return undone;
  }

  private async restore(client: ThemeCommandsClient, entryId: string): Promise<void> {
    const { arrangement } = await client.themesRestore({ entryId, arrangementNow: this.deps.arrangement() });
    const parsed = arrangement === undefined ? undefined : parseArrangement(arrangement);
    if (parsed) this.deps.applyArrangement(parsed);
  }
}
