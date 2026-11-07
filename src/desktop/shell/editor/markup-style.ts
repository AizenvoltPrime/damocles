import { remPx } from '@/composables/useRemPx';

// The marks' look on screen, sizes in shell px: MarkupLayer draws them and markup-flatten scales them into the PNG, so both read them here.

export const STROKE_PX = 2.5;
export const WING_PX = 12;
export const BOX_RADIUS_PX = 3;
export const PIN_RING_PX = 2;

// PIN_REM is the pin's size-6 (and its -m-3 centring) in MarkupLayer.
const PIN_REM = 1.5;
// A pin's center stays this far inside the image, so an edge pin is not clipped.
export const PIN_INSET_REM = 0.75;

// PIN_POPOVER_REM is the pin popover's w-72 in MarkupLayer.
export const PIN_POPOVER_REM = 18;
// A pin popover's offset from its pin and its space from the layer's edges.
export const PIN_POPOVER_GAP_REM = 0.5;

export const pinPx = (): number => remPx(PIN_REM);
export const pinInsetPx = (): number => remPx(PIN_INSET_REM);

export const STROKE_CLASS = 'fill-none stroke-(--d-design) [stroke-linecap:round] [stroke-linejoin:round]';
