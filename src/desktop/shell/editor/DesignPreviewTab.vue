<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Ban, Camera, CircleAlert, CircleCheck, CircleX, CloudOff, ExternalLink, LoaderCircle, MoveHorizontal, PencilLine, SlidersHorizontal } from 'lucide-vue-next';
import type { AcceptableValue } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import SegmentedToggle from '@/components/SegmentedToggle.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import JourneyStepText from '@/components/design/JourneyStepText.vue';
import { remPx } from '@/composables/useRemPx';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { MAX_DESIGN_WIDTH, MAX_DESIGN_ZOOM, MIN_DESIGN_WIDTH, MIN_DESIGN_ZOOM, type DamoclesShellApi, type DesignReplayProgress, type ShellDesignPreview, type ShellEditorTab, type ShellPlatform } from '../../preload/shell-channels';
import { boundsOf, watchContentBounds } from '../content-bounds';
import { TOOLBAR_BUTTON } from './design-toolbar';
import { bandOf, clampWidth, dragDelta, fitWidth, keyWidth, presetsOf, readout, zoomFor } from './design-width';
import MarkupLayer from './MarkupLayer.vue';
import MarkupToolbar from './MarkupToolbar.vue';
import { flattenMarkup, resolveMarkupColors } from './markup-flatten';
import { dropMarkupSession, markupJson, markupSession, startMarkupSession, undoMarks } from './markup-session';
import TweaksPanel from './TweaksPanel.vue';
import { ensureTweaksSession, tweaksSession } from './tweaks-session';

const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab & { designPreview: ShellDesignPreview }; platform: ShellPlatform }>();
const { t } = useI18n();

const preview = computed(() => props.tab.designPreview);
const breakpoints = computed(() => preview.value.info?.breakpoints ?? []);
const presets = computed(() => presetsOf(breakpoints.value));
const primaryBand = computed(() => (preview.value.info ? bandOf(preview.value.info.primary, breakpoints.value) : undefined));
const states = computed(() => preview.value.info?.states ?? []);
const tweaks = computed(() => preview.value.info?.tweaks ?? null);
const appliedTweaks = computed(() => preview.value.tweaks ?? {});
const tweaksApplied = computed(() => Object.keys(appliedTweaks.value).length);

// Reconnecting: the view's last frame, fetched once per frame id, since no editor-state publish carries it.
const lastFrame = ref<string | null>(null);
const lastFrameId = computed(() => (preview.value.status === 'reconnecting' ? preview.value.lastFrameId : undefined));
watch(lastFrameId, (id) => {
  lastFrame.value = null;
  if (id === undefined) return;
  props.api.designLastFrame(props.tab.id).then((frame) => {
    if (lastFrameId.value === id) lastFrame.value = frame;
  }, () => undefined);
}, { immediate: true });

// The stage's gutters, in rem: the sides hold the drag handle and the bottom the readout and the chip, all outside the
// native view, which covers the frame and anything drawn over it.
const SIDE_GUTTER_REM = 2;
// the top-4 of the frame, the flash and the handle
const TOP_GUTTER_REM = 1;
// covers PILL's bottom-2.5 plus its h-5.5
const BOTTOM_GUTTER_REM = 2.75;
const HANDLE_GAP_REM = 0.25;

const stage = ref<HTMLElement | null>(null);
const frame = ref<HTMLElement | null>(null);
const stageSize = ref({ width: 0, height: 0 });
const room = computed(() => ({
  width: Math.max(0, stageSize.value.width - 2 * remPx(SIDE_GUTTER_REM)),
  height: Math.max(0, stageSize.value.height - remPx(TOP_GUTTER_REM) - remPx(BOTTOM_GUTTER_REM)),
}));

// The shown width follows main's, except while a drag or typing holds a newer one.
const width = ref(preview.value.width);
const animating = ref(false);
const dragging = ref(false);
const typed = ref(String(width.value));
const editing = ref(false);
watch(() => preview.value.width, (next) => {
  if (!dragging.value && !editing.value) width.value = next;
});
const zoom = computed(() => zoomFor(width.value, room.value.width));
const frameWidth = computed(() => width.value * zoom.value);
const band = computed(() => bandOf(width.value, breakpoints.value));
const exactPreset = computed(() => presets.value.find((preset) => preset.width === width.value)?.name);
const readoutText = computed(() => readout(width.value, zoom.value, breakpoints.value));
// Only a preset change glides; drags, keys and typing follow at once, and reduced motion moves nothing.
const glides = computed(() => animating.value && !prefersReducedMotion());
// .design-frame-glide's 0.35 s, and a margin for a transition that never reports its end
const GLIDE_MS = 350;
const GLIDE_SLACK_MS = 150;

// Main refuses a tab that left the selected chat meanwhile, and toasts an Open in browser failure itself.
function reportRefusal(error: unknown): void {
  console.error('[design preview] main refused the change', error);
}

function persist(next: number): void {
  props.api.setDesignPreview({ tabId: props.tab.id, width: next }).catch(reportRefusal);
}

function setWidth(next: number, animate: boolean): void {
  const clamped = clampWidth(next);
  // Only a frame that changes size ends a transition; a zoomed frame stays as wide as the room.
  animating.value = animate && clamped * zoomFor(clamped, room.value.width) !== frameWidth.value;
  width.value = clamped;
}

function onPreset(value: AcceptableValue | AcceptableValue[]): void {
  const preset = presets.value.find((candidate) => candidate.name === value);
  if (!preset || freezing.value) return;
  setWidth(preset.width, true);
  persist(width.value);
}

function onFrameTransitionEnd(event: TransitionEvent): void {
  if (event.target === frame.value && event.propertyName === 'width') animating.value = false;
}

function fit(): void {
  if (freezing.value) return;
  setWidth(fitWidth(room.value.width), true);
  persist(width.value);
}

// The width field: a width in range applies as it is typed; Enter or leaving the field clamps and keeps it.
watch(width, (next) => {
  if (!editing.value) typed.value = String(next);
});
function typedWidth(): number | undefined {
  return /^\d{1,5}$/.test(typed.value.trim()) ? Number(typed.value.trim()) : undefined;
}
function onWidthInput(value: string | number): void {
  typed.value = String(value);
  editing.value = true;
  const next = typedWidth();
  if (next !== undefined && next >= MIN_DESIGN_WIDTH && next <= MAX_DESIGN_WIDTH) setWidth(next, false);
}
function commitTyped(): void {
  if (!editing.value) return;
  editing.value = false;
  const next = typedWidth();
  if (next !== undefined) setWidth(next, false);
  typed.value = String(width.value);
  persist(width.value);
}
function onWidthKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitTyped();
  } else if (event.key === 'Escape' && editing.value) {
    // Escape reverts an edit first; with nothing to revert it reaches the pane, which may leave the focus overlay.
    event.stopPropagation();
    editing.value = false;
    width.value = preview.value.width;
    typed.value = String(width.value);
  }
}

// The handle: the frame is centered, so an edge drag changes the width by twice the move, at the zoom the drag began with.
let drag: { pointerId: number; x: number; width: number; zoom: number } | null = null;
let dragFrame = 0;
let dragTarget: number | null = null;
function onHandleDown(event: PointerEvent): void {
  if (event.button !== 0 || freezing.value) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  (event.currentTarget as HTMLElement).focus();
  drag = { pointerId: event.pointerId, x: event.clientX, width: width.value, zoom: zoom.value };
  dragging.value = true;
  animating.value = false;
}
function onHandleMove(event: PointerEvent): void {
  if (drag?.pointerId !== event.pointerId) return;
  dragTarget = drag.width + dragDelta(event.clientX - drag.x, drag.zoom);
  if (dragFrame !== 0) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0;
    if (dragTarget !== null) setWidth(dragTarget, false);
  });
}
function onHandleUp(event: PointerEvent): void {
  if (drag?.pointerId !== event.pointerId) return;
  cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  setWidth(dragTarget ?? drag.width, false);
  drag = null;
  dragTarget = null;
  dragging.value = false;
  persist(width.value);
}
function onHandleKeydown(event: KeyboardEvent): void {
  const next = keyWidth(width.value, event.key, event.shiftKey);
  if (next === undefined || freezing.value) return;
  event.preventDefault();
  setWidth(next, false);
  persist(width.value);
}

function setState(state: string): void {
  props.api.setDesignPreview({ tabId: props.tab.id, state }).catch(reportRefusal);
}
function setProvenance(provenance: boolean): void {
  props.api.setDesignPreview({ tabId: props.tab.id, provenance }).catch(reportRefusal);
}
function openInBrowser(): void {
  props.api.designPreviewAction({ tabId: props.tab.id, action: 'openInBrowser' }).catch(reportRefusal);
}

// Screenshot: main captures the live view and posts it to the design chat's composer, resolving once it has.
const capturing = ref(false);
const flashes = ref(0);
const screenshotStatus = ref<'added' | 'failed' | null>(null);
const screenshotBlocked = computed(() => capturing.value || preview.value.status !== 'ready');
async function screenshot(): Promise<void> {
  if (screenshotBlocked.value) return;
  capturing.value = true;
  screenshotStatus.value = null;
  try {
    await props.api.designPreviewAction({ tabId: props.tab.id, action: 'screenshot' });
    flashes.value += 1;
    screenshotStatus.value = 'added';
  } catch (error) {
    console.error('[design preview] the screenshot failed', error);
    screenshotStatus.value = 'failed';
  } finally {
    capturing.value = false;
  }
}

// Markup (PD-12): main captures the live view and hides it while markup is on; the marks stay in shell memory per tab.
const session = computed(() => markupSession(props.tab.id));
const markupOn = computed(() => session.value?.active === true);
const marksWaiting = computed(() => (markupOn.value ? 0 : session.value?.marks.length ?? 0));
const freezing = ref(false);
const sending = ref(false);
const freezeFailed = ref(false);
const markupNotice = ref<'sendFailed' | 'limit' | null>(null);
const markupShake = ref(0);
const markupButton = ref<{ $el: HTMLElement } | null>(null);
const tweaksButton = ref<{ $el: HTMLElement } | null>(null);
const markupToolbar = ref<InstanceType<typeof MarkupToolbar> | null>(null);
const markupLayer = ref<InstanceType<typeof MarkupLayer> | null>(null);
const markupBlocked = computed(() => freezing.value || glides.value || tweaksApplied.value > 0 || (preview.value.status !== 'ready' && marksWaiting.value === 0));

watch(() => [session.value?.marks, session.value?.tool], () => {
  markupNotice.value = null;
});

// The polite live region; emptied first, so the same message twice is said twice.
const markupAnnouncement = ref('');
function announce(text: string): void {
  markupAnnouncement.value = '';
  void nextTick(() => {
    markupAnnouncement.value = text;
  });
}

// Focus that waits for its control: the two toolbar rows swap out-in, so the incoming row mounts only after the outgoing
// row's leave ends (also under reduced motion), and the control that held focus leaves with its row.
const pendingFocus = ref<'markupTool' | 'markupButton' | 'tweaksButton' | null>(null);
function focusPending(): boolean {
  if (pendingFocus.value === 'markupTool') return markupToolbar.value?.focusTool() === true;
  const button = pendingFocus.value === 'markupButton' ? markupButton.value : tweaksButton.value;
  button?.$el.focus();
  return button !== null;
}
watch([pendingFocus, markupToolbar, markupButton, tweaksButton], () => {
  if (pendingFocus.value !== null && focusPending()) pendingFocus.value = null;
}, { flush: 'post' });

// Resolves once the preset glide ended, or false when the tab unmounted first; a transition that never reports its end
// gives up after its duration.
let stopGlideWait: (() => void) | undefined;
function glideEnded(): Promise<boolean> {
  if (!glides.value) return Promise.resolve(true);
  return new Promise((resolve) => {
    const stop = watch(glides, (gliding) => {
      if (!gliding) finish(true);
    });
    const timer = setTimeout(() => finish(true), GLIDE_MS + GLIDE_SLACK_MS);
    function finish(ended: boolean): void {
      clearTimeout(timer);
      stop();
      stopGlideWait = undefined;
      animating.value = false;
      resolve(ended);
    }
    stopGlideWait = () => finish(false);
  });
}

// Reopening a tab that holds marks reuses its capture and first returns the preview to the frozen width.
async function openMarkup(): Promise<void> {
  if (markupBlocked.value || markupOn.value) return;
  freezing.value = true;
  freezeFailed.value = false;
  try {
    const kept = session.value;
    if (kept && kept.marks.length > 0) {
      if (width.value !== kept.freeze.width) {
        setWidth(kept.freeze.width, true);
        persist(width.value);
      }
      if (!await glideEnded()) return;
      await props.api.designMarkupEnter(props.tab.id);
      kept.active = true;
    } else {
      const freeze = await props.api.designFreeze(props.tab.id);
      const image = new Image();
      image.src = freeze.png;
      // Main turned markup on with the freeze, so a capture the shell cannot show turns it off again.
      await image.decode().catch(async (error: unknown) => {
        await props.api.designMarkupExit(props.tab.id).catch(reportRefusal);
        throw error;
      });
      startMarkupSession(props.tab.id, freeze);
      flashes.value += 1;
    }
    pendingFocus.value = 'markupTool';
  } catch (error) {
    console.error('[design preview] markup could not start', error);
    freezeFailed.value = true;
  } finally {
    freezing.value = false;
  }
}

async function exitMarkup(): Promise<void> {
  const current = session.value;
  if (!current) return;
  current.active = false;
  if (current.marks.length === 0) dropMarkupSession(props.tab.id);
  markupNotice.value = null;
  pendingFocus.value = 'markupButton';
  await props.api.designMarkupExit(props.tab.id).catch(reportRefusal);
}

// Send flattens the marks onto the capture; main toasts a refusal's reason, and the marks stay for a retry. A send main
// accepted turns markup off in main.
async function sendMarkup(): Promise<void> {
  const current = session.value;
  if (!current || sending.value || current.marks.length === 0 || !markupLayer.value) return;
  sending.value = true;
  markupNotice.value = null;
  let sent: { feedbackId: string };
  try {
    const png = await flattenMarkup(current, markupLayer.value.displayedWidth(), resolveMarkupColors());
    sent = await props.api.designMarkupSend({ tabId: props.tab.id, png, json: markupJson(current) });
  } catch (error) {
    console.error('[design preview] the markup was not sent', error);
    markupNotice.value = 'sendFailed';
    markupShake.value += 1;
    return;
  } finally {
    sending.value = false;
  }
  dropMarkupSession(props.tab.id);
  flashes.value += 1;
  announce(t('editor.designPreview.markup.sent', { id: sent.feedbackId }));
  pendingFocus.value = 'markupButton';
}

function refuseMark(): void {
  markupNotice.value = 'limit';
  markupShake.value += 1;
}

// Z by its letter on a Latin layout (AZERTY's Z included), else by its place, since a Greek layout's key reads ζ.
function isZ(event: KeyboardEvent): boolean {
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === 'z' : event.code === 'KeyZ';
}

// Ctrl+Z (Cmd+Z) undoes a mark anywhere in the tab, except in a text field, whose own undo it is.
async function onTabKeydown(event: KeyboardEvent): Promise<void> {
  const current = session.value;
  if (!markupOn.value || !current || sending.value || !isZ(event) || event.shiftKey || event.altKey) return;
  if (!(props.platform === 'darwin' ? event.metaKey : event.ctrlKey)) return;
  if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable]')) return;
  event.preventDefault();
  event.stopPropagation();
  if (!undoMarks(current)) return;
  announce(t('editor.designPreview.markup.undone'));
  // An undo can take away the pin that held focus.
  await nextTick();
  const focused = document.activeElement;
  if (!focused || focused === document.body || !focused.isConnected) markupLayer.value?.focusCanvas();
}

// Tweaks: the column sits beside the stage, never over the native view, so opening it shrinks the stage and the frame with it.
const tweaksOpen = computed(() => tweaks.value !== null && tweaksSession(props.tab.id)?.open === true);
function toggleTweaks(): void {
  const session = ensureTweaksSession(props.tab.id);
  session.open = !session.open;
}
function tweaksMotion(phase: 'enter' | 'leave'): string {
  if (prefersReducedMotion()) return '';
  return phase === 'enter' ? 'animate-[d-zoom_.26s_var(--ease-out)]' : 'animate-[d-zoom-out_.16s_ease-in_both]';
}
function closeTweaks(): void {
  const session = tweaksSession(props.tab.id);
  if (session) session.open = false;
  // While markup is on the Tweaks button is not shown, so focus goes to the markup tools.
  pendingFocus.value = markupOn.value ? 'markupTool' : 'tweaksButton';
}

// Replay in preview: main drives the live view and posts each step's outcome; the strip shows them and clears a while after the end.
const REPLAY_HOLD_MS = 4000;
const replay = ref<DesignReplayProgress | null>(null);
let replayClear: ReturnType<typeof setTimeout> | undefined;
function onReplay(progress: DesignReplayProgress): void {
  if (progress.tabId !== props.tab.id) return;
  clearTimeout(replayClear);
  replay.value = progress;
  if (progress.done) replayClear = setTimeout(() => { replay.value = null; }, REPLAY_HOLD_MS);
}
type ReplayDot = 'pending' | 'active' | 'pass' | 'fail';
const replayView = computed(() => {
  const progress = replay.value;
  if (!progress) return null;
  const total = progress.steps.length;
  const passed = progress.results.filter((result) => result.ok).length;
  const failed = progress.results.findIndex((result) => !result.ok);
  const dots = progress.steps.map((_, index): ReplayDot => {
    const result = progress.results[index];
    if (result) return result.ok ? 'pass' : 'fail';
    return index === progress.active ? 'active' : 'pending';
  });
  if (!progress.done) {
    const at = progress.active ?? progress.results.length;
    return { outcome: 'running' as const, text: t('editor.designPreview.replay.running', { n: Math.min(at + 1, total), total }), step: progress.active, dots, animate: !progress.reducedMotion };
  }
  if (failed !== -1) return { outcome: 'failed' as const, text: t('editor.designPreview.replay.failed', { n: failed + 1 }), step: failed, dots, animate: !progress.reducedMotion };
  const outcome = passed === total ? 'passed' as const : 'stopped' as const;
  return { outcome, text: t(`editor.designPreview.replay.${outcome}`, { passed, total }), step: null, dots, animate: !progress.reducedMotion };
});
const replayStep = computed(() => {
  const index = replayView.value?.step;
  return index === null || index === undefined ? undefined : replay.value?.steps[index];
});
const REPLAY_DOT: Record<ReplayDot, string> = {
  pending: 'bg-(--d-border2)',
  active: 'd-ring bg-(--d-design) text-(--d-design)',
  pass: 'bg-(--d-success)',
  fail: 'bg-(--d-danger)',
};

// The frame's outer corner radius in CSS px: main lays the view over the frame's border box and rounds its corners to this.
function frameRadius(): number {
  const element = frame.value;
  if (!element) return 0;
  return Math.max(0, Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0);
}

// Main covers exactly the frame with the design's view and zooms it so its CSS viewport is the chosen width; a frame too
// small for any zoom main accepts shows no view, and the frame says so.
const tooNarrow = ref(false);
function report(bounds: { x: number; y: number; width: number; height: number }): void {
  const reported = bounds.width / width.value;
  tooNarrow.value = bounds.height > 0 && reported < MIN_DESIGN_ZOOM;
  if (bounds.height === 0 || reported < MIN_DESIGN_ZOOM || reported > MAX_DESIGN_ZOOM) {
    props.api.reportDesignPreviewBounds(null);
    return;
  }
  props.api.reportDesignPreviewBounds({ tabId: props.tab.id, ...bounds, radius: frameRadius(), zoom: reported });
}
const frameStatus = computed(() => {
  if (preview.value.status !== 'ready') return preview.value.status;
  return tooNarrow.value && !markupOn.value ? 'tooNarrow' as const : null;
});
// A new width can leave the frame's size unchanged (a zoomed frame stays as wide as the pane), so no resize reports it.
watch(width, () => {
  if (frame.value) report(boundsOf(frame.value));
}, { flush: 'post' });

let stopBounds: (() => void) | undefined;
let stageObserver: ResizeObserver | undefined;
let stopReplay: (() => void) | undefined;
onMounted(() => {
  stopReplay = props.api.onDesignReplay(onReplay);
  const element = frame.value;
  if (!element || !stage.value) return;
  stageObserver = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box) stageSize.value = { width: box.width, height: box.height };
  });
  stageObserver.observe(stage.value);
  // The stage is a neighbour: the Tweaks column moves the frame by resizing the stage, which may leave the frame's size as it was.
  const neighbours = [stage.value, ...document.querySelectorAll<HTMLElement>('[data-testid="title-bar"], [data-testid="layout-grid"], [data-testid^="grid-pane-"]')];
  stopBounds = watchContentBounds(element, neighbours, report);
});
onBeforeUnmount(() => {
  stopGlideWait?.();
  stopReplay?.();
  clearTimeout(replayClear);
  cancelAnimationFrame(dragFrame);
  stageObserver?.disconnect();
  stopBounds?.();
  props.api.reportDesignPreviewBounds(null);
});

const widthId = useId();
const PILL = 'pointer-events-none absolute bottom-2.5 flex h-5.5 items-center gap-1.5 rounded-full border border-(--d-border) bg-(--d-panel) px-2 text-11 whitespace-nowrap shadow-[0_0.25rem_0.75rem_-0.25rem_var(--d-scrim)]';
</script>

<template>
  <div
    data-testid="design-preview-tab"
    class="@container/tab absolute inset-0 flex flex-col"
    :aria-label="t('editor.designPreview.label')"
    role="group"
    @keydown="onTabKeydown"
  >
    <div class="@container shrink-0 border-b border-(--d-border) bg-(--d-panel) px-2.5 py-1.5">
      <div class="flex flex-col gap-1.5">
        <!-- Groups, not toolbars: they hold a text field and toggle groups that keep their own arrow keys. -->
        <div
          role="group"
          :aria-label="t('editor.designPreview.widthToolbar')"
          data-testid="design-preview-width-toolbar"
          class="flex flex-wrap items-center gap-x-2 gap-y-1.5"
        >
          <ToggleGroup
            v-if="preview.info"
            type="single"
            :model-value="exactPreset ?? ''"
            :aria-label="t('editor.designPreview.breakpoints')"
            data-testid="design-preview-presets"
            :disabled="markupOn || freezing"
            class="gap-0.5 rounded-7 border border-(--d-border) bg-(--d-bg) p-0.5 @max-[30rem]:basis-full @max-[30rem]:justify-start @max-[30rem]:overflow-x-auto"
            @update:model-value="onPreset"
          >
            <ToggleGroupItem
              v-for="preset in presets"
              :key="preset.name"
              :value="preset.name"
              data-testid="design-preview-preset"
              :data-preset="preset.name"
              :data-band="preset.name === band || undefined"
              :data-primary="preset.name === primaryBand || undefined"
              :title="preset.name === primaryBand ? t('editor.designPreview.presetPrimary', { preset: `${preset.name} · ${preset.width} px` }) : `${preset.name} · ${preset.width} px`"
              :class="cn(
                'relative h-5.5 min-w-8.5 rounded-5 px-2 font-mono text-11 font-normal text-(--d-muted) transition-[color,background-color,box-shadow] duration-150 hover:bg-transparent hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 data-[state=on]:bg-(--d-hover) data-[state=on]:text-(--d-text)',
                preset.name === band && 'text-(--d-text) shadow-[inset_0_0_0_1px_var(--d-border2)]',
              )"
            >
              {{ preset.name }}
              <span
                v-if="preset.name === primaryBand"
                aria-hidden="true"
                data-testid="design-preview-primary-dot"
                class="absolute top-0.75 right-0.75 size-1 rounded-full bg-(--d-design)"
              />
            </ToggleGroupItem>
          </ToggleGroup>
          <div class="flex h-6.5 items-center gap-1 rounded-7 border border-(--d-border) bg-(--d-input) pr-2 pl-1 font-mono text-11.5 transition-[border-color,box-shadow] duration-150 focus-within:border-(--d-accent) focus-within:shadow-[0_0_0_3px_var(--d-accent-soft)] hover:border-(--d-border2)">
            <label
              :for="widthId"
              class="sr-only"
            >{{ t('editor.designPreview.width', { min: MIN_DESIGN_WIDTH, max: MAX_DESIGN_WIDTH }) }}</label>
            <Input
              :id="widthId"
              :model-value="typed"
              type="text"
              inputmode="numeric"
              spellcheck="false"
              autocomplete="off"
              data-testid="design-preview-width"
              :disabled="markupOn || freezing"
              class="h-full w-12 rounded-none border-0 bg-transparent p-0 text-right font-mono text-11.5 text-(--d-text) tabular-nums shadow-none ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              @update:model-value="onWidthInput"
              @keydown="onWidthKeydown"
              @blur="commitTyped"
            />
            <span
              aria-hidden="true"
              class="text-(--d-faint-text)"
            >px</span>
          </div>
          <Button
            variant="ghost"
            data-testid="design-preview-fit"
            :disabled="markupOn || freezing"
            :class="TOOLBAR_BUTTON"
            :title="t('editor.designPreview.fitTitle')"
            @click="fit"
          >
            {{ t('editor.designPreview.fit') }}
          </Button>
          <Button
            variant="ghost"
            data-testid="design-preview-browser"
            :class="cn(TOOLBAR_BUTTON, 'ms-auto')"
            :title="t('editor.designPreview.browserTitle')"
            @click="openInBrowser"
          >
            <ExternalLink aria-hidden="true" />{{ t('editor.designPreview.browser') }}
          </Button>
        </div>
        <Transition
          name="t-swap-box"
          mode="out-in"
        >
          <div
            v-if="markupOn && session"
            key="markup"
            role="group"
            :aria-label="t('editor.designPreview.markup.toolbar')"
            data-testid="design-preview-view-toolbar"
            data-markup
          >
            <MarkupToolbar
              ref="markupToolbar"
              :session="session"
              :sending="sending"
              :notice="markupNotice"
              :shake="markupShake"
              :mac="platform === 'darwin'"
              @exit="exitMarkup"
              @send="sendMarkup"
              @announce="announce"
            />
          </div>
          <div
            v-else
            key="view"
            role="group"
            :aria-label="t('editor.designPreview.viewToolbar')"
            data-testid="design-preview-view-toolbar"
            class="flex flex-wrap items-center gap-x-3 gap-y-1.5"
          >
            <SegmentedToggle
              v-if="states.length > 0"
              :model-value="preview.state"
              :options="states.map((state) => ({ value: state, label: state, attrs: { 'data-testid': 'design-preview-state', 'data-state-name': state } }))"
              indicator-class="text-(--d-hover)"
              :aria-label="t('editor.designPreview.states')"
              data-testid="design-preview-states"
              class="border border-(--d-border) bg-(--d-bg)"
              @update:model-value="setState"
            />
            <label
              class="flex cursor-pointer items-center gap-1.5 text-12 whitespace-nowrap text-(--d-muted)"
              :title="t('editor.designPreview.provenanceTitle')"
            >
              <ToggleSwitch
                :checked="preview.provenance"
                data-testid="design-preview-provenance"
                @update:checked="setProvenance"
              />
              {{ t('editor.designPreview.provenance') }}
            </label>
            <Button
              variant="ghost"
              data-testid="design-preview-screenshot"
              :class="TOOLBAR_BUTTON"
              :title="t('editor.designPreview.screenshotTitle')"
              :aria-disabled="screenshotBlocked || undefined"
              :aria-busy="capturing || undefined"
              @click="screenshot"
            >
              <LoaderCircle
                v-if="capturing"
                aria-hidden="true"
                class="d-spinning"
              />
              <Camera
                v-else
                aria-hidden="true"
              />{{ t('editor.designPreview.screenshot') }}
            </Button>
            <span
              role="status"
              data-testid="design-preview-screenshot-status"
              :data-status="screenshotStatus ?? undefined"
              class="flex items-center gap-1 text-11.5 whitespace-nowrap"
              :class="screenshotStatus === 'failed' ? 'text-(--d-danger-text)' : 'sr-only'"
            >
              <CircleAlert
                v-if="screenshotStatus === 'failed'"
                aria-hidden="true"
                class="size-3.25 flex-none"
              />
              <template v-if="screenshotStatus">{{ t(screenshotStatus === 'added' ? 'editor.designPreview.screenshotAdded' : 'editor.designPreview.screenshotFailed') }}</template>
            </span>
            <Button
              ref="markupButton"
              variant="ghost"
              data-testid="design-preview-markup"
              :class="TOOLBAR_BUTTON"
              :title="tweaksApplied > 0 ? t('editor.designPreview.markup.tweaksApplied') : t('editor.designPreview.markup.buttonTitle')"
              :aria-label="marksWaiting > 0 ? t('editor.designPreview.markup.buttonWaiting', { n: marksWaiting }, marksWaiting) : undefined"
              :aria-disabled="markupBlocked || undefined"
              :aria-busy="freezing || undefined"
              @click="openMarkup"
            >
              <LoaderCircle
                v-if="freezing"
                aria-hidden="true"
                class="d-spinning"
              />
              <PencilLine
                v-else
                aria-hidden="true"
              />{{ t('editor.designPreview.markup.button') }}
              <Transition name="t-badge">
                <span
                  v-if="marksWaiting > 0"
                  aria-hidden="true"
                  data-testid="design-preview-markup-count"
                  class="flex h-4 min-w-4 items-center justify-center rounded-full bg-(--d-design) px-1 text-10 font-semibold text-(--d-on-design) tabular-nums"
                >{{ marksWaiting }}</span>
              </Transition>
            </Button>
            <span
              v-if="freezeFailed"
              role="status"
              data-testid="design-preview-markup-status"
              class="flex items-center gap-1 text-11.5 whitespace-nowrap text-(--d-danger-text)"
            >
              <CircleAlert
                aria-hidden="true"
                class="size-3.25 flex-none"
              />{{ t('editor.designPreview.markup.freezeFailed') }}
            </span>
            <Button
              v-if="tweaks"
              ref="tweaksButton"
              variant="ghost"
              data-testid="design-preview-tweaks"
              :aria-pressed="tweaksOpen"
              :class="cn(TOOLBAR_BUTTON, tweaksOpen && 'bg-[color-mix(in_srgb,var(--d-design)_14%,transparent)] text-(--d-design-text) hover:bg-[color-mix(in_srgb,var(--d-design)_20%,transparent)] hover:text-(--d-design-text)')"
              :title="t('editor.designPreview.tweaks.buttonTitle')"
              @click="toggleTweaks"
            >
              <SlidersHorizontal aria-hidden="true" />{{ t('editor.designPreview.tweaks.button') }}
              <Transition name="t-badge">
                <span
                  v-if="tweaksApplied > 0"
                  data-testid="design-preview-tweaks-count"
                  class="flex h-4 min-w-4 items-center justify-center rounded-full bg-(--d-design) px-1 text-10 font-semibold text-(--d-on-design) tabular-nums"
                ><span aria-hidden="true">{{ tweaksApplied }}</span><span class="sr-only">{{ t('editor.designPreview.tweaks.applied', { n: tweaksApplied }, tweaksApplied) }}</span></span>
              </Transition>
            </Button>
            <span
              data-testid="design-preview-path"
              dir="ltr"
              :title="preview.path"
              class="ms-auto min-w-0 truncate font-mono text-11 text-(--d-faint-text) @max-[30rem]:ms-0 @max-[30rem]:basis-full"
            >{{ preview.relPath }}</span>
          </div>
        </Transition>
      </div>
    </div>
    <div class="flex min-h-0 flex-1 @max-[34rem]/tab:flex-col">
      <div
        ref="stage"
        data-testid="design-preview-stage"
        class="design-stage @container/stage relative min-h-0 min-w-0 flex-1 overflow-hidden"
        :class="dragging && 'cursor-ew-resize select-none'"
      >
        <!-- Main lays the design's view over exactly this frame while the preview is ready; until then it shows the state. -->
        <div
          ref="frame"
          data-testid="design-preview-frame"
          :data-glide="glides || undefined"
          :data-markup="markupOn || undefined"
          class="absolute top-4 left-1/2 -translate-x-1/2 overflow-hidden rounded-md border bg-(--d-bg)"
          :class="[
            glides && 'design-frame-glide',
            markupOn
              ? 'border-(--d-design) shadow-[0_0_0_3px_color-mix(in_srgb,var(--d-design)_22%,transparent),0_1rem_2.5rem_-0.75rem_var(--d-scrim)]'
              : 'border-(--d-border2) shadow-[0_1rem_2.5rem_-0.75rem_var(--d-scrim)]',
          ]"
          :style="{ width: `${frameWidth}px`, height: `${room.height}px` }"
          @transitionend="onFrameTransitionEnd"
          @transitioncancel="onFrameTransitionEnd"
        >
          <Transition
            name="t-fade"
            mode="out-in"
          >
            <div
              v-if="frameStatus"
              :key="frameStatus"
              data-testid="design-preview-status"
              :data-status="frameStatus"
              role="status"
              class="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center"
            >
              <img
                v-if="preview.status === 'reconnecting' && lastFrame"
                :src="lastFrame"
                alt=""
                data-testid="design-preview-last-frame"
                class="absolute inset-0 size-full object-cover object-top-left opacity-35"
              >
              <span class="d-state-icon relative flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint-text)">
                <LoaderCircle
                  v-if="preview.status === 'loading' || preview.status === 'reconnecting'"
                  aria-hidden="true"
                  class="d-spinning size-5"
                />
                <CloudOff
                  v-else-if="preview.status === 'updateServer'"
                  aria-hidden="true"
                  class="size-5 text-(--d-warning-text)"
                />
                <MoveHorizontal
                  v-else-if="frameStatus === 'tooNarrow'"
                  aria-hidden="true"
                  class="size-5"
                />
                <CircleAlert
                  v-else
                  aria-hidden="true"
                  class="size-5 text-(--d-danger-text)"
                />
              </span>
              <p class="relative max-w-80 rounded-md bg-(--d-bg)/80 px-2 py-0.5 text-12.5 text-pretty text-(--d-muted)">
                {{ t(`editor.designPreview.${frameStatus}`, { width }) }}
              </p>
            </div>
          </Transition>
          <MarkupLayer
            v-if="markupOn && session"
            ref="markupLayer"
            :session="session"
            :sending="sending"
            @announce="announce"
            @limit="refuseMark"
          />
        </div>
        <!-- The flash rings the frame outside the native view, which covers the frame itself. -->
        <div
          v-if="flashes > 0"
          :key="flashes"
          aria-hidden="true"
          data-testid="design-preview-flash"
          class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 animate-[d-flash_.7s_var(--ease-out)_both] rounded-md shadow-[0_0_0_2px_var(--d-design),0_0_1.5rem_0.25rem_color-mix(in_srgb,var(--d-design)_55%,transparent)]"
          :style="{ width: `${frameWidth}px`, height: `${room.height}px` }"
        />
        <div
          v-if="!markupOn"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          :aria-label="t('editor.designPreview.handle')"
          :aria-valuenow="width"
          :aria-valuemin="MIN_DESIGN_WIDTH"
          :aria-valuemax="MAX_DESIGN_WIDTH"
          :aria-valuetext="readoutText"
          :title="t('editor.designPreview.handleTitle')"
          data-testid="design-preview-handle"
          :data-dragging="dragging || undefined"
          class="design-handle absolute top-4 left-1/2 flex w-3 cursor-ew-resize touch-none items-center justify-center outline-none"
          :class="glides && 'design-frame-glide'"
          :style="{ height: `${room.height}px`, transform: `translateX(${frameWidth / 2 + remPx(HANDLE_GAP_REM)}px)` }"
          @pointerdown="onHandleDown"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
          @keydown="onHandleKeydown"
        />
        <!-- A replay takes the readout's place in the gutter, beside the sandbox chip, and gives it back when it clears. -->
        <Transition
          name="t-pop-top"
          mode="out-in"
        >
          <div
            v-if="replayView"
            role="group"
            :aria-label="t('editor.designPreview.replay.label')"
            data-testid="design-preview-replay"
            :data-outcome="replayView.outcome"
            :class="cn(PILL, 'left-3 max-w-[calc(100%-14rem)] gap-2 border-[color-mix(in_srgb,var(--d-design)_40%,var(--d-border))] @max-[30rem]/stage:max-w-[calc(100%-1.5rem)]')"
          >
            <LoaderCircle
              v-if="replayView.outcome === 'running'"
              aria-hidden="true"
              class="d-spinning size-3 flex-none text-(--d-design)"
            />
            <CircleCheck
              v-else-if="replayView.outcome === 'passed'"
              aria-hidden="true"
              class="size-3 flex-none text-(--d-success-text)"
            />
            <CircleX
              v-else-if="replayView.outcome === 'failed'"
              aria-hidden="true"
              class="size-3 flex-none text-(--d-danger-text)"
            />
            <Ban
              v-else
              aria-hidden="true"
              class="size-3 flex-none text-(--d-muted)"
            />
            <span
              role="status"
              data-testid="design-preview-replay-status"
              class="flex-none font-medium text-(--d-text) tabular-nums"
            >{{ replayView.text }}</span>
            <span
              aria-hidden="true"
              class="flex flex-none items-center gap-0.5"
            >
              <span
                v-for="(dot, index) in replayView.dots"
                :key="`${index}:${dot}`"
                data-testid="design-preview-replay-dot"
                :data-state="dot"
                class="size-1.25 rounded-full"
                :class="[REPLAY_DOT[dot], replayView.animate && (dot === 'pass' || dot === 'fail') && 'animate-[d-badge-pop_.34s_var(--ease-spring)_both]']"
              />
            </span>
            <Transition
              :name="replayView.animate ? 't-swap-box' : ''"
              mode="out-in"
            >
              <span
                v-if="replayStep"
                :key="replayView.step ?? -1"
                data-testid="design-preview-replay-step"
                class="min-w-0 truncate text-(--d-muted) @max-[36rem]/stage:hidden"
              ><JourneyStepText :step="replayStep" /></span>
            </Transition>
          </div>
          <span
            v-else
            aria-hidden="true"
            data-testid="design-preview-readout"
            :class="cn(PILL, 'left-3 font-mono text-(--d-text) tabular-nums')"
          >{{ readoutText }}</span>
        </Transition>
        <span
          data-testid="design-preview-sandbox"
          :class="cn(PILL, 'right-3 text-(--d-muted)')"
        >
          <span
            aria-hidden="true"
            class="size-1.5 rounded-full bg-(--d-success) shadow-[0_0_0.375rem_var(--d-success)]"
          />
          {{ t('editor.designPreview.sandboxed') }}
        </span>
      </div>
      <!-- Its width never animates: the stage takes the room in one layout, and the column only zooms in (d-zoom) beside it. -->
      <Transition
        :enter-active-class="tweaksMotion('enter')"
        :leave-active-class="tweaksMotion('leave')"
      >
        <TweaksPanel
          v-if="tweaksOpen && tweaks"
          :api="api"
          :tab-id="tab.id"
          :declaration="tweaks"
          :applied="appliedTweaks"
          :paused="markupOn || freezing"
          class="w-64 flex-none origin-right @max-[34rem]/tab:max-h-[45%] @max-[34rem]/tab:w-full @max-[34rem]/tab:origin-bottom @max-[34rem]/tab:border-s-0 @max-[34rem]/tab:border-t"
          @close="closeTweaks"
          @announce="announce"
        />
      </Transition>
    </div>
    <span
      role="status"
      aria-live="polite"
      data-testid="design-markup-announcement"
      class="sr-only"
    >{{ markupAnnouncement }}</span>
  </div>
</template>
