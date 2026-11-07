import { describe, expect, it } from 'vitest';
import { MAX_DESIGN_WIDTH, MIN_DESIGN_WIDTH } from '../../preload/shell-channels';
import { bandOf, clampWidth, dragDelta, fitWidth, keyWidth, presetsOf, readout, zoomFor } from '../editor/design-width';

// Tailwind 4's defaults, which the fixture design-app keeps.
const TAILWIND = [{ name: 'sm', width: 640 }, { name: 'md', width: 768 }, { name: 'lg', width: 1024 }, { name: 'xl', width: 1280 }, { name: '2xl', width: 1536 }];

describe('design preview widths', () => {
  it('offers the app breakpoints ascending with base 390 below the smallest, and no device presets', () => {
    expect(presetsOf([...TAILWIND].reverse())).toEqual([{ name: 'base', width: 390 }, ...TAILWIND]);
  });

  it('puts base inside the band below a smallest breakpoint narrower than 390, and drops it when no band is left', () => {
    expect(presetsOf([{ name: 'sm', width: 360 }, { name: 'md', width: 900 }])[0]).toEqual({ name: 'base', width: 359 });
    expect(presetsOf([{ name: 'sm', width: 320 }]).map((preset) => preset.name)).toEqual(['sm']);
  });

  it('leaves out a breakpoint the preview cannot show', () => {
    expect(presetsOf([{ name: 'xl', width: 1280 }, { name: '4k', width: 3840 }]).map((preset) => preset.name)).toEqual(['base', 'xl']);
  });

  it('places a width in the widest band at or below it', () => {
    expect(bandOf(320, TAILWIND)).toBe('base');
    expect(bandOf(639, TAILWIND)).toBe('base');
    expect(bandOf(640, TAILWIND)).toBe('sm');
    expect(bandOf(767, TAILWIND)).toBe('sm');
    expect(bandOf(768, TAILWIND)).toBe('md');
    expect(bandOf(900, TAILWIND)).toBe('md');
    expect(bandOf(1279, TAILWIND)).toBe('lg');
    expect(bandOf(1280, TAILWIND)).toBe('xl');
    expect(bandOf(2560, TAILWIND)).toBe('2xl');
    expect(bandOf(900, [])).toBe('base');
  });

  it('clamps a free width to 320..2560 whole px', () => {
    expect(clampWidth(100)).toBe(MIN_DESIGN_WIDTH);
    expect(clampWidth(9000)).toBe(MAX_DESIGN_WIDTH);
    expect(clampWidth(900.4)).toBe(900);
  });

  it('zooms a frame wider than the pane to fit, and never past 100%', () => {
    expect(zoomFor(1280, 640)).toBe(0.5);
    expect(zoomFor(390, 900)).toBe(1);
    expect(zoomFor(1280, 0)).toBe(1);
  });

  it('fits the width to the room the pane has at 100%', () => {
    expect(fitWidth(781.7)).toBe(781);
    expect(fitWidth(200)).toBe(MIN_DESIGN_WIDTH);
    expect(fitWidth(4000)).toBe(MAX_DESIGN_WIDTH);
    expect(zoomFor(fitWidth(781.7), 781.7)).toBe(1);
  });

  it('turns an edge drag into twice the move in design px: 10 at 50% is 40', () => {
    expect(dragDelta(10, 0.5)).toBe(40);
    expect(dragDelta(-10, 1)).toBe(-20);
  });

  it('steps 1 px with an arrow key, 10 with Shift, and jumps to the ends with Home and End', () => {
    expect(keyWidth(900, 'ArrowRight', false)).toBe(901);
    expect(keyWidth(900, 'ArrowLeft', false)).toBe(899);
    expect(keyWidth(900, 'ArrowRight', true)).toBe(910);
    expect(keyWidth(900, 'ArrowLeft', true)).toBe(890);
    expect(keyWidth(325, 'ArrowLeft', true)).toBe(MIN_DESIGN_WIDTH);
    expect(keyWidth(900, 'Home', false)).toBe(MIN_DESIGN_WIDTH);
    expect(keyWidth(900, 'End', false)).toBe(MAX_DESIGN_WIDTH);
    expect(keyWidth(900, 'ArrowUp', false)).toBeUndefined();
  });

  it('reads band · width px · zoom%', () => {
    expect(readout(1280, 0.6094, TAILWIND)).toBe('xl · 1280 px · 61%');
    expect(readout(900, 1, TAILWIND)).toBe('md · 900 px · 100%');
  });
});
