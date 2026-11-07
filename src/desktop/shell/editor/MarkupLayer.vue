<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRaw, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { ReferenceElement } from 'reka-ui';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import SegmentedToggle from '@/components/SegmentedToggle.vue';
import { remPx } from '@/composables/useRemPx';
import { cn } from '@/lib/utils';
import { MAX_MARKUP_MARKS, MAX_MARKUP_PIN_TEXT } from '../../../shared/design-markup';
import { arrowPath, clampPoint, cssSize, displayedToCss, penPath, pinPopoverSide, resolveAnchor, shapeBox, snapAngle, squareEnd, type MarkupElement, type MarkupPoint } from './markup';
import MarkupStroke from './MarkupStroke.vue';
import { addMark, commitMarks, newMarkId, pinNumbers, removeMark, replaceMark, type MarkDraft, type MarkupSession, type PinDraft, type PinKind, type StrokeDraft } from './markup-session';
import { BOX_RADIUS_PX, PIN_INSET_REM, PIN_POPOVER_GAP_REM, PIN_POPOVER_REM, pinInsetPx, pinPx, STROKE_CLASS, STROKE_PX, WING_PX } from './markup-style';

// The drawing surface over the frozen capture (PD-12): strokes in an SVG whose user units are the capture's CSS px, pins as
// buttons placed in % of the image box, and each pin's popover.
const props = defineProps<{ session: MarkupSession; sending: boolean }>();
const emit = defineEmits<{ announce: [text: string]; limit: [] }>();
const { t, n: formatNumber } = useI18n();

const freeze = computed(() => props.session.freeze);
// the capture's CSS px height, which pointer mapping and the flattened PNG use too
const height = computed(() => cssSize(freeze.value).height);
const marks = computed(() => props.session.marks);
const tool = computed(() => props.session.tool);
const numbers = computed(() => pinNumbers(marks.value));
const strokes = computed(() => marks.value.filter((mark): mark is StrokeDraft => mark.type !== 'pin'));
const pins = computed(() => marks.value.filter((mark): mark is PinDraft => mark.type === 'pin'));

const canvas = ref<HTMLElement | null>(null);
// The chat's native view draws over the shell outside the preview, so a popover kept inside the layer is never hidden by it.
const layer = ref<HTMLElement | null>(null);
// shell px per CSS px of the capture, as the image shows now
const displayedWidth = ref(0);
const scale = computed(() => (displayedWidth.value > 0 ? displayedWidth.value / freeze.value.width : 1));
const helpId = useId();

// Screen sizes in shell px; divided by scale they are user units of the SVG.
const TAP_PX = 3;
const PEN_STEP_PX = 2;
const MAX_PEN_POINTS = 4096;
const MIN_ARROW_PX = 8;
const MIN_BOX_PX = 6;
const MOVE_STEP = 4;
const MOVE_STEP_SHIFT = 24;
const MOVE_SETTLE_MS = 600;

function pointOf(event: PointerEvent | MouseEvent): MarkupPoint {
  const box = canvas.value!.getBoundingClientRect();
  return displayedToCss([event.clientX - box.left, event.clientY - box.top], box.width, freeze.value);
}

const percent = (point: MarkupPoint): { left: string; top: string } => ({
  left: `${(point[0] / freeze.value.width) * 100}%`,
  top: `${(point[1] / height.value) * 100}%`,
});
const rectStyle = (element: MarkupElement): Record<string, string> => ({
  left: `${(element.rect[0] / freeze.value.width) * 100}%`,
  top: `${(element.rect[1] / height.value) * 100}%`,
  width: `${(element.rect[2] / freeze.value.width) * 100}%`,
  height: `${(element.rect[3] / height.value) * 100}%`,
});
// A pin's center stays inside the image so an edge pin is not clipped; its `at` keeps the true point.
const pinStyle = (point: MarkupPoint): Record<string, string> => {
  const { left, top } = percent(point);
  const inset = `${PIN_INSET_REM}rem`;
  return { left: `clamp(${inset}, ${left}, calc(100% - ${inset}))`, top: `clamp(${inset}, ${top}, calc(100% - ${inset}))` };
};

// The element under the pointer (Pin tool), a dragged pin or a focused pin, and the halo a placement plays.
const snap = ref<MarkupElement | null>(null);
const halo = ref(0);
const snapTagInside = computed(() => snap.value !== null && snap.value.rect[1] * scale.value < remPx(1.25));

// Draw-in motion: a stroke drawn by hand (arrow, box) draws at once; one that comes back (reopen, undo) draws staggered.
const drawn = new Map<number, Record<string, string>>();
let drawnByHand: number | null = null;
function noteNewStrokes(next: readonly MarkDraft[], restoring: boolean): void {
  const ids = new Set(next.map((mark) => mark.id));
  for (const id of drawn.keys()) if (!ids.has(id)) drawn.delete(id);
  let index = 0;
  for (const mark of next) {
    if (mark.type === 'pin' || drawn.has(mark.id)) continue;
    if (mark.id === drawnByHand) {
      drawn.set(mark.id, mark.type === 'pen' ? {} : { '--len': '1', animationDuration: '.28s' });
    } else if (restoring) {
      drawn.set(mark.id, { '--len': '1', animationDuration: '.45s', animationDelay: `${Math.min(index, 8) * 40}ms` });
      index++;
    }
  }
  drawnByHand = null;
}
noteNewStrokes(marks.value, true);
watch(marks, (next) => noteNewStrokes(next, true));
const pinDelay = ref(new Map<number, string>(pins.value.map((pin, index) => [pin.id, `${Math.min(index, 8) * 30}ms`])));

// The stroke being drawn: a pen's kept points, or an arrow's or a box's start and current end.
const drawing = ref<{ pointerId: number; type: StrokeDraft['type']; points: MarkupPoint[] } | null>(null);
let pinPress: { pointerId: number; x: number; y: number } | null = null;
let frame = 0;
let pendingMove: PointerEvent | null = null;

function sideOf(points: readonly MarkupPoint[]): { width: number; height: number } {
  const box = shapeBox(points);
  return { width: box[2] * scale.value, height: box[3] * scale.value };
}

function shapeEnd(start: MarkupPoint, end: MarkupPoint, type: StrokeDraft['type'], shift: boolean): MarkupPoint {
  if (!shift) return end;
  return clampPoint(type === 'arrow' ? snapAngle(start, end) : squareEnd(start, end), freeze.value);
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || props.sending || (event.target as Element).closest('[data-markup-pin]')) return;
  const point = pointOf(event);
  canvas.value!.setPointerCapture(event.pointerId);
  if (tool.value === 'pin') {
    pinPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    return;
  }
  if (props.session.marks.length >= MAX_MARKUP_MARKS) {
    emit('limit');
    return;
  }
  drawing.value = { pointerId: event.pointerId, type: tool.value, points: [point, point] };
  if (tool.value === 'pen') drawing.value.points = [point];
}

function onPointerMove(event: PointerEvent): void {
  if (tool.value === 'pin' && !drawing.value) {
    snap.value = resolveAnchor(pointOf(event), freeze.value.elements);
    return;
  }
  if (drawing.value?.pointerId !== event.pointerId) return;
  pendingMove = event;
  if (frame !== 0) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const move = pendingMove;
    pendingMove = null;
    if (move) extend(move);
  });
}

function extend(event: PointerEvent): void {
  const current = drawing.value;
  if (!current) return;
  if (current.type === 'pen') {
    const step = PEN_STEP_PX / scale.value;
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const sample of events.length > 0 ? events : [event]) {
      if (current.points.length >= MAX_PEN_POINTS) break;
      const point = pointOf(sample);
      const last = current.points[current.points.length - 1]!;
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= step) current.points.push(point);
    }
    return;
  }
  current.points = [current.points[0]!, shapeEnd(current.points[0]!, pointOf(event), current.type, event.shiftKey)];
}

function onPointerUp(event: PointerEvent): void {
  if (pinPress?.pointerId === event.pointerId) {
    const tap = Math.hypot(event.clientX - pinPress.x, event.clientY - pinPress.y) <= TAP_PX;
    pinPress = null;
    if (tap) placePin(pointOf(event));
    return;
  }
  const current = drawing.value;
  if (current?.pointerId !== event.pointerId) return;
  cancelAnimationFrame(frame);
  frame = 0;
  if (pendingMove) extend(pendingMove);
  pendingMove = null;
  drawing.value = null;
  commitStroke(current.type, toRaw(current.points));
}

function commitStroke(type: StrokeDraft['type'], points: MarkupPoint[]): void {
  const side = sideOf(points);
  const [start, end] = [points[0]!, points[points.length - 1]!];
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]) * scale.value;
  if (type === 'pen' && side.width < TAP_PX && side.height < TAP_PX) return;
  if (type === 'arrow' && length < MIN_ARROW_PX) return;
  if (type === 'box' && (side.width < MIN_BOX_PX || side.height < MIN_BOX_PX)) return;
  const mark: StrokeDraft = { id: newMarkId(), type, points };
  drawnByHand = mark.id;
  if (!addMark(props.session, mark)) {
    drawnByHand = null;
    emit('limit');
    return;
  }
  emit('announce', t(`editor.designPreview.markup.added.${type}`));
}

function onPointerCancel(event: PointerEvent): void {
  if (pinPress?.pointerId === event.pointerId) pinPress = null;
  if (drawing.value?.pointerId === event.pointerId) drawing.value = null;
}

function onPointerLeave(): void {
  if (!drawing.value && draggingPin.value === null && focusedPin.value === null) snap.value = null;
}

// The preview of an arrow or box while it is dragged; a pen's live path is its ink.
const draft = computed(() => {
  const current = drawing.value;
  if (!current) return null;
  if (current.type === 'pen') return { type: 'pen' as const, d: penPath(current.points) };
  const [start, end] = current.points as [MarkupPoint, MarkupPoint];
  if (current.type === 'arrow') return { type: 'arrow' as const, d: arrowPath(start, end, WING_PX / scale.value) };
  const [x, y, width, height] = shapeBox([start, end]);
  return { type: 'box' as const, x, y, width, height };
});

// Pins
const openPin = ref<number | null>(null);
const pinButtons = new Map<number, HTMLElement>();
const textareas = new Map<number, HTMLElement>();
const focusedPin = ref<number | null>(null);
const draggingPin = ref<number | null>(null);
const dragAt = ref<MarkupPoint | null>(null);
let pinDrag: { pointerId: number; id: number; x: number; y: number; moved: boolean } | null = null;
let suppressToggle: number | null = null;

const pinAt = (pin: PinDraft): MarkupPoint => (draggingPin.value === pin.id && dragAt.value ? dragAt.value : pin.at);
const anchorName = (pin: PinDraft): string => pin.anchor?.element ?? t('editor.designPreview.markup.noElement');
const kindName = (kind: PinKind): string => t(`editor.designPreview.markup.${kind}`);
function pinLabel(pin: PinDraft): string {
  const n = numbers.value.get(pin.id);
  return pin.anchor
    ? t('editor.designPreview.markup.pinLabel', { n, kind: kindName(pin.kind), element: pin.anchor.element })
    : t('editor.designPreview.markup.pinLabelNone', { n, kind: kindName(pin.kind) });
}

function bindPin(id: number, element: unknown): void {
  const node = (element as { $el?: HTMLElement } | null)?.$el ?? (element as HTMLElement | null);
  if (node instanceof HTMLElement) pinButtons.set(id, node);
  else {
    pinButtons.delete(id);
    pinReferences.delete(id);
  }
}

// A pin's popover anchors to the pin spot's layout box, which d-badge-pop's scale leaves alone, so the popover never chases
// the transform. contextElement lets floating-ui follow the spot's moves (a drag) and its ancestors' scrolls.
const pinReferences = new Map<number, ReferenceElement>();
function pinReference(id: number): ReferenceElement {
  const spot = (): HTMLElement | undefined => pinButtons.get(id)?.closest<HTMLElement>('[data-markup-pin]') ?? undefined;
  const reference: ReferenceElement = pinReferences.get(id) ?? {
    // read only while the popover is open, when its pin is mounted
    get contextElement(): Element {
      return spot() as Element;
    },
    getBoundingClientRect() {
      const node = spot();
      const parent = node?.offsetParent;
      if (!node || !(parent instanceof HTMLElement)) return new DOMRect();
      const origin = parent.getBoundingClientRect();
      return new DOMRect(origin.left + parent.clientLeft + node.offsetLeft, origin.top + parent.clientTop + node.offsetTop, node.offsetWidth, node.offsetHeight);
    },
  };
  pinReferences.set(id, reference);
  return reference;
}
// reka's flip tries only the opposite side and its shift never moves along the side's axis, so the side comes from the room
// beside the pin; below it, reka's flip takes the popover above when below lacks the room.
function popoverSide(pin: PinDraft): 'right' | 'left' | 'bottom' {
  const width = displayedWidth.value;
  const inset = pinInsetPx();
  const center = Math.max(inset, Math.min((pinAt(pin)[0] / freeze.value.width) * width, width - inset));
  const gap = remPx(PIN_POPOVER_GAP_REM);
  return pinPopoverSide(width, center, { pin: pinPx(), popover: remPx(PIN_POPOVER_REM), gap, padding: gap });
}
function bindTextarea(id: number, element: unknown): void {
  const node = (element as { $el?: HTMLElement } | null)?.$el;
  if (node instanceof HTMLElement) textareas.set(id, node);
  else textareas.delete(id);
}

function placePin(point: MarkupPoint): void {
  const anchor = resolveAnchor(point, freeze.value.elements);
  const pin: PinDraft = { id: newMarkId(), type: 'pin', kind: 'change', text: '', at: point, anchor };
  if (!addMark(props.session, pin)) {
    emit('limit');
    return;
  }
  snap.value = anchor;
  halo.value += 1;
  const n = numbers.value.get(pin.id);
  emit('announce', anchor ? t('editor.designPreview.markup.added.pin', { n, element: anchor.element }) : t('editor.designPreview.markup.added.pinNone', { n }));
  openPin.value = pin.id;
}

function onCanvasKeydown(event: KeyboardEvent): void {
  if (event.target !== canvas.value) return;
  if (event.key === 'Escape' && drawing.value) {
    event.stopPropagation();
    drawing.value = null;
    return;
  }
  if (event.key !== 'Enter' || tool.value !== 'pin' || props.sending) return;
  event.preventDefault();
  placePin(visibleCenter());
}

// The middle of the part of the image the scroller shows.
function visibleCenter(): MarkupPoint {
  const box = canvas.value!.getBoundingClientRect();
  const scroller = canvas.value!.parentElement!.getBoundingClientRect();
  const top = Math.max(box.top, scroller.top);
  const bottom = Math.min(box.bottom, scroller.bottom);
  return displayedToCss([box.width / 2, (top + bottom) / 2 - box.top], box.width, freeze.value);
}

// The click that ends a pin drag toggles nothing, whether its popover is open or closed.
function setOpen(id: number, open: boolean): void {
  const dragged = suppressToggle === id;
  suppressToggle = null;
  if (dragged) return;
  openPin.value = open ? id : openPin.value === id ? null : openPin.value;
}

function focusTextarea(id: number): void {
  void nextTick(() => {
    const textarea = textareas.get(id)?.matches('textarea') ? textareas.get(id) : textareas.get(id)?.querySelector('textarea');
    textarea?.focus();
  });
}

function setText(pin: PinDraft, text: string | number): void {
  replaceMark(props.session, { ...pin, text: String(text).slice(0, MAX_MARKUP_PIN_TEXT) }, false);
}
function setKind(pin: PinDraft, kind: PinKind): void {
  if (kind !== pin.kind) replaceMark(props.session, { ...pin, kind }, true);
}

function deletePin(pin: PinDraft): void {
  const index = pins.value.findIndex((candidate) => candidate.id === pin.id);
  const neighbour = pins.value[index - 1] ?? pins.value[index + 1];
  const n = numbers.value.get(pin.id);
  openPin.value = null;
  removeMark(props.session, pin.id);
  emit('announce', t('editor.designPreview.markup.deleted', { n }));
  void nextTick(() => (neighbour ? pinButtons.get(neighbour.id) : canvas.value)?.focus());
}

function onPinPointerDown(event: PointerEvent, pin: PinDraft): void {
  if (event.button !== 0 || props.sending) return;
  event.stopPropagation();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  pinDrag = { pointerId: event.pointerId, id: pin.id, x: event.clientX, y: event.clientY, moved: false };
}
function onPinPointerMove(event: PointerEvent, pin: PinDraft): void {
  if (pinDrag?.pointerId !== event.pointerId) return;
  if (!pinDrag.moved && Math.hypot(event.clientX - pinDrag.x, event.clientY - pinDrag.y) <= TAP_PX) return;
  pinDrag.moved = true;
  draggingPin.value = pin.id;
  dragAt.value = pointOf(event);
  snap.value = resolveAnchor(dragAt.value, freeze.value.elements);
}
function onPinPointerUp(event: PointerEvent, pin: PinDraft): void {
  if (pinDrag?.pointerId !== event.pointerId) return;
  const { moved } = pinDrag;
  const at = dragAt.value ?? pin.at;
  endPinDrag();
  if (!moved) return;
  suppressToggle = pin.id;
  replaceMark(props.session, { ...pin, at, anchor: resolveAnchor(at, freeze.value.elements) }, true);
}
// A cancelled or lost drag, or marks that change under it (an undo), leave the pin where its mark is.
function endPinDrag(): void {
  pinDrag = null;
  draggingPin.value = null;
  dragAt.value = null;
  if (tool.value !== 'pin' && focusedPin.value === null) snap.value = null;
}
watch(marks, () => {
  if (pinDrag) endPinDrag();
});

// A run of arrow-key moves is one undo step: it ends when the pin blurs or after a pause.
let moveRun: { id: number; timer: ReturnType<typeof setTimeout> } | null = null;
function endMoveRun(): void {
  if (!moveRun) return;
  clearTimeout(moveRun.timer);
  const pin = pins.value.find((candidate) => candidate.id === moveRun?.id);
  moveRun = null;
  if (pin) emit('announce', t('editor.designPreview.markup.moved', { n: numbers.value.get(pin.id), element: anchorName(pin) }));
}

const MOVES: Record<string, MarkupPoint> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
function onPinKeydown(event: KeyboardEvent, pin: PinDraft): void {
  if (props.sending) return;
  const move = MOVES[event.key];
  if (move) {
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? MOVE_STEP_SHIFT : MOVE_STEP;
    const at = clampPoint([pin.at[0] + move[0] * step, pin.at[1] + move[1] * step], freeze.value);
    const next: PinDraft = { ...pin, at, anchor: resolveAnchor(at, freeze.value.elements) };
    if (moveRun?.id !== pin.id) {
      endMoveRun();
      commitMarks(props.session, props.session.marks.map((mark) => (mark.id === pin.id ? next : mark)));
    } else {
      clearTimeout(moveRun.timer);
      replaceMark(props.session, next, false);
    }
    moveRun = { id: pin.id, timer: setTimeout(endMoveRun, MOVE_SETTLE_MS) };
    snap.value = next.anchor;
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    event.stopPropagation();
    deletePin(pin);
  }
}
function onPinFocus(pin: PinDraft): void {
  focusedPin.value = pin.id;
  snap.value = pin.anchor;
}
function onPinBlur(): void {
  endMoveRun();
  focusedPin.value = null;
  if (tool.value !== 'pin') snap.value = null;
}

watch(tool, (next) => {
  if (next !== 'pin') snap.value = null;
});

let resize: ResizeObserver | undefined;
onMounted(() => {
  resize = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box) displayedWidth.value = box.width;
  });
  if (canvas.value) {
    resize.observe(canvas.value);
    displayedWidth.value = canvas.value.getBoundingClientRect().width;
  }
});
onBeforeUnmount(() => {
  resize?.disconnect();
  cancelAnimationFrame(frame);
  if (moveRun) clearTimeout(moveRun.timer);
});

defineExpose({
  /** Shell px the image shows at now, which the flattened PNG's mark sizes follow. */
  displayedWidth: (): number => canvas.value?.getBoundingClientRect().width ?? displayedWidth.value,
  focusCanvas: (): void => canvas.value?.focus(),
});

const TEXT_COUNT_FROM = Math.floor(MAX_MARKUP_PIN_TEXT * 0.9);

const CURSOR: Record<MarkupSession['tool'], string> = { pen: 'cursor-crosshair', arrow: 'cursor-crosshair', box: 'cursor-crosshair', pin: 'cursor-copy' };
</script>

<template>
  <div
    ref="layer"
    data-testid="design-markup-layer"
    class="absolute inset-0 overflow-x-hidden overflow-y-auto"
  >
    <div
      ref="canvas"
      tabindex="0"
      role="group"
      :aria-label="t('editor.designPreview.markup.canvas')"
      :aria-describedby="helpId"
      data-testid="design-markup-canvas"
      :data-tool="tool"
      class="relative touch-none outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--d-accent)"
      :class="sending ? 'pointer-events-none cursor-progress' : draggingPin !== null ? 'cursor-grabbing' : CURSOR[tool]"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @pointerleave="onPointerLeave"
      @keydown="onCanvasKeydown"
    >
      <img
        :src="freeze.png"
        :alt="t('editor.designPreview.markup.image', { screen: freeze.screen ?? freeze.file, width: freeze.width })"
        draggable="false"
        data-testid="design-markup-image"
        class="block h-auto w-full select-none"
      >
      <svg
        aria-hidden="true"
        :viewBox="`0 0 ${freeze.width} ${height}`"
        preserveAspectRatio="none"
        class="pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        <TransitionGroup
          tag="g"
          enter-active-class=""
          leave-active-class="t-fade-leave-active"
        >
          <MarkupStroke
            v-for="mark in strokes"
            :key="mark.id"
            :mark="mark"
            :scale="scale"
            :draw-in="drawn.get(mark.id)"
          />
        </TransitionGroup>
        <template v-if="draft">
          <path
            v-if="draft.type === 'pen'"
            :d="draft.d"
            data-testid="design-markup-draft"
            :class="STROKE_CLASS"
            :stroke-width="STROKE_PX / scale"
          />
          <path
            v-else-if="draft.type === 'arrow'"
            :d="draft.d"
            data-testid="design-markup-draft"
            :class="[STROKE_CLASS, 'opacity-60']"
            :stroke-width="1.5 / scale"
            :stroke-dasharray="`${4 / scale} ${3 / scale}`"
          />
          <rect
            v-else
            :x="draft.x"
            :y="draft.y"
            :width="draft.width"
            :height="draft.height"
            :rx="BOX_RADIUS_PX / scale"
            data-testid="design-markup-draft"
            :class="[STROKE_CLASS, 'opacity-60']"
            :stroke-width="1.5 / scale"
            :stroke-dasharray="`${4 / scale} ${3 / scale}`"
          />
        </template>
      </svg>
      <div
        v-if="snap"
        data-testid="design-markup-snap"
        :data-element="snap.element"
        class="pointer-events-none absolute rounded-[0.125rem] bg-[color-mix(in_srgb,var(--d-design)_7%,transparent)] outline-[1.5px] outline-(--d-design)"
        :style="rectStyle(snap)"
      >
        <span
          v-if="halo > 0"
          :key="halo"
          aria-hidden="true"
          class="absolute inset-0 animate-[d-flash_.6s_var(--ease-out)_both] rounded-[0.125rem] shadow-[0_0_0_3px_color-mix(in_srgb,var(--d-design)_35%,transparent)]"
        />
        <span
          dir="ltr"
          class="absolute left-0 h-4.5 max-w-full truncate bg-(--d-design) px-1.5 font-mono text-10.5/4.5 text-(--d-on-design)"
          :class="snapTagInside ? 'top-0 rounded-br-[0.25rem]' : '-top-4.5 rounded-t-[0.25rem]'"
        >{{ snap.element }}</span>
      </div>
      <TransitionGroup
        name="t-badge"
        appear
      >
        <span
          v-for="pin in pins"
          :key="pin.id"
          data-markup-pin
          class="absolute -m-3 size-6"
          :style="{ ...pinStyle(pinAt(pin)), animationDelay: pinDelay.get(pin.id) }"
          @animationend="pinDelay.delete(pin.id)"
        >
          <Popover
            :open="openPin === pin.id"
            @update:open="(open: boolean) => setOpen(pin.id, open)"
          >
            <PopoverTrigger as-child>
              <button
                :ref="(element) => bindPin(pin.id, element)"
                type="button"
                aria-haspopup="dialog"
                :aria-label="pinLabel(pin)"
                data-testid="design-markup-pin"
                :data-n="numbers.get(pin.id)"
                :data-kind="pin.kind"
                :data-element="pin.anchor?.element"
                :class="cn(
                  'flex size-full items-center justify-center rounded-full text-11 leading-none font-semibold tabular-nums ring-2 ring-(--d-bg) transition-[box-shadow,background-color,color] duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)',
                  draggingPin === pin.id ? 'cursor-grabbing' : 'cursor-pointer',
                  pin.kind === 'change'
                    ? 'bg-(--d-design) text-(--d-on-design) shadow-[0_0.125rem_0.5rem_-0.125rem_var(--d-scrim)] hover:shadow-[0_0_0_4px_color-mix(in_srgb,var(--d-design)_30%,transparent),0_0.125rem_0.5rem_-0.125rem_var(--d-scrim)]'
                    : 'bg-(--d-bg) text-(--d-design-text) shadow-[inset_0_0_0_2px_var(--d-design),0_0.125rem_0.5rem_-0.125rem_var(--d-scrim)] hover:shadow-[inset_0_0_0_2px_var(--d-design),0_0_0_4px_color-mix(in_srgb,var(--d-design)_30%,transparent),0_0.125rem_0.5rem_-0.125rem_var(--d-scrim)]',
                  openPin === pin.id && (pin.kind === 'change'
                    ? 'shadow-[0_0_0_4px_color-mix(in_srgb,var(--d-design)_45%,transparent),0_0.125rem_0.5rem_-0.125rem_var(--d-scrim)]'
                    : 'shadow-[inset_0_0_0_2px_var(--d-design),0_0_0_4px_color-mix(in_srgb,var(--d-design)_45%,transparent),0_0.125rem_0.5rem_-0.125rem_var(--d-scrim)]'),
                )"
                @pointerdown="onPinPointerDown($event, pin)"
                @pointermove="onPinPointerMove($event, pin)"
                @pointerup="onPinPointerUp($event, pin)"
                @pointercancel="endPinDrag"
                @lostpointercapture="endPinDrag"
                @keydown="onPinKeydown($event, pin)"
                @focus="onPinFocus(pin)"
                @blur="onPinBlur"
              >
                {{ numbers.get(pin.id) }}
              </button>
            </PopoverTrigger>
            <PopoverAnchor
              as-child
              :reference="pinReference(pin.id)"
            />
            <PopoverContent
              :side="popoverSide(pin)"
              align="start"
              :side-offset="remPx(PIN_POPOVER_GAP_REM)"
              :collision-padding="remPx(PIN_POPOVER_GAP_REM)"
              :collision-boundary="layer"
              role="dialog"
              :aria-label="t('editor.designPreview.markup.popover', { n: numbers.get(pin.id) })"
              data-testid="design-markup-popover"
              class="flex w-72 max-w-(--reka-popover-content-available-width) flex-col gap-2 rounded-lg border-(--d-border) bg-(--d-card) p-2.5 text-(--d-text) shadow-(--d-shadow)"
              @open-auto-focus.prevent="focusTextarea(pin.id)"
            >
              <div class="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  class="flex size-4 flex-none items-center justify-center rounded-full text-10 font-semibold tabular-nums"
                  :class="pin.kind === 'change' ? 'bg-(--d-design) text-(--d-on-design)' : 'bg-(--d-bg) text-(--d-design-text) shadow-[inset_0_0_0_1.5px_var(--d-design)]'"
                >{{ numbers.get(pin.id) }}</span>
                <span
                  dir="ltr"
                  data-testid="design-markup-anchor"
                  class="min-w-0 truncate font-mono text-11"
                  :class="pin.anchor ? 'text-(--d-muted)' : 'text-(--d-faint-text)'"
                >{{ anchorName(pin) }}</span>
              </div>
              <Textarea
                :ref="(element) => bindTextarea(pin.id, element)"
                :model-value="pin.text"
                :aria-label="t('editor.designPreview.markup.text', { n: numbers.get(pin.id) })"
                :placeholder="t(pin.kind === 'change' ? 'editor.designPreview.markup.placeholderChange' : 'editor.designPreview.markup.placeholderNote')"
                :maxlength="MAX_MARKUP_PIN_TEXT"
                rows="3"
                data-testid="design-markup-text"
                class="max-h-40 min-h-18 resize-none border-(--d-border) bg-(--d-input) text-12.5 field-sizing-content focus-visible:border-(--d-accent) focus-visible:ring-3 focus-visible:ring-(--d-accent-soft) focus-visible:ring-offset-0"
                @update:model-value="(text: string | number) => setText(pin, text)"
              />
              <span
                v-if="pin.text.length > TEXT_COUNT_FROM"
                data-testid="design-markup-text-count"
                class="self-end text-10.5 tabular-nums"
                :class="pin.text.length >= MAX_MARKUP_PIN_TEXT ? 'text-(--d-danger-text)' : 'text-(--d-faint-text)'"
              >{{ formatNumber(pin.text.length) }} / {{ formatNumber(MAX_MARKUP_PIN_TEXT) }}</span>
              <div class="flex flex-wrap items-center gap-2">
                <SegmentedToggle
                  :model-value="pin.kind"
                  :options="[
                    { value: 'change', label: kindName('change'), attrs: { 'data-testid': 'design-markup-kind-option', 'data-kind': 'change' } },
                    { value: 'note', label: kindName('note'), attrs: { 'data-testid': 'design-markup-kind-option', 'data-kind': 'note' } },
                  ]"
                  indicator-class="text-(--d-design)"
                  selected-class="text-(--d-on-design)"
                  :aria-label="t('editor.designPreview.markup.kind')"
                  data-testid="design-markup-kind"
                  class="border border-(--d-border) bg-(--d-bg)"
                  @update:model-value="(kind: PinKind) => setKind(pin, kind)"
                />
                <Button
                  variant="ghost"
                  data-testid="design-markup-delete"
                  class="ms-auto h-6 gap-1 px-2 text-12 text-(--d-danger-text) hover:bg-[color-mix(in_srgb,var(--d-danger)_12%,transparent)] hover:text-(--d-danger-text) [&_svg]:size-3.5"
                  @click="deletePin(pin)"
                >
                  <Trash2 aria-hidden="true" />{{ t('editor.designPreview.markup.delete') }}
                </Button>
                <Button
                  variant="ghost"
                  data-testid="design-markup-done"
                  class="h-6 gap-1 px-2 text-12 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
                  @click="openPin = null"
                >
                  <Check aria-hidden="true" />{{ t('editor.designPreview.markup.done') }}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </span>
      </TransitionGroup>
    </div>
    <p
      :id="helpId"
      class="sr-only"
    >
      {{ t('editor.designPreview.markup.canvasHelp') }}
    </p>
  </div>
</template>
