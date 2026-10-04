import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clampToWorkAreas,
  DEFAULT_SHELL_LAYOUT,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  parseShellLayout,
  WINDOW_LAYOUT_FILE,
  WindowLayoutStore,
} from '../window-layout-store';

let dir: string;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-layout-'));
  lines = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = (line: string): void => {
  lines.push(line);
};

function writeFile(content: unknown): void {
  fs.writeFileSync(path.join(dir, WINDOW_LAYOUT_FILE), JSON.stringify(content));
}

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };

describe('clampToWorkAreas', () => {
  it('keeps bounds that lie on a display', () => {
    expect(clampToWorkAreas({ x: 100, y: 50, width: 1200, height: 800 }, [PRIMARY, RIGHT])).toEqual({ x: 100, y: 50, width: 1200, height: 800 });
    expect(clampToWorkAreas({ x: 2000, y: 100, width: 1200, height: 800 }, [PRIMARY, RIGHT])).toEqual({ x: 2000, y: 100, width: 1200, height: 800 });
  });

  it('moves a window left on a disconnected display onto the nearest one', () => {
    expect(clampToWorkAreas({ x: 5000, y: 200, width: 1200, height: 800 }, [PRIMARY, RIGHT])).toEqual({ x: 1920 + 2560 - 1200, y: 200, width: 1200, height: 800 });
    expect(clampToWorkAreas({ x: -3000, y: -900, width: 1200, height: 800 }, [PRIMARY, RIGHT])).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('pulls a window hanging off an edge fully onto the display it overlaps most', () => {
    expect(clampToWorkAreas({ x: 1500, y: 900, width: 1200, height: 800 }, [PRIMARY])).toEqual({ x: 1920 - 1200, y: 1040 - 800, width: 1200, height: 800 });
  });

  it('shrinks a window larger than the display, never below the window minimum', () => {
    expect(clampToWorkAreas({ x: 0, y: 0, width: 4000, height: 3000 }, [PRIMARY])).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
    const small = { x: 0, y: 0, width: 800, height: 500 };
    expect(clampToWorkAreas({ x: 0, y: 0, width: 1200, height: 800 }, [small])).toEqual({ x: 0, y: 0, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
  });
});

describe('parseShellLayout', () => {
  it('accepts a complete layout within the minimums', () => {
    expect(parseShellLayout(DEFAULT_SHELL_LAYOUT)).toEqual(DEFAULT_SHELL_LAYOUT);
  });

  it('drops the Chats size an earlier version wrote', () => {
    const older = { ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, chats: { collapsed: true, size: 400 } } };
    expect(parseShellLayout(older)).toEqual({ ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, chats: { collapsed: true } } });
  });

  it.each([
    ['a narrow sidebar', { ...DEFAULT_SHELL_LAYOUT, sidebarWidth: 219 }],
    ['a small section', { ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, projects: { collapsed: false, size: 59 } } }],
    ['a Chats section without its flag', { ...DEFAULT_SHELL_LAYOUT, sections: { ...DEFAULT_SHELL_LAYOUT.sections, chats: {} } }],
    ['a missing section', { ...DEFAULT_SHELL_LAYOUT, sections: { projects: DEFAULT_SHELL_LAYOUT.sections.projects } }],
    ['a string flag', { ...DEFAULT_SHELL_LAYOUT, sidebarVisible: 'yes' }],
    ['an infinite width', { ...DEFAULT_SHELL_LAYOUT, sidebarWidth: Number.POSITIVE_INFINITY }],
    ['an array', []],
  ])('rejects %s', (_name, raw) => {
    expect(parseShellLayout(raw)).toBeUndefined();
  });
});

describe('WindowLayoutStore', () => {
  it('round-trips the window placement and the sidebar layout', async () => {
    const store = new WindowLayoutStore(dir, log);
    expect(store.window()).toBeUndefined();
    expect(store.sidebar()).toEqual(DEFAULT_SHELL_LAYOUT);
    store.setWindow({ bounds: { x: 10, y: 20, width: 1300, height: 900 }, maximized: true, fullScreen: false });
    const sidebar = { sidebarVisible: false, sidebarWidth: 300, sections: { projects: { collapsed: true, size: 120 }, chats: { collapsed: false } } };
    store.setSidebar(sidebar);
    await store.flush();

    expect(JSON.parse(fs.readFileSync(path.join(dir, WINDOW_LAYOUT_FILE), 'utf8'))).toEqual({
      version: 1,
      window: { x: 10, y: 20, width: 1300, height: 900, maximized: true, fullScreen: false },
      sidebar,
    });
    const next = new WindowLayoutStore(dir, log);
    expect(next.window()).toEqual({ bounds: { x: 10, y: 20, width: 1300, height: 900 }, maximized: true, fullScreen: false });
    expect(next.sidebar()).toEqual(sidebar);
  });

  it('drops malformed window bounds and a malformed sidebar with a log line, keeping the defaults', () => {
    writeFile({ version: 1, window: { x: 0, y: 0, width: 100, height: 900, maximized: false, fullScreen: false }, sidebar: { sidebarVisible: true } });
    const store = new WindowLayoutStore(dir, log);
    expect(store.window()).toBeUndefined();
    expect(store.sidebar()).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(lines).toEqual(['[layout] dropping malformed window bounds', '[layout] dropping a malformed sidebar layout']);
  });

  // Raw JSON text: JSON.stringify writes NaN and Infinity as null, and 1e999 parses to Infinity.
  it.each([
    '"x": null, "y": 0',
    '"x": 1e999, "y": 0',
    '"x": 1e9, "y": 0',
    '"x": 0, "y": "0"',
  ])('rejects a window position %s', (position) => {
    fs.writeFileSync(path.join(dir, WINDOW_LAYOUT_FILE), `{"version": 1, "window": {${position}, "width": 1200, "height": 800, "maximized": false, "fullScreen": false}}`);
    expect(new WindowLayoutStore(dir, log).window()).toBeUndefined();
    expect(lines).toEqual(['[layout] dropping malformed window bounds']);
  });

  it('ignores an unknown schema and unreadable JSON', () => {
    writeFile({ version: 2, window: {} });
    expect(new WindowLayoutStore(dir, log).window()).toBeUndefined();
    fs.writeFileSync(path.join(dir, WINDOW_LAYOUT_FILE), '{not json');
    expect(new WindowLayoutStore(dir, log).sidebar()).toEqual(DEFAULT_SHELL_LAYOUT);
    expect(lines[0]).toBe(`[layout] ignoring ${WINDOW_LAYOUT_FILE}: unknown schema`);
    expect(lines[1]).toMatch(/^\[layout\] ignoring unreadable /);
  });
});
