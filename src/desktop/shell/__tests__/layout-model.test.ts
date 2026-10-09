import { describe, expect, it } from 'vitest';
import type { ShellGridLayout } from '../../preload/shell-channels';
import {
  clampSlotSize,
  gridMinWidth,
  slotMax,
  gridAreas,
  moveGridPane,
  slotOf,
  toggleGridMaximize,
  toggleGridPane,
} from '../layout/layout-model';

const DEFAULT: ShellGridLayout = {
  slots: { main: 'chat', side: 'editor', bottom: 'terminal' },
  visible: { editor: true, terminal: false },
  sideWidth: 520,
  bottomHeight: 230,
  maximized: null,
};

describe('moveGridPane', () => {
  it('swaps the dropped pane with the one in the target slot and opens it', () => {
    const next = moveGridPane(DEFAULT, 'terminal', 'side');
    expect(next.slots).toEqual({ main: 'chat', side: 'terminal', bottom: 'editor' });
    expect(next.visible).toEqual({ editor: true, terminal: true });
    expect(next.sideWidth).toBe(520);
  });

  it('moves the chat between slots without touching visibility', () => {
    const next = moveGridPane(DEFAULT, 'chat', 'side');
    expect(next.slots).toEqual({ main: 'editor', side: 'chat', bottom: 'terminal' });
    expect(next.visible).toEqual(DEFAULT.visible);
  });

  it('keeps the slots a permutation for every move', () => {
    for (const pane of ['chat', 'editor', 'terminal'] as const) {
      for (const slot of ['main', 'side', 'bottom'] as const) {
        const next = moveGridPane(DEFAULT, pane, slot);
        expect(Object.values(next.slots).sort()).toEqual(['chat', 'editor', 'terminal']);
        expect(slotOf(next, pane)).toBe(slot);
      }
    }
  });

  it('dropping a pane on its own slot changes nothing but its visibility', () => {
    const next = moveGridPane(DEFAULT, 'terminal', 'bottom');
    expect(next.slots).toEqual(DEFAULT.slots);
    expect(next.visible.terminal).toBe(true);
  });

  it('keeps a maximize only while the maximized pane keeps its slot', () => {
    const maximized = { ...DEFAULT, visible: { editor: true, terminal: true }, maximized: 'terminal' as const };
    expect(moveGridPane(maximized, 'terminal', 'side').maximized).toBeNull();
    expect(moveGridPane(maximized, 'editor', 'bottom').maximized).toBeNull();
    expect(moveGridPane(maximized, 'editor', 'main').maximized).toBe('terminal');
  });
});

describe('toggles', () => {
  it('shows and hides the editor and the terminal', () => {
    expect(toggleGridPane(DEFAULT, 'editor').visible.editor).toBe(false);
    expect(toggleGridPane(DEFAULT, 'terminal').visible.terminal).toBe(true);
    expect(toggleGridPane(toggleGridPane(DEFAULT, 'terminal'), 'terminal')).toEqual(DEFAULT);
  });

  it('hiding the maximized pane ends the maximize, hiding another keeps it', () => {
    const maximized = toggleGridMaximize(DEFAULT, 'terminal');
    expect(maximized).toMatchObject({ maximized: 'terminal', visible: { terminal: true } });
    expect(toggleGridPane(maximized, 'terminal').maximized).toBeNull();
    expect(toggleGridPane(maximized, 'editor').maximized).toBe('terminal');
    expect(toggleGridMaximize(maximized, 'terminal').maximized).toBeNull();
  });
});

describe('gridAreas', () => {
  it('shows the slots of shown panes and a sash only between two shown slots', () => {
    expect(gridAreas(DEFAULT)).toEqual({ main: true, side: true, bottom: false, sideSash: true, bottomSash: false });
    const editorHidden = toggleGridPane(toggleGridPane(DEFAULT, 'terminal'), 'editor');
    expect(gridAreas(editorHidden)).toEqual({ main: true, side: false, bottom: true, sideSash: false, bottomSash: true });
  });

  it('a maximized pane fills the grid alone, wherever its slot is', () => {
    expect(gridAreas(toggleGridMaximize(DEFAULT, 'terminal'))).toEqual({ main: false, side: false, bottom: true, sideSash: false, bottomSash: false });
    const terminalSide = toggleGridMaximize(moveGridPane(DEFAULT, 'terminal', 'side'), 'terminal');
    expect(gridAreas(terminalSide)).toEqual({ main: false, side: true, bottom: false, sideSash: false, bottomSash: false });
  });
});

describe('clamps', () => {
  // The same rule for every slot: a sash stops where the slot on either side reaches its minimum.
  it('holds a slot between its minimum and what leaves the slot across the sash its minimum', () => {
    expect(clampSlotSize(100, 2000, 300)).toBe(300);
    expect(clampSlotSize(500, 2000, 300)).toBe(500);
    expect(clampSlotSize(1900, 2000, 300)).toBe(1700);
    expect(slotMax(2000, 300, 500)).toBe(1700);
    expect(clampSlotSize(800, 900, 120)).toBe(780);
    // A narrow grid never pushes the maximum below the minimum.
    expect(clampSlotSize(400, 500, 300)).toBe(300);
  });

  it('keeps the size in an unmeasured grid', () => {
    expect(clampSlotSize(900, -5, 300)).toBe(900);
    expect(slotMax(0, 300, 900)).toBe(900);
    expect(clampSlotSize(100, 0, 300)).toBe(300);
  });

  it('scales with the minimums the caller passes at the root font', () => {
    expect(clampSlotSize(100, 2000, 375)).toBe(375);
    expect(clampSlotSize(1900, 2000, 375)).toBe(1625);
  });

  it('needs room for both columns and the sash only while both show', () => {
    const both = { main: true, side: true, bottom: false, sideSash: true, bottomSash: false };
    expect(gridMinWidth(both, 300, 5)).toBe(605);
    expect(gridMinWidth({ ...both, side: false, sideSash: false }, 300, 5)).toBe(300);
  });
});
