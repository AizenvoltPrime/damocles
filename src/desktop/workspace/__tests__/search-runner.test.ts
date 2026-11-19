import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { processLauncher } from '../../../core/process-launcher';
import { ALL_IGNORE_FILES, walkedRgRuns, walkHost } from '../../../core/search-walk';
import { createSearchRunner, type RgEvent, type SearchRequest, type SearchRunEnd, type SearchRunnerDeps } from '../search/search-runner';

// Every file the engine opens itself, which it does only to release a file's held events.
const opened = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: ((file: string, ...rest: never[]) => {
      opened.push(path.basename(String(file)));
      return (actual.open as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof actual.open,
  };
});
// 8 logical CPUs, so the engine keeps 4 ripgrep runs live on any machine.
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), availableParallelism: () => 8 }));

let root: string;
// files of about 100-character names, more than one ripgrep command line holds
let wide: string;
const WIDE_FILES = 1_000;

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-search-runner-')));
  fs.writeFileSync(path.join(root, 'long.txt'), `needle ${'x'.repeat(4096)}\n`);
  fs.writeFileSync(path.join(root, 'held.txt'), Array.from({ length: 20 }, (_, index) => `needle ${index}\n`).join(''));
  wide = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-search-runner-wide-')));
  for (let index = 0; index < WIDE_FILES; index++) fs.writeFileSync(path.join(wide, `${String(index).padStart(4, '0')}-${'n'.repeat(90)}.txt`), 'needle 1\nplain\nneedle 2\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(wide, { recursive: true, force: true });
});

const NEEDLE: SearchRequest = { match: ['--fixed-strings'], pattern: 'needle', walk: { ignore: ALL_IGNORE_FILES, overrides: [] } };

function search(deps: Partial<SearchRunnerDeps>, cwd = root): Promise<{ events: RgEvent[]; dropped: number; end: SearchRunEnd }> {
  const runner = createSearchRunner({ rgPath: async () => rgPath, walks: walkHost(), log: () => undefined, ...deps });
  return new Promise((resolve) => {
    const events: RgEvent[] = [];
    let dropped = 0;
    runner.run(cwd, NEEDLE, { event: (event) => events.push(event), dropped: () => dropped++, end: (end) => resolve({ events, dropped, end }) });
  });
}

const pathOf = (event: RgEvent): string => (event.data['path'] as { text: string }).text;
const matchedFiles = (events: readonly RgEvent[]): string[] => [...new Set(events.filter((event) => event.type === 'match').map(pathOf))].sort();

describe('the search runner', () => {
  it('drops an event past its event bound unread and tells the sink, and searches on', async () => {
    const { events, dropped, end } = await search({ maxEventBytes: 1024 });
    expect(dropped).toBe(1);
    expect(matchedFiles(events)).toEqual(['held.txt']);
    expect(end).toEqual({ code: 0, stderr: '' });
  });

  it('reads a file whose held events pass its hold bound, to release them, and holds a file under it to its end', async () => {
    opened.length = 0;
    const released = await search({ holdBytes: 64 });
    expect(opened).toContain('held.txt');
    expect(released.events.filter((event) => event.type === 'match')).toHaveLength(21);
    opened.length = 0;
    const held = await search({});
    expect(opened).toEqual([]);
    // rg searches a batch's files in parallel, so only each file's own events keep their order
    const byFile = (events: readonly RgEvent[]): string[] => events.map(({ type, data }) => `${(data['path'] as { text: string }).text} ${type} ${String(data['line_number'])}`).sort();
    expect(byFile(held.events)).toEqual(byFile(released.events));
  });

  it('runs up to walkedRgRuns() ripgreps at once and sends each file whole, its begin first and its end last', async () => {
    const launcher = processLauncher();
    const original = launcher.launch.bind(launcher);
    let running = 0;
    let most = 0;
    const launch = vi.spyOn(launcher, 'launch').mockImplementation((spec, options) => {
      const child = original(spec, options);
      most = Math.max(most, ++running);
      // each run stays live a while past its exit, so the runs overlap
      const exited = child.exited.then(async (exit) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        running--;
        return exit;
      });
      return { ...child, exited };
    });
    try {
      // every file's events released at its first, so they stream from several runs at once
      const { events, end } = await search({ holdBytes: 0 }, wide);
      expect(most).toBeGreaterThan(1);
      expect(most).toBeLessThanOrEqual(walkedRgRuns());
      expect(end).toEqual({ code: 0, stderr: '' });
      const begun = new Set<string>();
      let open: string | undefined;
      for (const event of events) {
        if (event.type === 'begin') {
          expect(open).toBeUndefined();
          expect(begun.has(pathOf(event))).toBe(false);
          open = pathOf(event);
          begun.add(open);
          continue;
        }
        expect(pathOf(event)).toBe(open);
        if (event.type === 'end') open = undefined;
      }
      expect(begun.size).toBe(WIDE_FILES);
      expect(events.filter((event) => event.type === 'match')).toHaveLength(2 * WIDE_FILES);
    } finally {
      launch.mockRestore();
    }
  });
});
