<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, Check, Copy, Eye, Lock, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-vue-next';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import { IsolatedText } from '@/components/isolated-text';
import { isolated } from '@shared/bidi-isolate';
import ThemeMiniature from '@/components/theme/ThemeMiniature.vue';
import { lookPalette } from '@/components/theme/theme-view';
import { ColorPicker } from '@/components/ui/color-picker';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { MENU_CONTENT, MENU_ITEM } from '@/components/chat-header/menuStyles';
import { canonicalHexColor, type HexColor } from '@shared/hex-color';
import type { ThemeShowRefusal } from '@shared/themes/agent';
import { BUILTIN_THEME, SYSTEM_THEME_ID } from '@shared/themes/builtin';
import { AA, checkPalette } from '@shared/themes/contrast';
import { themeCssFamilies } from '@shared/themes/css-sanitizer';
import { deriveLookDetails, type SeedMove } from '@shared/themes/derive';
import { MAX_THEME_AUTHOR_CHARS, MAX_THEME_DESCRIPTION_CHARS, MAX_THEME_LICENSE_CHARS, MAX_THEME_NAME_CHARS, MAX_THEME_VERSION_CHARS } from '@shared/themes/limits';
import { CSS_REGIONS, LOOK_SEEDS, validateTheme, type Arrangement, type CssRegion, type Look, type ThemeError, type ThemeFile } from '@shared/themes/schema';
import type { CssDroppedPart } from '@shared/themes/css-types';
import { LOOK_KINDS, type LookKind, type TokenName } from '@shared/themes/tokens';
import type { DamoclesOverlayApi, ThemeEditorOutside, ThemeEditorSession } from '../../../preload/overlay-channels';
import { failureText } from '../settings/themes/theme-text';
import { heldSet, withCharacterSet, type HeldSet } from './character-edits';
import { colorWarnings, type ColorWarning, type Seed } from './colors';
import { createEditorImports } from './editor-imports';
import { stableStringify, useEditorFormat } from './format';
import { forgetInstalledFonts } from './installed-fonts';
import TokenTable from './TokenTable.vue';
import TypeSection from './TypeSection.vue';
import WallpapersSection from './WallpapersSection.vue';
import CssSection from './CssSection.vue';
import CharactersSection from './CharactersSection.vue';
import { pinChoices, pinEdits, validPins, type PinChoice } from './pins';

// The theme editor docked beside the window (docs/desktop-app.md "Appearance"): trusted UI in the palette saved before
// editing, while every edit paints the window as a transient preview. Nothing of the draft outlives the dock. The section
// tabs unmount the section that hides, so everything a session must keep, and every call to main, lives here.
const props = defineProps<{ api: DamoclesOverlayApi }>();

type Section = 'colors' | 'type' | 'wallpapers' | 'css' | 'characters' | 'arrangement' | 'details';
const PREVIEW_MS = 80;
const DETAIL_LIMITS = { author: MAX_THEME_AUTHOR_CHARS, version: MAX_THEME_VERSION_CHARS } as const;

const { t } = useI18n();
const format = useEditorFormat();
const session = shallowRef<ThemeEditorSession | null>(null);
const draft = shallowRef<ThemeFile>(BUILTIN_THEME);
// the theme as its file holds it, as stableStringify writes it
const saved = ref('');
const look = ref<LookKind>('dark');
// the wallpaper set the Wallpapers section edits, which the preview shows; each look starts at its first
const wallpaperSet = ref(0);
const section = ref<Section>('colors');
const comparing = ref(false);
const saving = ref(false);
const duplicating = ref(false);
const capturing = ref(false);
const failure = ref<string>();
const justSaved = ref(false);
const fix = shallowRef<{ readonly kind: LookKind; readonly seed: Seed; readonly before: string; readonly text: string } | { readonly text: string } | null>(null);
watch(look, () => {
  wallpaperSet.value = 0;
  fix.value = null;
});
const pickerOpen = ref<Seed>();
// What core removed from the CSS at the last save; the CSS section shows it until the CSS, or a font it may name, changes.
const savedDropped = shallowRef<{ readonly parts: readonly CssDroppedPart[]; readonly more: number }>();
const advancedOpen = ref(false);
// The character set a pick of another set, or of none, replaced, until the set is edited again.
const replacedSet = shallowRef<{ readonly held: HeldSet; readonly text: string } | { readonly text: string } | null>(null);
// The window arrangement the file holds, and the one the draft held when its switch went off, which on puts back.
const storedLayout = shallowRef<Arrangement>();
const heldLayout = shallowRef<Arrangement>();
// Cancel with unsaved edits, or main asked to move the dock to another theme: the page asks before the draft goes.
const asking = ref<'close' | 'move'>();
// The theme's file changed, or went, outside the editor.
const outside = ref<ThemeEditorOutside>();
// Why the window paints no preview: a contrast theme or safe start picks its look.
const refused = ref<ThemeShowRefusal | null>(null);
// A chat card's Show in window took the window: the dock previews nothing until its next edit sends a preview again.
const takenOver = ref(false);
// Each project's pin for this theme as projects.json held it, and as the Characters section has it now; Save writes the difference.
const pinsSaved = shallowRef<Readonly<Record<string, PinChoice>>>({});
const pinsNow = shallowRef<Readonly<Record<string, PinChoice>>>({});
// core keeps no pin of a character the theme lacks, so the section shows such a pin as automatic and Save clears it
const pinsShown = computed(() => validPins(pinsNow.value, draft.value.characters));
const pendingPins = computed(() => pinEdits(pinsSaved.value, pinsShown.value));
function setPin(key: string, choice: PinChoice): void {
  if (readOnly.value) return;
  pinsNow.value = { ...pinsShown.value, [key]: choice };
  justSaved.value = false;
}

const imports = createEditorImports({ api: props.api, sessionId: () => session.value?.sessionId, draft: () => draft.value, edit, t });
onScopeDispose(props.api.themeEditor.onImportProgress((fraction) => imports.progress(fraction)));

function load(next: ThemeEditorSession): void {
  // the session it holds, with System colors' new looks: the look tab and the section stay
  if (session.value?.sessionId === next.sessionId && next.builtin) {
    session.value = next;
    draft.value = next.theme;
    saved.value = stableStringify(next.theme);
    return;
  }
  forgetInstalledFonts();
  imports.reset();
  session.value = next;
  draft.value = next.theme;
  saved.value = stableStringify(next.theme);
  look.value = next.theme.looks[next.kind] ? next.kind : LOOK_KINDS.find((kind) => next.theme.looks[kind]) ?? 'dark';
  wallpaperSet.value = 0;
  section.value = 'colors';
  storedLayout.value = next.theme.layout;
  heldLayout.value = undefined;
  comparing.value = false;
  saving.value = false;
  duplicating.value = false;
  capturing.value = false;
  failure.value = undefined;
  justSaved.value = false;
  fix.value = null;
  savedDropped.value = undefined;
  replacedSet.value = null;
  asking.value = undefined;
  outside.value = undefined;
  refused.value = null;
  takenOver.value = false;
  pinsSaved.value = pinChoices(next.pins, next.themeId, (next.projects ?? []).map((project) => project.key));
  pinsNow.value = pinsSaved.value;
}
void props.api.themeEditor.getSession().then((current) => {
  if (current && session.value === null) load(current);
});
onScopeDispose(props.api.themeEditor.onSession(load));
onScopeDispose(props.api.themeEditor.onOutside((what) => {
  outside.value = what;
}));

const readOnly = computed(() => session.value?.builtin !== false);
// A built-in's name comes from main in the UI's language; System colors' description is Damocles' own text too
const name = computed(() => session.value?.shownName ?? draft.value.name);
const description = computed(() => (session.value?.themeId === SYSTEM_THEME_ID ? t('settingsHost.themes.system.description') : draft.value.description ?? ''));
const dirty = computed(() => stableStringify(draft.value) !== saved.value || pinEdits(pinsSaved.value, pinsNow.value).length > 0);
const kinds = computed(() => LOOK_KINDS.filter((kind) => draft.value.looks[kind] !== undefined));
const missingKind = computed(() => LOOK_KINDS.find((kind) => draft.value.looks[kind] === undefined));
const currentLook = computed<Look | undefined>(() => draft.value.looks[look.value]);
const lookOptions = computed(() => kinds.value.map((kind) => ({ value: kind, label: t(`themeEditor.look.${kind}`) })));
const miniMode = computed(() => (kinds.value.length === 2 ? 'split' : kinds.value[0] ?? 'dark'));
const miniLabel = computed(() => t(`settingsHost.themes.miniature.${kinds.value.length === 2 ? 'both' : kinds.value[0] ?? 'dark'}`, { name: name.value || t('themeEditor.untitled') }));

const subtitle = computed(() => {
  const current = session.value;
  if (!current) return '';
  if (current.builtin) return t('themeEditor.subtitle.builtin');
  const origin = current.fromName !== undefined ? t('settingsHost.themes.origin.copyOf', { name: isolated(current.fromName) }) : t('settingsHost.themes.origin.created');
  if (dirty.value) return t('themeEditor.subtitle.unsaved', { origin });
  return justSaved.value ? t('themeEditor.subtitle.saved', { origin }) : origin;
});

// Validity: the draft is checked as main and core check it. Save stays focusable and names the first error, and both move
// focus to its field; the window previews nothing of a draft that is no valid theme.
interface DraftError {
  readonly text: string;
  readonly section: Section;
  // the id of the field to fix, when the error is one field's
  readonly field?: string;
}
const cssRegionOf = (path: string): CssRegion | undefined => CSS_REGIONS.find((region) => path === `/css/${region}`);
function draftError(error: ThemeError): DraftError {
  const { path } = error;
  if (path === '/name') {
    const value = draft.value.name;
    const text = value.trim() === '' ? t('themeEditor.errors.nameEmpty') : [...value].length > MAX_THEME_NAME_CHARS ? t('themeEditor.errors.nameLong', { max: MAX_THEME_NAME_CHARS }) : t('themeEditor.errors.nameOneLine');
    return { text, section: 'details', field: 'theme-editor-name' };
  }
  if (path === '/license') return { text: t('themeEditor.errors.license'), section: 'details', field: 'theme-editor-license' };
  for (const [key, max] of [['author', MAX_THEME_AUTHOR_CHARS], ['version', MAX_THEME_VERSION_CHARS], ['description', MAX_THEME_DESCRIPTION_CHARS]] as const) {
    if (path === `/${key}`) return { text: t('themeEditor.errors.detailLong', { field: t(`themeEditor.details.${key}`), max }), section: 'details', field: `theme-editor-${key}` };
  }
  const region = cssRegionOf(path);
  if (region) return { text: t('themeEditor.errors.cssLong', { region: t(`themeEditor.css.regions.${region}`) }), section: 'css' };
  for (const role of ['ui', 'mono'] as const) {
    if (path === `/style/fonts/${role}`) return { text: t('themeEditor.errors.font', { font: t(`themeEditor.type.font.${role}`) }), section: 'type', field: `theme-type-${role}-font` };
  }
  const part: Section = path.startsWith('/characters') ? 'characters' : path.startsWith('/layout') ? 'arrangement' : path.startsWith('/style') ? 'type' : path.startsWith('/css') ? 'css' : path.startsWith('/looks') || path.startsWith('/assets') ? 'colors' : 'details';
  return { text: t('themeEditor.errors.other', { path }), section: part };
}
const errors = computed<DraftError[]>(() => {
  const current = session.value;
  if (!current || readOnly.value) return [];
  const result = validateTheme(draft.value, { folder: current.themeId });
  if (result.ok) return [];
  const byText = new Map(result.errors.map(draftError).map((error) => [error.text, error]));
  return [...byText.values()];
});
const fieldError = (id: string): string | undefined => errors.value.find((error) => error.field === id)?.text;
const errorSummary = computed(() => (errors.value.length === 0 ? '' : t('themeEditor.fixErrors', { count: errors.value.length, error: errors.value[0]!.text }, errors.value.length)));

const cssFamilies = (theme: ThemeFile): string => JSON.stringify(themeCssFamilies(theme));
function edit(next: ThemeFile): void {
  if (readOnly.value) return;
  const before = draft.value;
  failure.value = undefined;
  justSaved.value = false;
  if (next.characters !== before.characters) replacedSet.value = null;
  const last = fix.value;
  // an Undo fix that would overwrite a value set since is no undo of the fix
  if (last && (!('seed' in last) || next.looks[last.kind]?.colors[last.seed] !== before.looks[last.kind]?.colors[last.seed])) fix.value = null;
  if (savedDropped.value && (next.css !== before.css || cssFamilies(next) !== cssFamilies(before))) savedDropped.value = undefined;
  draft.value = next;
}
function setLook(kind: LookKind, next: Look | undefined): void {
  const looks = { ...draft.value.looks };
  if (next) looks[kind] = next;
  else delete looks[kind];
  edit({ ...draft.value, looks });
}
function setSeed(seed: Seed, value: string): void {
  const current = currentLook.value;
  if (current) setLook(look.value, { ...current, colors: { ...current.colors, [seed]: value.toLowerCase() } });
}
function setToken(token: TokenName, value: string | undefined): void {
  const current = currentLook.value;
  if (!current) return;
  const tokens: Partial<Record<TokenName, string>> = { ...current.tokens };
  if (value === undefined) delete tokens[token];
  else tokens[token] = value;
  const rest: Record<string, unknown> = { ...current };
  delete rest['tokens'];
  setLook(look.value, (Object.keys(tokens).length > 0 ? { ...rest, tokens } : rest) as unknown as Look);
}
function setDetail(key: 'name' | 'description' | 'author' | 'version' | 'license', value: string): void {
  const next: Record<string, unknown> = { ...draft.value, [key]: value };
  if (key !== 'name' && value.trim() === '') delete next[key];
  edit(next as unknown as ThemeFile);
}

// Colors
const warnings = computed<ColorWarning[]>(() => (currentLook.value ? colorWarnings(currentLook.value.colors) : []));
const seedLabel = (seed: Seed): string => t(`settingsHost.themes.seeds.${seed}`);
const surfaceLabel = (surface: 'background' | 'panel'): string => t(`settingsHost.themes.seeds.${surface}`);
const warningText = (warning: ColorWarning): string => t('themeEditor.warning', { color: seedLabel(warning.seed), surface: surfaceLabel(warning.on), ratio: format.ratio(warning.ratio), need: format.need(warning.need) });
function applyFix(warning: ColorWarning): void {
  const current = currentLook.value;
  if (!current || readOnly.value || warning.fixed === undefined || warning.fixedRatio === undefined) return;
  const before = current.colors[warning.seed];
  setSeed(warning.seed, warning.fixed);
  fix.value = { kind: look.value, seed: warning.seed, before, text: t('themeEditor.fixed', { color: seedLabel(warning.seed), from: before, to: warning.fixed, ratio: format.ratio(warning.fixedRatio), surface: surfaceLabel(warning.on) }) };
}
function undoFix(): void {
  const last = fix.value;
  if (!last || !('seed' in last) || last.kind !== look.value) return;
  setSeed(last.seed, last.before);
  fix.value = { text: t('themeEditor.fixUndone', { color: seedLabel(last.seed), value: last.before }) };
}
const hexValues = ref<Partial<Record<Seed, string>>>({});
const hexInvalid = ref<Partial<Record<Seed, boolean>>>({});
watch([currentLook, look], () => {
  hexValues.value = Object.fromEntries(LOOK_SEEDS.map((seed) => [seed, currentLook.value?.colors[seed] ?? '']));
  hexInvalid.value = {};
}, { immediate: true });
const hexOf = (raw: string): string | undefined => {
  const value = raw.trim();
  return /^#?[0-9a-fA-F]{6}$/.test(value) ? (value.startsWith('#') ? value : `#${value}`) : undefined;
};
// A value is taken as soon as it is a color; what is typed on the way to one is judged only when the field is left.
function typeHex(seed: Seed, raw: string): void {
  hexValues.value = { ...hexValues.value, [seed]: raw };
  hexInvalid.value = { ...hexInvalid.value, [seed]: false };
  const hex = hexOf(raw);
  if (hex) setSeed(seed, hex);
}
function leaveHex(seed: Seed): void {
  hexInvalid.value = { ...hexInvalid.value, [seed]: hexOf(hexValues.value[seed] ?? '') === undefined };
}
// Where the derivation moved a tone off its seed to keep 4.5:1, the color its text or fills show instead.
const derivation = computed(() => (currentLook.value ? deriveLookDetails(currentLook.value.colors, look.value, currentLook.value.tokens) : undefined));
const movesOf = (seed: Seed): readonly SeedMove[] => derivation.value?.moved.filter((move) => move.tone === seed) ?? [];
const moveId = (move: SeedMove): string => `theme-move-${move.tone}-${move.role}`;
const moveText = (move: SeedMove): string => t(move.role === 'text' ? 'themeEditor.shownInText' : 'themeEditor.shownInFills', { hex: move.shown, need: format.need(AA) });
function hexDescribedBy(seed: Seed): string | undefined {
  const ids = [...(hexInvalid.value[seed] ? [`theme-hex-${seed}-error`] : []), ...movesOf(seed).map(moveId)];
  return ids.length > 0 ? ids.join(' ') : undefined;
}
const swatchHex = (seed: Seed): HexColor => canonicalHexColor(currentLook.value?.colors[seed] ?? '#000000') ?? ('#000000ff' as HexColor);
const areaValueText = (saturation: number, brightness: number): string => t('colorPicker.areaValue', { saturation, brightness });
const hueValueText = (degrees: number): string => t('colorPicker.hueValue', degrees);

// Advanced: the palette derived from the 8 colors alone, the one the look shows with its overrides, and its contrast.
const derived = computed(() => derivation.value?.derived);
const shownPalette = computed(() => (currentLook.value ? lookPalette(draft.value, look.value) : undefined));
const issues = computed(() => (shownPalette.value ? checkPalette(shownPalette.value, look.value) : []));
const overrideCount = computed(() => Object.keys(currentLook.value?.tokens ?? {}).length);

// Looks
function addLook(kind: LookKind): void {
  setLook(kind, { colors: { ...BUILTIN_THEME.looks[kind]!.colors } });
  look.value = kind;
}
function removeLook(): void {
  if (kinds.value.length < 2 || readOnly.value) return;
  const gone = look.value;
  look.value = gone === 'dark' ? 'light' : 'dark';
  setLook(gone, undefined);
}

// Characters: a pick of another set, or of none, keeps the set it replaced until the set is edited again.
function replaceSet(next: ThemeFile): void {
  const held = heldSet(draft.value);
  edit(next);
  if (held && !readOnly.value) replacedSet.value = { held, text: t(next.characters ? 'themeEditor.characters.replaced' : 'themeEditor.characters.removed', { name: isolated(held.set.name) }) };
}
function undoReplace(): void {
  const last = replacedSet.value;
  if (!last || !('held' in last)) return;
  edit(withCharacterSet(draft.value, last.held.set, last.held.assets));
  replacedSet.value = { text: t('themeEditor.characters.restored', { name: isolated(last.held.set.name) }) };
}

// Preview: every edit, look switch and Show my current theme paints the window, at most once per PREVIEW_MS.
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function sendPreview(): void {
  previewTimer = undefined;
  const current = session.value;
  if (!current || current.builtin || !draft.value.looks[look.value]) return;
  // main paints nothing of a draft that is no valid theme, and the status line says so
  if (!comparing.value && errors.value.length > 0) return;
  props.api.themeEditor.preview({ sessionId: current.sessionId, kind: look.value, theme: comparing.value ? null : JSON.parse(JSON.stringify(draft.value)) as ThemeFile, setIndex: wallpaperSet.value });
}
function schedulePreview(): void {
  if (previewTimer === undefined) previewTimer = setTimeout(sendPreview, PREVIEW_MS);
}
onScopeDispose(props.api.themeEditor.onPreviewTakenOver(() => {
  takenOver.value = true;
}));
onScopeDispose(props.api.themeEditor.onPreviewRefused((reason) => {
  const was = refused.value;
  refused.value = reason;
  // the window can paint again: it shows the draft as it is now
  if (was !== null && reason === null) schedulePreview();
}));
watch([draft, look, comparing, session, wallpaperSet], () => {
  takenOver.value = false;
  schedulePreview();
});
onScopeDispose(() => clearTimeout(previewTimer));
const previewing = computed(() => refused.value === null && !takenOver.value && (comparing.value || errors.value.length === 0));
const previewText = computed(() => {
  if (refused.value !== null) return t(`themeEditor.preview.${refused.value}`);
  if (takenOver.value) return t('themeEditor.preview.takenOver');
  if (comparing.value) return t('themeEditor.preview.comparing');
  if (errors.value.length > 0) return t('themeEditor.preview.invalid');
  return t(`themeEditor.preview.editing.${look.value}`, { name: isolated(name.value || t('themeEditor.untitled')) });
});

// Save, Cancel, Close, Duplicate
// A section's panel mounts when its tab shows, so the field is looked up once it has rendered.
async function focusFirstError(): Promise<void> {
  const first = errors.value[0];
  if (!first) return;
  section.value = first.section;
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (first.field !== undefined) document.getElementById(first.field)?.focus();
}
async function save(): Promise<void> {
  const current = session.value;
  if (!current || readOnly.value || saving.value) return;
  if (errors.value.length > 0) {
    await focusFirstError();
    return;
  }
  saving.value = true;
  failure.value = undefined;
  // what this save sends: the answer is about these, whatever the draft holds by the time it comes
  const sent = draft.value;
  const sentPins = pinsShown.value;
  const pinsAtSend = pinsNow.value;
  const pins = pendingPins.value;
  const same = (): boolean => session.value?.sessionId === current.sessionId;
  try {
    const result = await props.api.themeEditor.save({ sessionId: current.sessionId, theme: JSON.parse(JSON.stringify(sent)) as ThemeFile, ...(pins.length > 0 ? { pins } : {}) });
    if (!same()) return;
    if (result.ok) {
      // Core stored only the CSS the sanitizer kept, so the stored theme takes it and the draft stays equal to the file.
      let stored = sent;
      if (result.css) {
        const next: Record<string, unknown> = { ...sent, css: result.css.kept };
        if (Object.keys(result.css.kept).length === 0) delete next['css'];
        stored = next as unknown as ThemeFile;
      }
      saved.value = stableStringify(stored);
      storedLayout.value = stored.layout;
      pinsSaved.value = sentPins;
      if (pinsNow.value === pinsAtSend) pinsNow.value = sentPins;
      outside.value = undefined;
      const cssAsSent = draft.value.css === sent.css;
      // core's list is about the CSS and fonts it was sent: an edit of either made meanwhile shows the live list
      savedDropped.value = result.css && cssAsSent && cssFamilies(draft.value) === cssFamilies(sent) ? { parts: result.css.dropped, more: result.css.droppedMore } : undefined;
      if (draft.value === sent) draft.value = stored;
      else if (cssAsSent) {
        const next: Record<string, unknown> = { ...draft.value, css: stored.css };
        if (stored.css === undefined) delete next['css'];
        draft.value = next as unknown as ThemeFile;
      }
      justSaved.value = true;
    } else if ('reason' in result) {
      if (result.reason === 'changed') outside.value = 'changed';
      else if (result.reason === 'invalid') failure.value = t('themeEditor.errors.invalid');
    } else if ('error' in result) failure.value = result.error;
  } catch (err) {
    if (same()) failure.value = failureText(t, err, 'action');
  } finally {
    if (same()) saving.value = false;
  }
}
function close(): void {
  if (session.value) props.api.themeEditor.close(session.value.sessionId);
}
// Cancel closes at once when there is nothing to lose, and asks first when there is.
const keepButton = useTemplateRef<HTMLButtonElement>('keepButton');
function ask(what: 'close' | 'move'): void {
  asking.value = what;
  void nextTick(() => keepButton.value?.focus());
}
function cancel(): void {
  if (dirty.value) ask('close');
  else close();
}
function discard(): void {
  const current = session.value;
  const what = asking.value;
  asking.value = undefined;
  if (!current || what === undefined) return;
  if (what === 'move') props.api.themeEditor.answerMove(current.sessionId, true);
  else close();
}
function keepEditing(): void {
  const current = session.value;
  if (current && asking.value === 'move') props.api.themeEditor.answerMove(current.sessionId, false);
  asking.value = undefined;
}
onScopeDispose(props.api.themeEditor.onMoveAsked(() => ask('move')));
watch(dirty, (now) => {
  const current = session.value;
  if (!current || current.builtin) return;
  props.api.themeEditor.setDirty(current.sessionId, now);
  if (now) return;
  // saved while the question stood: nothing is left to discard, so a move main asked for goes ahead and Cancel's question ends
  if (asking.value === 'move') discard();
  else asking.value = undefined;
});
function reload(): void {
  if (session.value) props.api.themeEditor.reload(session.value.sessionId);
}
async function duplicate(): Promise<void> {
  const current = session.value;
  if (!current || duplicating.value) return;
  duplicating.value = true;
  failure.value = undefined;
  const same = (): boolean => session.value?.sessionId === current.sessionId;
  try {
    const result = await props.api.themeEditor.duplicate(current.sessionId);
    if (same() && 'error' in result) failure.value = result.error;
  } catch (err) {
    if (same()) failure.value = failureText(t, err, 'action');
  } finally {
    if (same()) duplicating.value = false;
  }
}

// Arrangement: Save writes the arrangement shown here and never reads the window; Capture reads it, when asked.
const arrangement = computed(() => draft.value.layout);
const arrangementState = computed(() => (arrangement.value === undefined ? 'none' : stableStringify(arrangement.value) === stableStringify(storedLayout.value) ? 'saved' : 'captured'));
function withLayout(layout: Arrangement | undefined): ThemeFile {
  const next: Record<string, unknown> = { ...draft.value };
  if (layout) next['layout'] = layout;
  else delete next['layout'];
  return next as unknown as ThemeFile;
}
async function capture(): Promise<void> {
  const current = session.value;
  if (!current || readOnly.value || capturing.value) return;
  capturing.value = true;
  failure.value = undefined;
  const same = (): boolean => session.value?.sessionId === current.sessionId;
  try {
    const result = await props.api.themeEditor.captureArrangement(current.sessionId);
    if (same() && result.ok) edit(withLayout(result.arrangement));
  } catch (err) {
    if (same()) failure.value = failureText(t, err, 'action');
  } finally {
    if (same()) capturing.value = false;
  }
}
function setArrangement(on: boolean): void {
  if (readOnly.value || on === (arrangement.value !== undefined)) return;
  if (!on) {
    heldLayout.value = arrangement.value;
    edit(withLayout(undefined));
  } else if (heldLayout.value) edit(withLayout(heldLayout.value));
  else void capture();
}
const arrangementFacts = computed(() => {
  const value = arrangement.value;
  const grid = value?.grid;
  const pane = (id: string): string => t(`themeEditor.arrangement.panes.${id}`);
  return {
    slots: grid ? t('themeEditor.arrangement.slotsValue', { main: pane(grid.slots.main), side: pane(grid.slots.side), bottom: pane(grid.slots.bottom) }) : '',
    sidebar: value?.sidebarWidth !== undefined ? t('themeEditor.arrangement.sidebarValue', { rem: format.number(Math.round((value.sidebarWidth / 16) * 10) / 10, 1) }) : '',
    sections: format.list((value?.sectionOrder ?? []).map((id) => t(`themeEditor.arrangement.sections.${id}`))),
  };
});
</script>

<template>
  <aside
    class="@container/dock fixed inset-0 flex min-h-0 flex-col border-s border-(--d-border2) bg-(--d-bg) text-12 text-(--d-text)"
    :aria-label="t('themeEditor.title')"
    data-trusted
    data-testid="theme-editor"
  >
    <template v-if="session">
      <header class="flex flex-col gap-2 border-b border-(--d-border) px-3 pt-3 pb-2">
        <div class="flex items-center gap-2.5">
          <div class="w-16 flex-none">
            <ThemeMiniature
              :theme="draft"
              :mode="miniMode"
              :label="miniLabel"
            />
          </div>
          <div class="min-w-0 flex-1">
            <h1
              class="truncate text-13 font-semibold"
              :class="!name && 'text-(--d-faint-text)'"
              data-testid="theme-editor-name"
            >
              <bdi>{{ name || t('themeEditor.untitled') }}</bdi>
            </h1>
            <p class="truncate text-11 text-(--d-muted)">
              <IsolatedText :text="subtitle" />
            </p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <SettingSeg
            :model-value="look"
            :options="lookOptions"
            :label="t('themeEditor.looks')"
            radios
            data-testid="theme-editor-looks"
            @update:model-value="(kind: LookKind) => (look = kind)"
          />
          <button
            v-if="missingKind && !readOnly"
            type="button"
            class="sm-button"
            @click="addLook(missingKind)"
          >
            <Plus
              class="size-3"
              aria-hidden="true"
            />{{ t(`themeEditor.addLook.${missingKind}`) }}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              class="inline-flex size-7 items-center justify-center rounded-7 text-(--d-muted) hover:bg-(--d-hover) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
              :aria-label="t('themeEditor.lookOptions')"
            >
              <MoreHorizontal
                class="size-4"
                aria-hidden="true"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              :class="MENU_CONTENT"
              :aria-label="t('themeEditor.lookOptions')"
            >
              <DropdownMenuItem
                :class="[MENU_ITEM, 'text-(--d-danger-text) focus:text-(--d-danger-text) [&>svg]:text-(--d-danger-text)']"
                :disabled="readOnly || kinds.length < 2"
                @select="removeLook"
              >
                <Trash2 aria-hidden="true" />{{ t(`themeEditor.removeLook.${look}`) }}
              </DropdownMenuItem>
              <p
                v-if="readOnly || kinds.length < 2"
                class="max-w-56 px-2.25 py-1 text-11 text-(--d-muted)"
              >
                {{ readOnly ? t('themeEditor.removeNote.builtin') : t('themeEditor.removeNote.keepOne') }}
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
          <span class="flex-1" />
          <template v-if="!readOnly">
            <button
              type="button"
              class="sm-button"
              data-testid="theme-editor-cancel"
              @click="cancel"
            >
              {{ t('themeEditor.cancel') }}
            </button>
            <button
              type="button"
              class="sm-button sm-button-primary"
              :aria-disabled="errors.length > 0 || saving ? 'true' : undefined"
              :aria-describedby="errors.length > 0 ? 'theme-editor-save-reason' : undefined"
              data-testid="theme-editor-save"
              @click="save"
            >
              {{ t('themeEditor.save') }}
            </button>
          </template>
          <button
            v-else
            type="button"
            class="sm-button"
            data-testid="theme-editor-close"
            @click="close"
          >
            {{ t('themeEditor.close') }}
          </button>
        </div>
        <div
          v-if="asking"
          class="flex flex-wrap items-center gap-2 rounded-9 border border-(--d-border2) bg-(--d-panel) px-2 py-1.5"
          role="group"
          aria-labelledby="theme-editor-discard-question"
          data-testid="theme-editor-discard"
        >
          <span
            id="theme-editor-discard-question"
            class="min-w-0 flex-1 text-12 font-medium"
          >{{ t('themeEditor.discard.question') }}</span>
          <button
            type="button"
            class="sm-button sm-button-danger"
            @click="discard"
          >
            {{ t('themeEditor.discard.discard') }}
          </button>
          <button
            ref="keepButton"
            type="button"
            class="sm-button"
            @click="keepEditing"
          >
            {{ t('themeEditor.discard.keep') }}
          </button>
        </div>
        <p
          v-if="errors.length > 0"
          id="theme-editor-save-reason"
          class="flex items-center gap-1.5 text-11 text-(--d-danger-text)"
        >
          <AlertTriangle
            class="size-3"
            aria-hidden="true"
          />
          <button
            type="button"
            class="underline underline-offset-2"
            @click="focusFirstError"
          >
            {{ errorSummary }}
          </button>
        </p>
        <p
          v-if="failure"
          class="text-11 text-(--d-danger-text)"
          role="alert"
          data-testid="theme-editor-failure"
        >
          {{ failure }}
        </p>
        <div
          v-if="!readOnly"
          class="flex flex-wrap items-center gap-2 rounded-9 border border-(--d-border2) bg-(--d-panel) px-2 py-1"
        >
          <span
            class="size-1.5 flex-none rounded-full"
            :class="previewing ? 'bg-(--d-accent-fill)' : 'bg-(--d-faint)'"
            aria-hidden="true"
          />
          <span
            role="status"
            :aria-label="t('themeEditor.preview.status')"
            class="min-w-0 flex-1 text-11"
            data-testid="theme-editor-preview"
          ><IsolatedText :text="previewText" /></span>
          <button
            type="button"
            class="sm-button"
            data-testid="theme-editor-compare"
            :aria-pressed="comparing"
            @click="comparing = !comparing"
          >
            {{ t('themeEditor.preview.compare') }}
          </button>
        </div>
      </header>

      <Tabs
        v-model="section"
        class="flex min-h-0 flex-1 flex-col"
      >
        <TabsList
          class="mx-3 mt-2 size-auto min-h-7.5 flex-wrap justify-start bg-(--d-hover) p-0.5"
          :aria-label="t('themeEditor.sections')"
        >
          <TabsTrigger
            v-for="id in (['colors', 'type', 'wallpapers', 'css', 'characters', 'arrangement', 'details'] as const)"
            :key="id"
            :value="id"
            class="h-6.5 px-2.5 text-12 data-[state=active]:bg-(--d-card)"
          >
            {{ t(`themeEditor.section.${id}`) }}
          </TabsTrigger>
        </TabsList>
        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          <div
            v-if="readOnly"
            class="sm-banner"
          >
            <Lock
              class="size-4"
              aria-hidden="true"
            />
            <span class="sm-banner-text"><IsolatedText :text="t('themeEditor.builtinBanner', { name: isolated(name) })" /></span>
            <button
              type="button"
              class="sm-button sm-button-primary"
              :aria-disabled="duplicating ? 'true' : undefined"
              @click="duplicate"
            >
              <Copy
                class="size-3"
                aria-hidden="true"
              />{{ t('themeEditor.duplicate') }}
            </button>
          </div>
          <div
            v-if="outside"
            class="sm-banner"
            role="alert"
            data-testid="theme-editor-outside"
          >
            <AlertTriangle
              class="size-4"
              aria-hidden="true"
            />
            <span class="sm-banner-text">{{ t(`themeEditor.outside.${outside}`) }}</span>
            <button
              v-if="outside === 'changed'"
              type="button"
              class="sm-button"
              @click="reload"
            >
              <RefreshCw
                class="size-3"
                aria-hidden="true"
              />{{ dirty ? t('themeEditor.outside.reloadDiscard') : t('themeEditor.outside.reload') }}
            </button>
          </div>

          <TabsContent
            value="colors"
            class="flex flex-col gap-3"
          >
            <p
              v-if="!readOnly"
              class="text-11.5 text-(--d-muted)"
            >
              {{ t('themeEditor.colorsNote') }}
            </p>
            <ul
              class="flex flex-col gap-1"
              :aria-label="t('themeEditor.warnings')"
              data-testid="theme-editor-warnings"
            >
              <li
                v-if="warnings.length === 0"
                class="flex items-center gap-2 rounded-8 bg-(--d-success-fill)/10 px-2 py-1.5 text-(--d-success-text)"
              >
                <Check
                  class="size-3.5"
                  aria-hidden="true"
                />
                {{ t('themeEditor.allPass') }}
              </li>
              <li
                v-for="warning in warnings"
                :key="warning.seed"
                class="flex flex-wrap items-center gap-2 rounded-8 bg-(--d-warning-fill)/10 px-2 py-1.5 text-(--d-warning-text)"
              >
                <AlertTriangle
                  class="size-3.5"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1">{{ warningText(warning) }}</span>
                <button
                  v-if="warning.fixedRatio !== undefined"
                  type="button"
                  class="sm-button"
                  :disabled="readOnly"
                  :aria-label="t('themeEditor.fixLabel', { ratio: format.ratio(warning.fixedRatio), color: seedLabel(warning.seed), surface: surfaceLabel(warning.on) })"
                  @click="applyFix(warning)"
                >
                  {{ t('themeEditor.fix', { ratio: format.ratio(warning.fixedRatio) }) }}
                </button>
                <span
                  v-else
                  class="basis-full text-11"
                  data-testid="theme-editor-no-fix"
                >{{ t('themeEditor.noFix', { background: surfaceLabel('background'), panel: surfaceLabel('panel') }) }}</span>
              </li>
            </ul>
            <div
              role="status"
              :aria-label="t('themeEditor.fixStatus')"
              class="text-11.5 text-(--d-muted)"
              data-testid="theme-editor-fix-status"
            >
              <template v-if="fix">
                {{ fix.text }}
                <button
                  v-if="'seed' in fix"
                  type="button"
                  class="ms-1 text-(--d-accent) underline underline-offset-2"
                  @click="undoFix"
                >
                  {{ t('themeEditor.undoFix') }}
                </button>
              </template>
            </div>
            <div
              role="group"
              :aria-label="t('themeEditor.mainColors')"
              class="flex flex-col gap-1.5"
            >
              <div
                v-for="seed in LOOK_SEEDS"
                :key="seed"
                class="grid grid-cols-[auto_1fr_6.5rem] items-center gap-2"
              >
                <Popover
                  :open="pickerOpen === seed"
                  @update:open="(open: boolean) => (pickerOpen = open && !readOnly ? seed : undefined)"
                >
                  <PopoverTrigger as-child>
                    <!-- a swatch of the theme's own color, which no shadcn part draws -->
                    <button
                      type="button"
                      class="size-7 rounded-7 border border-(--d-border2) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill) disabled:opacity-(--d-opacity-disabled)"
                      :style="{ backgroundColor: currentLook?.colors[seed] }"
                      :disabled="readOnly"
                      :aria-label="t('themeEditor.swatch', { color: seedLabel(seed), value: currentLook?.colors[seed] ?? '' })"
                    />
                  </PopoverTrigger>
                  <!-- reka names the popover by its swatch, which names the color and its value -->
                  <PopoverContent
                    align="start"
                    class="w-60"
                  >
                    <ColorPicker
                      :model-value="swatchHex(seed)"
                      opaque
                      :area-label="t('colorPicker.area')"
                      :area-thumb-label="t('colorPicker.areaThumb')"
                      :hue-label="t('colorPicker.hue')"
                      :hex-label="t('colorPicker.hex')"
                      :preview-label="t('colorPicker.preview')"
                      :area-value-text="areaValueText"
                      :hue-value-text="hueValueText"
                      @update:model-value="(value: HexColor) => setSeed(seed, value.slice(0, 7))"
                    />
                  </PopoverContent>
                </Popover>
                <span class="min-w-0">
                  <span class="block font-medium">
                    {{ seedLabel(seed) }}
                    <AlertTriangle
                      v-if="warnings.some((warning) => warning.seed === seed)"
                      class="inline size-3 text-(--d-warning-text)"
                      :aria-label="t('themeEditor.failsContrast')"
                    />
                  </span>
                  <span class="block truncate text-11 text-(--d-muted)">{{ t(`themeEditor.seedHints.${seed}`) }}</span>
                  <span
                    v-for="move in movesOf(seed)"
                    :id="moveId(move)"
                    :key="move.role"
                    class="block text-11 text-(--d-muted)"
                    data-testid="theme-editor-moved"
                  >{{ moveText(move) }}</span>
                </span>
                <span>
                  <label
                    class="sr-only"
                    :for="`theme-hex-${seed}`"
                  >{{ t('themeEditor.hex', { color: seedLabel(seed) }) }}</label>
                  <Input
                    :id="`theme-hex-${seed}`"
                    :model-value="hexValues[seed] ?? ''"
                    class="h-7 px-1.5 font-mono text-11.5"
                    spellcheck="false"
                    autocomplete="off"
                    maxlength="7"
                    :readonly="readOnly"
                    :aria-invalid="hexInvalid[seed] ? 'true' : undefined"
                    :aria-describedby="hexDescribedBy(seed)"
                    @update:model-value="(value: string | number) => typeHex(seed, String(value))"
                    @blur="leaveHex(seed)"
                  />
                </span>
                <p
                  v-if="hexInvalid[seed]"
                  :id="`theme-hex-${seed}-error`"
                  class="col-span-3 text-11 text-(--d-danger-text)"
                >
                  {{ t('themeEditor.hexError') }}
                </p>
              </div>
            </div>
            <button
              type="button"
              class="flex items-center gap-2 self-start rounded-7 px-1.5 py-1 text-12 hover:bg-(--d-hover)"
              :aria-expanded="advancedOpen"
              aria-controls="theme-editor-advanced"
              @click="advancedOpen = !advancedOpen"
            >
              {{ t('themeEditor.advanced') }}
              <span
                v-if="overrideCount > 0"
                class="rounded-full bg-(--d-hover) px-1.5 text-10.5 text-(--d-muted)"
              >{{ t('themeEditor.overrides', { count: overrideCount }, overrideCount) }}</span>
            </button>
            <div
              v-if="advancedOpen && derived && shownPalette"
              id="theme-editor-advanced"
              class="flex flex-col gap-2"
            >
              <p class="text-11.5 text-(--d-muted)">
                {{ t('themeEditor.advancedNote') }}
              </p>
              <TokenTable
                :derived="derived"
                :shown="shownPalette"
                :overrides="currentLook?.tokens ?? {}"
                :issues="issues"
                :kind="look"
                :read-only="readOnly"
                @set="setToken"
              />
            </div>
          </TabsContent>

          <TabsContent value="type">
            <TypeSection
              :api="api"
              :draft="draft"
              :read-only="readOnly"
              :imports="imports"
              @update="edit"
            />
          </TabsContent>

          <TabsContent value="wallpapers">
            <WallpapersSection
              v-model:set-index="wallpaperSet"
              :draft="draft"
              :kind="look"
              :read-only="readOnly"
              :imports="imports"
              :known="session.wallpapers ?? {}"
              :contrast="session.wallpaperContrast ?? 'raiseDim'"
              :next-shortcut="session.nextWallpaperShortcut"
              @update="edit"
            />
          </TabsContent>

          <TabsContent value="css">
            <CssSection
              :draft="draft"
              :read-only="readOnly"
              :saved-dropped="savedDropped?.parts"
              :saved-dropped-more="savedDropped?.more"
              @update="edit"
            />
          </TabsContent>

          <TabsContent value="characters">
            <CharactersSection
              :api="api"
              :draft="draft"
              :read-only="readOnly"
              :session="session"
              :pins="pinsShown"
              :imports="imports"
              :replaced="replacedSet ? { text: replacedSet.text, undo: 'held' in replacedSet } : undefined"
              @update="edit"
              @replace="replaceSet"
              @undo-replace="undoReplace"
              @pin="setPin"
            />
          </TabsContent>

          <TabsContent
            value="arrangement"
            class="flex flex-col gap-3"
          >
            <div class="flex items-center gap-2.5">
              <Switch
                id="theme-editor-arrangement"
                :checked="arrangement !== undefined"
                :disabled="readOnly || capturing"
                aria-describedby="theme-editor-arrangement-rule"
                @update:checked="setArrangement"
              />
              <Label
                for="theme-editor-arrangement"
                class="text-12"
              >{{ t('themeEditor.arrangement.include') }}</Label>
            </div>
            <p
              id="theme-editor-arrangement-rule"
              class="text-11.5 text-(--d-muted)"
            >
              {{ t('themeEditor.arrangement.rule') }}
            </p>
            <h2
              class="text-11 font-semibold tracking-wide text-(--d-faint-text) uppercase"
              role="status"
              data-testid="theme-editor-arrangement-state"
            >
              {{ t(`themeEditor.arrangement.${arrangementState}`) }}
            </h2>
            <dl
              v-if="arrangement"
              class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-12"
            >
              <dt class="text-(--d-muted)">
                {{ t('themeEditor.arrangement.slots') }}
              </dt>
              <dd>{{ arrangementFacts.slots }}</dd>
              <dt class="text-(--d-muted)">
                {{ t('themeEditor.arrangement.sidebar') }}
              </dt>
              <dd>{{ arrangementFacts.sidebar }}</dd>
              <dt class="text-(--d-muted)">
                {{ t('themeEditor.arrangement.sectionOrder') }}
              </dt>
              <dd>{{ arrangementFacts.sections }}</dd>
            </dl>
            <button
              v-if="!readOnly"
              type="button"
              class="sm-button self-start"
              :disabled="capturing"
              data-testid="theme-editor-capture"
              @click="capture"
            >
              {{ t('themeEditor.arrangement.capture') }}
            </button>
          </TabsContent>

          <TabsContent
            value="details"
            class="flex flex-col gap-3"
          >
            <div class="flex flex-col gap-1">
              <Label
                for="theme-editor-name"
                class="text-12"
              >{{ t('themeEditor.details.name') }}</Label>
              <Input
                id="theme-editor-name"
                :model-value="name"
                dir="auto"
                class="h-7.5 text-12.5"
                :maxlength="MAX_THEME_NAME_CHARS"
                :readonly="readOnly"
                :aria-invalid="fieldError('theme-editor-name') !== undefined ? 'true' : undefined"
                :aria-describedby="fieldError('theme-editor-name') !== undefined ? 'theme-editor-name-error' : undefined"
                @update:model-value="(value: string | number) => setDetail('name', String(value))"
              />
              <p
                v-if="fieldError('theme-editor-name') !== undefined"
                id="theme-editor-name-error"
                class="text-11 text-(--d-danger-text)"
              >
                {{ t('themeEditor.errors.nameHelp', { max: MAX_THEME_NAME_CHARS }) }}
              </p>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div
                v-for="key in (['author', 'version'] as const)"
                :key="key"
                class="flex flex-col gap-1"
              >
                <Label
                  :for="`theme-editor-${key}`"
                  class="text-12"
                >{{ t(`themeEditor.details.${key}`) }}</Label>
                <Input
                  :id="`theme-editor-${key}`"
                  :model-value="draft[key] ?? ''"
                  class="h-7.5 text-12.5"
                  :maxlength="DETAIL_LIMITS[key]"
                  :readonly="readOnly"
                  @update:model-value="(value: string | number) => setDetail(key, String(value))"
                />
              </div>
            </div>
            <div class="flex flex-col gap-1">
              <Label
                for="theme-editor-description"
                class="text-12"
              >{{ t('themeEditor.details.description') }}</Label>
              <Textarea
                id="theme-editor-description"
                :model-value="description"
                class="min-h-14 text-12.5"
                :maxlength="MAX_THEME_DESCRIPTION_CHARS"
                :readonly="readOnly"
                @update:model-value="(value: string | number) => setDetail('description', String(value))"
              />
            </div>
            <div class="flex flex-col gap-1">
              <Label
                for="theme-editor-license"
                class="text-12"
              >{{ t('themeEditor.details.license') }}</Label>
              <Input
                id="theme-editor-license"
                :model-value="draft.license ?? ''"
                class="h-7.5 font-mono text-12"
                :maxlength="MAX_THEME_LICENSE_CHARS"
                :readonly="readOnly"
                :aria-invalid="fieldError('theme-editor-license') !== undefined ? 'true' : undefined"
                :aria-describedby="fieldError('theme-editor-license') !== undefined ? 'theme-editor-license-error theme-editor-license-hint' : 'theme-editor-license-hint'"
                @update:model-value="(value: string | number) => setDetail('license', String(value))"
              />
              <p
                v-if="fieldError('theme-editor-license') !== undefined"
                id="theme-editor-license-error"
                class="text-11 text-(--d-danger-text)"
              >
                {{ fieldError('theme-editor-license') }}
              </p>
              <p
                id="theme-editor-license-hint"
                class="text-11 text-(--d-muted)"
              >
                {{ t('themeEditor.details.licenseHint') }}
              </p>
            </div>
          </TabsContent>
        </div>
      </Tabs>

      <!-- Covering the window (a narrow window), the dock can step aside; the shell's bar or Escape brings it back. -->
      <div class="hidden items-center gap-2 border-t border-(--d-border) px-3 py-2 @min-[30rem]/dock:flex">
        <button
          type="button"
          class="sm-button"
          data-testid="theme-editor-peek"
          @click="api.themeEditor.peek(true)"
        >
          <Eye
            class="size-3"
            aria-hidden="true"
          />{{ t('themeEditor.peek') }}
        </button>
      </div>
    </template>
  </aside>
</template>
