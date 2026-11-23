<script lang="ts">
// How long the arrow keys rest on a pick before it is made, so a run across cards is one pick. VS Code's theme picker waits
// the same before it previews the theme the arrows moved to.
export const PICK_REST_MS = 200;
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize, useEventListener, useResizeObserver } from '@vueuse/core';
import { AlertTriangle, Clock, FileUp, History, Link, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-vue-next';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';
import { IsolatedText } from '@/components/isolated-text';
import { isolated } from '@shared/bidi-isolate';
import { remPx, spacedRemPx } from '@/composables/useRemPx';
import { BUILTIN_THEME_ID } from '@shared/themes/builtin';
import { MAX_THEME_NAME_CHARS } from '@shared/themes/limits';
import { LOOK_KINDS, type LookKind } from '@shared/themes/tokens';
import type { ThemeExportFontBytes, ThemeExportPlan } from '@shared/themes/install';
import { RESET_THEME_ACCELERATOR, type OverlayThemeAction, type OverlayThemeEntry, type OverlayThemeResult, type OverlayThemes } from '../../../../preload/overlay-channels';
import { answerOf } from '../../popup-answer';
import { acceleratorKeyshortcuts } from '../../quick-pick';
import { installedFontFile } from '../../theme-editor/installed-fonts';
import { useDesktopPrefs } from '../desktop-prefs';
import { SETTINGS_TAB, SETTINGS_TAB_INDICATOR } from '../settings-tabs';
import ThemeCard, { type CardAction, type CardPick } from './ThemeCard.vue';
import ThemeHistory from './ThemeHistory.vue';
import InstallFromLinkDialog from './InstallFromLinkDialog.vue';
import ThemeExportDialog from './ThemeExportDialog.vue';
import ThemeBrowse from './ThemeBrowse.vue';
import { useInstallCard } from './install-card';
import { changeText, failureText, restoredChangeText } from './theme-text';
import { clockOf, scheduleChoice, scheduleStatus, skippedText, whenText } from './schedule-text';

const emit = defineEmits<{ (e: 'editSchedule'): void }>();

type Mode = 'system' | 'dark' | 'light';
type OkTheme = Extract<OverlayThemeEntry, { status: 'ok' }>;
// entryId: the history entry the action made, which its toast's Undo names
type Done = Extract<OverlayThemeResult, { ok: true }> & { readonly entryId?: string };

// Past this many themes (about two screens of cards) only the rows in view are rendered.
const VIRTUALIZE_AT = 24;
const OVERSCAN_ROWS = 2;
const CARD_MIN_REM = 13.5;
// The grid's and each row's gap-3, which the row positions repeat.
const GAP_REM = 0.75;
const TOAST_MS = 8000;

const { t, locale } = useI18n();
const tab = ref<'installed' | 'browse'>('installed');
const prefs = useDesktopPrefs();
const install = useInstallCard();
const data = shallowRef<OverlayThemes>();
// why the list could not be read; the last list read stays on screen under it
const loadFailure = ref<string>();
// why the last action did not land
const failure = ref<string>();
// actions main is still carrying out; picks may overlap, so this counts them
const pending = ref(0);
const busy = computed(() => pending.value > 0);

// One read at a time, so answers land in the order they were asked for; a read asked for meanwhile runs once after it.
let wanted = false;
let reading: Promise<void> | undefined;
async function readList(): Promise<void> {
  while (wanted) {
    wanted = false;
    try {
      const answer = await answerOf(prefs.api.getThemes());
      if (!answer) continue;
      if (answer.ok) data.value = answer;
      loadFailure.value = answer.ok ? undefined : answer.error;
    } catch (err) {
      loadFailure.value = failureText(t, err, 'load');
    }
  }
  reading = undefined;
}
function load(): Promise<void> {
  wanted = true;
  reading ??= readList();
  return reading;
}
onMounted(() => void load());
onScopeDispose(prefs.api.onThemesChanged(() => void load()));

const themes = computed(() => data.value?.themes ?? []);
const nameOf = (id: string): string => themes.value.find((entry) => entry.id === id)?.name ?? id;
const okThemes = computed(() => themes.value.filter((entry): entry is OkTheme => entry.status === 'ok'));
const builtin = computed(() => okThemes.value.find((entry) => entry.builtin));

// Mode
const mode = computed<Mode>(() => {
  const value = prefs.values.value['damocles.desktop.theme'];
  return value === 'dark' || value === 'light' ? value : 'system';
});
const modeOptions = computed<{ value: Mode; label: string }[]>(() => [
  { value: 'system', label: t('settingsHost.theme.system') },
  { value: 'dark', label: t('settingsHost.theme.dark') },
  { value: 'light', label: t('settingsHost.theme.light') },
]);
const clock = computed(() => clockOf(locale.value, data.value));
// What decides the look on screen, in words, and when the preferred look of the other kind shows.
const modeStatus = computed(() => {
  const shown = data.value?.shown;
  if (!shown) return '';
  const status = baseModeStatus.value;
  return shown.touched ? `${status} ${t('settingsHost.themes.mode.touched')}` : status;
});
// Each theme name in it is marked as user text (isolated), which IsolatedText shows.
const baseModeStatus = computed(() => {
  const shown = data.value?.shown;
  if (!shown) return '';
  const name = isolated(nameOf(shown.themeId));
  const other: LookKind = shown.kind === 'dark' ? 'light' : 'dark';
  switch (shown.decidedBy) {
    case 'forcedColors':
    case 'safeStart':
      return t(`settingsHost.themes.mode.status.${shown.decidedBy}.${shown.kind}`);
    case 'project':
      return t(`settingsHost.themes.mode.status.project.${shown.kind}`, { name });
    case 'schedule':
    case 'override': {
      const schedule = data.value!.schedule;
      if (shown.until === undefined) return t(`settingsHost.themes.mode.status.${shown.decidedBy}AllWeek.${shown.kind}`, { name });
      const when = whenText(t, clock.value, shown.until, schedule.now, schedule.zone);
      return t(`settingsHost.themes.mode.status.${shown.decidedBy}.${shown.kind}`, { name, when });
    }
    default: {
      const decided = shown.decidedBy === 'mode' ? 'mode' : 'system';
      const first = t(`settingsHost.themes.mode.status.${decided}.${shown.kind}`, { name });
      const otherId = data.value?.preferred[other];
      return otherId === undefined ? first : `${first} ${t(`settingsHost.themes.mode.other.${decided}.${other}`, { name: isolated(nameOf(otherId)) })}`;
    }
  }
});

// The Schedule row: what the schedule shows and until when while it runs, and the rules it skips.
const scheduleRow = computed(() => {
  const current = data.value;
  if (!current || scheduleChoice(current) !== 'schedule') return { description: undefined, skipped: [] as string[] };
  const status = scheduleStatus(t, clock.value, current, current.schedule.now);
  return { description: `${status.text} ${t('settingsHost.rows.themeSchedule.arrangement')}`, skipped: skippedText(t, clock.value, current, current.schedule.schedule.rules) };
});
const scheduleEdit = ref<InstanceType<typeof SettingButton> | null>(null);
defineExpose({
  /** Focus back on the button that opened the schedule page. */
  focusScheduleEdit: (): void => (scheduleEdit.value?.$el as HTMLElement | undefined)?.focus(),
});

// A preferred look whose theme is not installed or cannot be used shows the built-in look of its kind.
const missing = computed(() => LOOK_KINDS.filter((kind) => {
  const id = data.value?.preferred[kind];
  if (id === undefined || id === BUILTIN_THEME_ID || themes.value.length === 0) return false;
  const entry = themes.value.find((candidate) => candidate.id === id);
  return entry?.status !== 'ok' || entry.theme.looks[kind] === undefined;
}));

// Actions
// undoEntry: the history entry the toast's Undo reverses, offered only while that entry is still the newest
const toast = shallowRef<{ readonly text: string; readonly undoEntry?: string } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string, undoEntry?: string): void {
  toast.value = { text, ...(undoEntry !== undefined ? { undoEntry } : {}) };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), TOAST_MS);
}
onScopeDispose(() => clearTimeout(toastTimer));
const newest = computed(() => data.value?.history[0]);

function failed(err: unknown): undefined {
  failure.value = failureText(t, err, 'action');
  return undefined;
}

async function act(action: OverlayThemeAction): Promise<Done | undefined> {
  pending.value += 1;
  failure.value = undefined;
  const headBefore = newest.value?.id;
  try {
    const result = await answerOf(prefs.api.themeAction(action));
    if (!result) return undefined;
    if (!result.ok) {
      failure.value = result.error;
      return undefined;
    }
    await load();
    // the entry this action recorded: a new newest entry of the user's own; anything else is not this action's to undo
    const head = newest.value;
    const made = head && head.id !== headBefore && head.actor.kind === 'user' && !head.cannotUndo ? head.id : undefined;
    return made === undefined ? result : { ...result, entryId: made };
  } catch (err) {
    return failed(err);
  } finally {
    pending.value -= 1;
  }
}

// the pick of each kind main is carrying out, so the same look asked for again meanwhile is not sent twice
const picking: Partial<Record<LookKind, string>> = {};
async function pick(kind: LookKind, themeId: string): Promise<void> {
  if ((picking[kind] ?? data.value?.preferred[kind]) === themeId) return;
  picking[kind] = themeId;
  try {
    const done = await act({ action: 'pick', themeId, kind });
    if (done) showToast(t(`settingsHost.themes.toast.pick.${kind}`, { name: isolated(nameOf(themeId)) }), done.entryId);
  } finally {
    if (picking[kind] === themeId) delete picking[kind];
  }
}

// the newest change is one this Damocles cannot reverse, so Undo could only be refused
const undoBlocked = computed(() => newest.value?.cannotUndo === true);
async function undo(entryId?: string): Promise<void> {
  if (undoBlocked.value) return;
  const result = await act(entryId === undefined ? { action: 'undo' } : { action: 'undo', entryId });
  if (!result) return;
  showToast(result.undone ? t('settingsHost.themes.toast.undid', { change: changeText(t, result.undone) }) : t('settingsHost.themes.toast.nothingToUndo'));
}
function undoFromToast(): void {
  const entryId = toast.value?.undoEntry;
  toast.value = null;
  if (entryId !== undefined) void undo(entryId);
}

async function reset(): Promise<void> {
  const done = await act({ action: 'reset' });
  if (done) showToast(t('settingsHost.themes.toast.reset'), done.entryId);
}
const resetKeys = computed(() => (prefs.platform.value === undefined ? undefined : acceleratorKeyshortcuts(RESET_THEME_ACCELERATOR, prefs.platform.value)));

// The copy's name with the theme's own name cut so that the whole of it, the word for "copy" included, fits a theme name.
function copyName(name: string): string {
  const fixed = [...t('settingsHost.themes.copyName', { name: '' })].length;
  return t('settingsHost.themes.copyName', { name: [...name].slice(0, MAX_THEME_NAME_CHARS - fixed).join('').trimEnd() });
}

// A new theme starts as a copy of Damocles and opens in the editor beside the window.
async function newTheme(): Promise<void> {
  const copy = await act({ action: 'duplicate', themeId: BUILTIN_THEME_ID, name: t('settingsHost.themes.newName') });
  if (copy?.themeId) await act({ action: 'edit', themeId: copy.themeId });
}

const renaming = shallowRef<{ readonly id: string; readonly name: string }>();
const renameValue = ref('');
const renameInput = ref<InstanceType<typeof Input> | null>(null);
const renameError = computed(() => {
  const name = renameValue.value.trim();
  if (name === '') return t('settingsHost.themes.rename.empty');
  return [...name].length > MAX_THEME_NAME_CHARS ? t('settingsHost.themes.rename.tooLong', { max: MAX_THEME_NAME_CHARS }) : undefined;
});
const renameTried = ref(false);
async function confirmRename(): Promise<void> {
  renameTried.value = true;
  const target = renaming.value;
  if (!target) return;
  if (renameError.value !== undefined) {
    (renameInput.value?.$el as HTMLInputElement | undefined)?.focus();
    return;
  }
  const name = renameValue.value.trim();
  renaming.value = undefined;
  if (name === target.name) return;
  const done = await act({ action: 'rename', themeId: target.id, name });
  if (done) showToast(t('settingsHost.themes.toast.renamed', { name: isolated(name) }), done.entryId);
}

const deleting = shallowRef<{ readonly id: string; readonly name: string }>();
const deleteText = computed(() => {
  const id = deleting.value?.id;
  if (id === undefined) return '';
  const uses = LOOK_KINDS.filter((kind) => data.value?.preferred[kind] === id);
  if (uses.length === 2) return t('settingsHost.themes.deleteDialog.inUse.both');
  return uses.length === 1 ? t(`settingsHost.themes.deleteDialog.inUse.${uses[0]!}`) : t('settingsHost.themes.deleteDialog.body');
});
async function confirmDelete(): Promise<void> {
  const target = deleting.value;
  deleting.value = undefined;
  if (!target) return;
  const done = await act({ action: 'delete', themeId: target.id });
  if (done) showToast(t('settingsHost.themes.toast.deleted', { name: isolated(target.name) }), done.entryId);
}

async function cardAction(entry: OverlayThemeEntry, action: CardAction): Promise<void> {
  const name = entry.name ?? entry.id;
  switch (action) {
    // main opens a built-in theme read-only
    case 'view':
    case 'edit':
      await act({ action: 'edit', themeId: entry.id });
      return;
    case 'duplicate': {
      const copy = await act({ action: 'duplicate', themeId: entry.id, name: copyName(name) });
      if (copy?.themeId) await act({ action: 'edit', themeId: copy.themeId });
      return;
    }
    case 'rename':
      renameValue.value = name;
      renameTried.value = false;
      renaming.value = { id: entry.id, name };
      return;
    case 'delete':
      deleting.value = { id: entry.id, name };
      return;
    case 'export':
      if (entry.status === 'ok') await startExport(entry);
      return;
    case 'showFile':
      await act({ action: 'showFile', themeId: entry.id });
      return;
    case 'update': {
      const entryId = entry.status === 'ok' ? entry.theme.origin?.store?.entryId : undefined;
      if (entryId !== undefined) await installFromStore(entryId);
    }
  }
}

// Sharing: Import, Install from link and the store end at the Settings modal's install card, as a damocles:// link does.
const importOpen = ref(false);
const linkOpen = ref(false);
const linkBusy = ref(false);
const linkFailure = ref<string>();

// The card took the place of the dialog that asked for it.
watch(() => install.preview.value?.installId, (installId) => {
  if (installId === undefined) return;
  importOpen.value = false;
  linkOpen.value = false;
});
// What the card's end says shows as this gallery's toast, which also covers a card that ended while the gallery was away.
watch(install.notice, (text) => {
  if (text === undefined) return;
  install.notice.value = undefined;
  showToast(text);
  void load();
}, { immediate: true });

async function chooseImportFile(): Promise<void> {
  failure.value = undefined;
  importOpen.value = false;
  const start = await answerOf(prefs.api.importTheme()).catch(failed);
  if (!start || ('cancelled' in start)) return;
  if (start.ok) install.open(start.preview);
  else failure.value = start.error;
}

function openLink(): void {
  linkFailure.value = undefined;
  linkOpen.value = true;
}

// the link download whose answer the dialog still waits for; closing the dialog gives it up
let linkRun = 0;
async function installFromLink(url: string): Promise<void> {
  const run = ++linkRun;
  linkBusy.value = true;
  linkFailure.value = undefined;
  try {
    const start = await answerOf(prefs.api.installFromUrl(url));
    if (run !== linkRun) {
      // the download ended before main heard the cancel, so its card is cancelled instead of shown
      if (start?.ok) await install.drop(start.preview.installId);
      return;
    }
    if (!start || 'cancelled' in start) return;
    if (start.ok) install.open(start.preview);
    else linkFailure.value = start.error;
  } catch (err) {
    if (run === linkRun) linkFailure.value = failureText(t, err, 'action');
  } finally {
    if (run === linkRun) linkBusy.value = false;
  }
}

// Cancel, Escape or a click outside during the download ends it in main, which frees the card slot it held.
function closeLink(): void {
  linkOpen.value = false;
  if (!linkBusy.value) return;
  linkRun += 1;
  linkBusy.value = false;
  prefs.api.cancelPrepare().catch(failed);
}

// Install… and Update… from Browse or a card: main downloads the pinned file, then the install card shows it.
const storeInstalling = ref<string>();
async function installFromStore(entryId: string): Promise<void> {
  if (storeInstalling.value !== undefined) return;
  storeInstalling.value = entryId;
  failure.value = undefined;
  try {
    const start = await answerOf(prefs.api.storeInstall(entryId));
    if (!start || 'cancelled' in start) return;
    if (start.ok) install.open(start.preview);
    else failure.value = start.error;
  } catch (err) {
    failed(err);
  } finally {
    storeInstalling.value = undefined;
  }
}

// Cancel on the entry being downloaded: main ends the download, and installFromStore's answer then says cancelled.
function cancelStoreInstall(): void {
  prefs.api.cancelPrepare().catch(failed);
}

// Export: the theme's installed fonts are read here (queryLocalFonts), since only this page may; core classifies their licenses.
const exporting = shallowRef<{ readonly plan: ThemeExportPlan; readonly fonts: readonly ThemeExportFontBytes[] }>();
const exportBusy = ref(false);
const exportFailure = ref<string>();

async function installedFontsOf(entry: OkTheme): Promise<ThemeExportFontBytes[]> {
  const choices = Object.values(entry.theme.style?.fonts ?? {});
  const families = [...new Set(choices.flatMap((choice) => ('installed' in choice ? [choice.installed] : [])))];
  // a font this page cannot read, or one larger than a theme bundles, is exported by name only
  const read = await Promise.all(families.map(async (family) => ({
    family,
    bytes: await installedFontFile(family).catch((err: unknown) => {
      console.error(`[themes] the installed font ${family} could not be read`, err);
      return undefined;
    }),
  })));
  return read.flatMap(({ family, bytes }) => (bytes instanceof Uint8Array ? [{ family, bytes }] : []));
}

async function startExport(entry: OkTheme): Promise<void> {
  pending.value += 1;
  failure.value = undefined;
  try {
    const fonts = await installedFontsOf(entry);
    const result = await answerOf(prefs.api.exportPlan(entry.id, fonts));
    if (!result) return;
    if (!result.ok) {
      failure.value = result.error;
      return;
    }
    exportFailure.value = undefined;
    // with no font to decide on, the save dialog is the only step
    if (result.plan.fonts.length === 0) await saveExport(result.plan, fonts);
    else exporting.value = { plan: result.plan, fonts };
  } catch (err) {
    failed(err);
  } finally {
    pending.value -= 1;
  }
}

async function saveExport(plan: ThemeExportPlan, fonts: readonly ThemeExportFontBytes[]): Promise<void> {
  exportBusy.value = true;
  exportFailure.value = undefined;
  // the export dialog shows its own failure; without it the gallery's line does
  const refused = (text: string): void => {
    if (exporting.value) exportFailure.value = text;
    else failure.value = text;
  };
  try {
    const result = await answerOf(prefs.api.exportSave(plan.themeId, fonts));
    if (!result || 'cancelled' in result) return;
    if (!result.ok) {
      refused(result.error);
      return;
    }
    exporting.value = undefined;
    showToast(t('settingsHost.themes.toast.exported', { file: result.path.split(/[\\/]/).at(-1) ?? plan.fileName }));
  } catch (err) {
    refused(failureText(t, err, 'action'));
  } finally {
    exportBusy.value = false;
  }
}

const historyOpen = ref(false);
async function restore(entryId: string): Promise<void> {
  const entry = data.value?.history.find((candidate) => candidate.id === entryId);
  historyOpen.value = false;
  if (!entry) return;
  const done = await act({ action: 'restore', entryId });
  if (done) showToast(t('settingsHost.themes.toast.restored', { change: restoredChangeText(t, entry.change) }), done.entryId);
}

// The grid: columns from its own width, and only the rows in view once there are many themes. Cards differ in height (an
// update, a removal or a broken file adds a block), so each row is placed by the measured heights of the rows above it.
const grid = ref<HTMLElement | null>(null);
const { width: gridWidth } = useElementSize(grid);
const gapPx = computed(() => spacedRemPx(GAP_REM));
const columns = computed(() => Math.max(1, Math.floor((gridWidth.value + gapPx.value) / (remPx(CARD_MIN_REM) + gapPx.value))));
const virtual = computed(() => themes.value.length > VIRTUALIZE_AT);
// key: the row's first theme, which names its element whatever index the row has
const rows = computed(() => Array.from({ length: Math.ceil(themes.value.length / columns.value) }, (_, index) => {
  const entries = themes.value.slice(index * columns.value, (index + 1) * columns.value);
  return { index, key: entries[0]!.id, entries };
}));
const rowEls = ref<HTMLElement[]>([]);
const heights = shallowRef<ReadonlyMap<string, number>>(new Map());
useResizeObserver(rowEls, (entries) => {
  let next: Map<string, number> | undefined;
  for (const entry of entries) {
    const key = (entry.target as HTMLElement).dataset['row'];
    const height = entry.contentRect.height;
    if (key === undefined || height <= 0 || heights.value.get(key) === height) continue;
    next ??= new Map(heights.value);
    next.set(key, height);
  }
  if (next) heights.value = next;
});
// a row holds other cards once the column count changes
watch(columns, () => (heights.value = new Map()));
// A row not measured yet takes the median measured height, and before any is measured a card's 16:10 miniature plus about
// 6.5rem of name, origin and picks.
const estimate = computed(() => {
  const measured = [...heights.value.values()].sort((a, b) => a - b);
  return measured[Math.floor(measured.length / 2)] ?? (gridWidth.value / columns.value) * 0.625 + remPx(6.5);
});
// tops[i] is where row i starts; the last one is where a row after the last would
const tops = computed(() => {
  const out = [0];
  for (const row of rows.value) out.push(out.at(-1)! + (heights.value.get(row.key) ?? estimate.value) + gapPx.value);
  return out;
});
const rowTop = (index: number): number => tops.value[index]!;
const rowBottom = (index: number): number => tops.value[index + 1]! - gapPx.value;
const scroller = shallowRef<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewHeight = ref(0);
const listTop = ref(0);
function measure(): void {
  const element = scroller.value;
  const list = grid.value;
  if (!element || !list) return;
  scrollTop.value = element.scrollTop;
  viewHeight.value = element.clientHeight;
  listTop.value = list.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
}
// the row holding keyboard focus, which stays rendered wherever the grid scrolls
const focusedRow = ref<string>();
watch(grid, (element) => {
  let parent = element?.parentElement ?? null;
  while (parent && !['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
  scroller.value = parent;
  if (!element) focusedRow.value = undefined;
  measure();
}, { flush: 'post' });
useEventListener(scroller, 'scroll', measure, { passive: true });
useResizeObserver(scroller, measure);
function rowFocused(event: FocusEvent): void {
  focusedRow.value = (event.target as HTMLElement).closest<HTMLElement>('[data-row]')?.dataset['row'];
}
function rowBlurred(event: FocusEvent): void {
  if (!(event.relatedTarget instanceof Node) || !grid.value?.contains(event.relatedTarget)) focusedRow.value = undefined;
}
const rowRange = computed(() => {
  const count = rows.value.length;
  if (!virtual.value) return { start: 0, end: count };
  const top = scrollTop.value - listTop.value;
  const bottom = top + viewHeight.value;
  let first = 0;
  while (first < count && rowBottom(first) <= top) first += 1;
  let last = first;
  while (last < count && rowTop(last) < bottom) last += 1;
  return { start: Math.max(0, first - OVERSCAN_ROWS), end: Math.min(count, last + OVERSCAN_ROWS) };
});
const renderedRows = computed(() => {
  const { start, end } = rowRange.value;
  const inView = rows.value.slice(start, end);
  const focused = focusedRow.value === undefined ? undefined : rows.value.find((row) => row.key === focusedRow.value);
  if (!focused || (focused.index >= start && focused.index < end)) return inView;
  return focused.index < start ? [focused, ...inView] : [...inView, focused];
});
const rendered = computed(() => renderedRows.value.flatMap((row) => row.entries));
const listStyle = computed(() => (virtual.value ? { height: `${Math.max(0, rowBottom(rows.value.length - 1))}px` } : undefined));
const rowStyle = (index: number): Record<string, string> => ({
  gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))`,
  ...(virtual.value ? { top: `${rowTop(index)}px` } : {}),
});

// Scrolls the least distance that shows the theme's row whole.
function reveal(themeId: string): void {
  const element = scroller.value;
  const index = themes.value.findIndex((entry) => entry.id === themeId);
  if (!element || index < 0) return;
  measure();
  const row = Math.floor(index / columns.value);
  const top = listTop.value + rowTop(row);
  const bottom = listTop.value + rowBottom(row);
  if (top < element.scrollTop) element.scrollTop = top;
  else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
  measure();
}

// A card's element ids. A usable theme's id is a UUID or a built-in's name; one that cannot be read is named by its folder,
// which is data, so it gets a number instead.
const unusableKeys = new Map<string, string>();
function domKey(entry: OverlayThemeEntry): string {
  if (entry.status === 'ok') return entry.id;
  const known = unusableKeys.get(entry.id);
  if (known !== undefined) return known;
  const key = `unusable-${unusableKeys.size + 1}`;
  unusableKeys.set(entry.id, key);
  return key;
}
const pickId = (kind: LookKind, entry: OverlayThemeEntry): string => `theme-pick-${kind}-${domKey(entry)}`;

// The two radio groups: every pick of a kind, across cards, in gallery order. A theme without that look has none; one that
// cannot be used keeps its picks as disabled radios, which no key moves to.
const groupMembers = (kind: LookKind): OkTheme[] => okThemes.value.filter((entry) => entry.theme.looks[kind] !== undefined);
const renderedIds = computed(() => new Set(rendered.value.map((entry) => entry.id)));
const tabbable = computed(() => Object.fromEntries(LOOK_KINDS.map((kind) => {
  const members = groupMembers(kind).filter((entry) => renderedIds.value.has(entry.id));
  const checked = members.find((entry) => entry.id === data.value?.preferred[kind]);
  return [kind, (checked ?? members[0])?.id];
})) as Record<LookKind, string | undefined>);
const owns = (kind: LookKind): string => rendered.value.filter((entry) => entry.status !== 'ok' || entry.theme.looks[kind] !== undefined).map((entry) => pickId(kind, entry)).join(' ');

function picksOf(entry: OverlayThemeEntry): Record<LookKind, CardPick> {
  const shown = data.value?.shown;
  return Object.fromEntries(LOOK_KINDS.map((kind) => [kind, {
    checked: data.value?.preferred[kind] === entry.id,
    showing: shown?.themeId === entry.id && shown.kind === kind,
    tabbable: tabbable.value[kind] === entry.id,
  }])) as Record<LookKind, CardPick>;
}

// the pick of each kind the arrow keys came to, made once they rest
const resting: Partial<Record<LookKind, ReturnType<typeof setTimeout>>> = {};
onScopeDispose(() => LOOK_KINDS.forEach((kind) => clearTimeout(resting[kind])));

// A click, Enter or Space picks at once, in place of whatever the arrow keys were about to pick.
function choose(kind: LookKind, themeId: string): void {
  clearTimeout(resting[kind]);
  void pick(kind, themeId);
}

// Arrow keys move within a group across cards and the pick follows focus, as in a radio group; a run of them is one pick.
function pickKey(entry: OverlayThemeEntry, kind: LookKind, event: KeyboardEvent): void {
  const members = groupMembers(kind);
  const index = members.findIndex((member) => member.id === entry.id);
  if (index < 0) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    choose(kind, entry.id);
    return;
  }
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
  const target = event.key === 'Home' ? members[0] : event.key === 'End' ? members.at(-1) : step === undefined ? undefined : members[(index + step + members.length) % members.length];
  if (!target) return;
  event.preventDefault();
  // a held key moves nothing: each press is one step
  if (event.repeat) return;
  reveal(target.id);
  void nextTick(() => document.getElementById(pickId(kind, target))?.focus());
  clearTimeout(resting[kind]);
  resting[kind] = setTimeout(() => void pick(kind, target.id), PICK_REST_MS);
}
</script>

<template>
  <SettingsRow id="damocles.desktop.theme">
    <template #note>
      <p
        v-if="modeStatus"
        class="mt-1 text-12 text-(--d-muted)"
        role="status"
        data-testid="theme-mode-status"
      >
        <IsolatedText :text="modeStatus" />
      </p>
    </template>
    <SettingSeg
      :model-value="mode"
      :options="modeOptions"
      :label="t('settingsHost.rows.theme.label')"
      @update:model-value="(value) => prefs.set('damocles.desktop.theme', value)"
    />
  </SettingsRow>
  <SettingsRow id="theme-gallery">
    <template #expand>
      <div
        class="flex w-full basis-full flex-col gap-2"
        data-testid="theme-gallery"
      >
        <div
          v-for="kind in missing"
          :key="kind"
          class="sm-banner sm-banner-warning"
          role="note"
          :data-testid="`theme-missing-${kind}`"
        >
          <AlertTriangle
            class="size-4 text-(--d-warning-text)"
            aria-hidden="true"
          />
          <span class="sm-banner-text">{{ t(`settingsHost.themes.missing.${kind}`) }}</span>
        </div>
        <Tabs
          v-model="tab"
          class="gap-2"
        >
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <TabsList
              :aria-label="t('settingsHost.themes.tabs.label')"
              class="relative h-auto w-fit justify-start gap-1 rounded-none border-b border-(--d-border) bg-transparent p-0"
            >
              <TabsTrigger
                value="installed"
                :class="SETTINGS_TAB"
                data-testid="theme-tab-installed"
              >
                {{ t('settingsHost.themes.installed') }}
                <span
                  class="font-normal text-(--d-faint-text)"
                  data-testid="theme-installed-count"
                >{{ themes.length }}</span>
              </TabsTrigger>
              <TabsTrigger
                value="browse"
                :class="SETTINGS_TAB"
                data-testid="theme-tab-browse"
              >
                {{ t('settingsHost.themes.tabs.browse') }}
              </TabsTrigger>
              <TabsIndicator :class="SETTINGS_TAB_INDICATOR" />
            </TabsList>
            <div
              v-if="tab === 'installed'"
              class="ms-auto flex flex-wrap gap-1.5"
            >
              <SettingButton
                variant="primary"
                :disabled="busy || !builtin"
                @click="newTheme"
              >
                <Plus
                  class="size-3"
                  aria-hidden="true"
                />{{ t('settingsHost.themes.newTheme') }}
              </SettingButton>
              <SettingButton
                aria-haspopup="dialog"
                :disabled="busy"
                data-testid="theme-import"
                @click="importOpen = true"
              >
                <FileUp
                  class="size-3"
                  aria-hidden="true"
                />{{ t('settingsHost.themes.import.open') }}
              </SettingButton>
              <SettingButton
                aria-haspopup="dialog"
                :disabled="busy"
                data-testid="theme-install-link"
                @click="openLink"
              >
                <Link
                  class="size-3"
                  aria-hidden="true"
                />{{ t('settingsHost.themes.link.open') }}
              </SettingButton>
              <!-- aria-disabled, so the reason in its title stays reachable -->
              <SettingButton
                :disabled="busy || !data"
                :aria-disabled="undoBlocked ? 'true' : undefined"
                :title="undoBlocked ? t('settingsHost.themes.undoBlocked') : undefined"
                data-testid="theme-undo"
                @click="undo()"
              >
                <Undo2
                  class="size-3"
                  aria-hidden="true"
                />{{ t('settingsHost.themes.undo') }}
              </SettingButton>
              <SettingButton
                aria-haspopup="dialog"
                :disabled="!data"
                data-testid="theme-history-open"
                @click="historyOpen = true"
              >
                <History
                  class="size-3"
                  aria-hidden="true"
                />{{ t('settingsHost.themes.history.open') }}
              </SettingButton>
              <SettingButton
                :disabled="busy"
                :aria-keyshortcuts="resetKeys"
                data-testid="theme-reset"
                @click="reset"
              >
                <RotateCcw
                  class="size-3"
                  aria-hidden="true"
                />{{ t('settingsHost.themes.reset') }}
              </SettingButton>
            </div>
          </div>
          <p
            v-if="failure ?? (data ? loadFailure : undefined)"
            class="sm-feedback sm-feedback-error"
            role="alert"
            data-testid="theme-error"
          >
            {{ failure ?? loadFailure }}
          </p>
          <TabsContent
            value="installed"
            class="flex flex-col gap-2"
          >
            <div
              v-if="!data && loadFailure"
              class="flex flex-col items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-4 py-8 text-center"
              data-testid="theme-load-failed"
            >
              <AlertTriangle
                class="size-6 text-(--d-warning-text)"
                aria-hidden="true"
              />
              <p
                class="max-w-md text-12 text-(--d-muted)"
                role="alert"
              >
                {{ loadFailure }}
              </p>
              <SettingButton
                data-testid="theme-load-retry"
                @click="load"
              >
                {{ t('settingsHost.themes.failed.retry') }}
              </SettingButton>
            </div>
            <div
              role="radiogroup"
              class="sr-only"
              :aria-label="t('settingsHost.themes.groups.dark')"
              :aria-owns="owns('dark')"
            />
            <div
              role="radiogroup"
              class="sr-only"
              :aria-label="t('settingsHost.themes.groups.light')"
              :aria-owns="owns('light')"
            />
            <div
              ref="grid"
              :class="virtual ? 'relative' : 'flex flex-col gap-3'"
              :style="listStyle"
              data-testid="theme-grid"
              @focusin="rowFocused"
              @focusout="rowBlurred"
            >
              <div
                v-for="row in renderedRows"
                :key="row.key"
                ref="rowEls"
                class="grid gap-3"
                :class="virtual && 'absolute inset-x-0'"
                :style="rowStyle(row.index)"
                :data-row="row.key"
              >
                <ThemeCard
                  v-for="entry in row.entries"
                  :key="entry.id"
                  :entry="entry"
                  :dom-key="domKey(entry)"
                  :picks="picksOf(entry)"
                  :busy="busy || storeInstalling !== undefined"
                  @pick="(kind) => choose(kind, entry.id)"
                  @pick-key="(kind, event) => pickKey(entry, kind, event)"
                  @action="(action) => cardAction(entry, action)"
                />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="browse">
            <ThemeBrowse
              :installing="storeInstalling"
              @install="installFromStore"
              @cancel-install="cancelStoreInstall"
              @install-from-link="openLink"
            />
          </TabsContent>
        </Tabs>
        <!-- the one live region: it is here before its toast, which is how a screen reader comes to announce it -->
        <div
          class="sticky bottom-2 flex min-h-0 justify-center"
          aria-live="polite"
        >
          <div
            v-if="toast"
            class="flex max-w-full items-center gap-3 rounded-10 border border-(--d-border2) bg-(--d-card) px-3 py-2 text-12 shadow-(--d-shadow)"
            data-testid="theme-toast"
          >
            <span><IsolatedText :text="toast.text" /></span>
            <SettingButton
              v-if="toast.undoEntry !== undefined && toast.undoEntry === newest?.id"
              :disabled="busy"
              data-testid="theme-toast-undo"
              @click="undoFromToast"
            >
              {{ t('settingsHost.themes.toast.undo') }}
            </SettingButton>
          </div>
        </div>
      </div>
    </template>
  </SettingsRow>

  <SettingsRow
    id="theme-schedule"
    :description="scheduleRow.description"
  >
    <template #note>
      <p
        v-for="line in scheduleRow.skipped"
        :key="line"
        class="mt-1 flex items-center gap-1.5 text-12 text-(--d-warning-text)"
        role="note"
        data-testid="theme-schedule-skipped"
      >
        <AlertTriangle
          class="size-3.5 flex-none"
          aria-hidden="true"
        /><IsolatedText :text="line" />
      </p>
    </template>
    <SettingButton
      ref="scheduleEdit"
      data-testid="theme-schedule-edit"
      @click="emit('editSchedule')"
    >
      <Clock
        class="size-3"
        aria-hidden="true"
      />{{ t('settingsHost.rows.themeSchedule.edit') }}
    </SettingButton>
  </SettingsRow>

  <Dialog v-model:open="importOpen">
    <DialogContent
      class="max-w-120 gap-3"
      data-testid="theme-import-dialog"
    >
      <DialogTitle class="text-13">
        {{ t('settingsHost.themes.import.title') }}
      </DialogTitle>
      <DialogDescription class="text-12 text-pretty text-(--d-muted)">
        {{ t('settingsHost.themes.import.body') }}
      </DialogDescription>
      <div class="mt-1 flex justify-end gap-2">
        <SettingButton @click="importOpen = false">
          {{ t('settingsHost.themes.cancel') }}
        </SettingButton>
        <SettingButton
          variant="primary"
          data-testid="theme-import-choose"
          @click="chooseImportFile"
        >
          <FileUp
            class="size-3"
            aria-hidden="true"
          />{{ t('settingsHost.themes.import.choose') }}
        </SettingButton>
      </div>
    </DialogContent>
  </Dialog>

  <InstallFromLinkDialog
    :open="linkOpen"
    :busy="linkBusy"
    :failure="linkFailure"
    @update:open="(open: boolean) => { if (open) linkOpen = true; else closeLink() }"
    @submit="installFromLink"
    @edited="linkFailure = undefined"
  />

  <ThemeExportDialog
    :plan="exporting?.plan"
    :busy="exportBusy"
    :failure="exportFailure"
    @save="exporting && saveExport(exporting.plan, exporting.fonts)"
    @close="exporting = undefined"
  />

  <ThemeHistory
    v-model:open="historyOpen"
    :entries="data?.history ?? []"
    :busy="busy"
    @restore="restore"
  />

  <Dialog
    :open="renaming !== undefined"
    @update:open="(open: boolean) => { if (!open) renaming = undefined }"
  >
    <DialogContent
      class="max-w-120 gap-3"
      data-testid="theme-rename"
    >
      <DialogTitle class="text-13">
        {{ t('settingsHost.themes.rename.title') }}
      </DialogTitle>
      <DialogDescription class="sr-only">
        {{ t('settingsHost.themes.rename.hint', { max: MAX_THEME_NAME_CHARS }) }}
      </DialogDescription>
      <form
        class="flex flex-col gap-1.5"
        @submit.prevent="confirmRename"
      >
        <Label
          for="theme-rename-input"
          class="text-12"
        >{{ t('settingsHost.themes.rename.name') }}</Label>
        <Input
          id="theme-rename-input"
          ref="renameInput"
          v-model="renameValue"
          class="h-8 text-12.5"
          autocomplete="off"
          :aria-invalid="renameTried && renameError !== undefined ? 'true' : undefined"
          :aria-describedby="'theme-rename-hint'"
        />
        <p
          id="theme-rename-hint"
          class="text-11"
          :class="renameTried && renameError ? 'text-(--d-danger-text)' : 'text-(--d-muted)'"
          :role="renameTried && renameError ? 'alert' : undefined"
        >
          {{ renameTried && renameError ? renameError : t('settingsHost.themes.rename.hint', { max: MAX_THEME_NAME_CHARS }) }}
        </p>
        <div class="mt-1 flex justify-end gap-2">
          <SettingButton @click="renaming = undefined">
            {{ t('settingsHost.themes.cancel') }}
          </SettingButton>
          <SettingButton
            type="submit"
            variant="primary"
          >
            {{ t('settingsHost.themes.rename.confirm') }}
          </SettingButton>
        </div>
      </form>
    </DialogContent>
  </Dialog>

  <AlertDialog
    :open="deleting !== undefined"
    @update:open="(open: boolean) => { if (!open) deleting = undefined }"
  >
    <AlertDialogContent
      class="max-w-md gap-0 overflow-hidden border-(--d-danger-fill)/50 p-0"
      data-testid="theme-delete"
    >
      <ConfirmDialogLayout
        :icon="Trash2"
        tone="danger"
        danger
        :title="t('settingsHost.themes.deleteDialog.title', { name: isolated(deleting?.name ?? '') })"
        :description="deleteText"
        :confirm-label="t('settingsHost.themes.delete')"
        :cancel-label="t('settingsHost.themes.cancel')"
        @confirm="confirmDelete"
        @cancel="deleting = undefined"
      />
    </AlertDialogContent>
  </AlertDialog>
</template>
