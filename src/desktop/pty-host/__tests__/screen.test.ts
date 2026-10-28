import { describe, expect, it, vi } from 'vitest';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';
import { MAX_TERMINAL_SCREEN_CHARS } from '../../preload/terminal-channels';
import type { HostMessage, HostRequest } from '../protocol';
import { createPtyScreen, type ScreenSnapshot } from '../screen';
import { createPtySessions, type Pty } from '../sessions';

const NONCE = '0123456789abcdef0123456789abcdef';
const osc = (body: string): string => `\x1b]633;${body}\x07`;

// The shell's side: a fresh xterm with the shell's unicode version takes the screen.
async function restore(screen: ScreenSnapshot, scrollback: number): Promise<Terminal> {
  const xterm = new Terminal({ cols: screen.cols, rows: screen.rows, scrollback, allowProposedApi: true });
  xterm.loadAddon(new Unicode11Addon());
  xterm.unicode.activeVersion = '11';
  await new Promise<void>((resolve) => xterm.write(screen.data, resolve));
  return xterm;
}

async function written(xterm: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => xterm.write(data, resolve));
}

function lines(xterm: Terminal, buffer: 'normal' | 'alternate' = 'normal'): string[] {
  const active = xterm.buffer[buffer];
  return Array.from({ length: active.length }, (_, y) => active.getLine(y)?.translateToString(true) ?? '');
}

// The same writes into a plain xterm, for what the screen should hold.
async function reference(data: string, cols: number, rows: number, scrollback: number): Promise<Terminal> {
  const xterm = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  xterm.loadAddon(new Unicode11Addon());
  xterm.unicode.activeVersion = '11';
  await written(xterm, data);
  return xterm;
}

async function roundTrip(data: string, cols = 40, rows = 6, scrollback = 100): Promise<{ restored: Terminal; expected: Terminal; screen: ScreenSnapshot }> {
  const screen = createPtyScreen({ cols, rows, scrollback });
  screen.write(data);
  const snapshot = await screen.serialize();
  screen.dispose();
  return { restored: await restore(snapshot, scrollback), expected: await reference(data, cols, rows, scrollback), screen: snapshot };
}

function expectSameBuffer(restored: Terminal, expected: Terminal): void {
  expect(lines(restored)).toEqual(lines(expected));
  expect(restored.buffer.normal.baseY).toBe(expected.buffer.normal.baseY);
  expect(restored.buffer.active.type).toBe(expected.buffer.active.type);
  expect([restored.buffer.active.cursorX, restored.buffer.active.cursorY]).toEqual([expected.buffer.active.cursorX, expected.buffer.active.cursorY]);
}

describe('the pty screen', () => {
  it('serializes a buffer with scrollback, colors and the cursor so a fresh xterm holds the same lines', async () => {
    const output = Array.from({ length: 20 }, (_, n) => `\x1b[3${n % 8}mline ${n}\x1b[0m`).join('\r\n') + '\r\n$ ec';
    const { restored, expected, screen } = await roundTrip(output);
    expectSameBuffer(restored, expected);
    expect(screen.data).toContain('\x1b[31m');
    const cell = restored.buffer.normal.getLine(1)!.getCell(0)!;
    expect(cell.getFgColor()).toBe(1);
  });

  it('keeps line numbers when a clear screen left the viewport blank under scrollback', async () => {
    const output = `${Array.from({ length: 12 }, (_, n) => `out ${n}`).join('\r\n')}\x1b[2J\x1b[H$ `;
    const { restored, expected } = await roundTrip(output);
    expectSameBuffer(restored, expected);
  });

  it('measures wide characters as the shell does', async () => {
    const { restored, expected } = await roundTrip('中文字符 and 🙂 wide\r\nnext');
    expectSameBuffer(restored, expected);
    expect(restored.buffer.normal.getLine(0)!.getCell(0)!.getWidth()).toBe(2);
  });

  it('restores the alternate screen over the normal one', async () => {
    const output = 'shell line\r\n$ vim\r\n\x1b[?1049h\x1b[Hfull screen app\r\n~\r\n~';
    const { restored, expected } = await roundTrip(output);
    expect(restored.buffer.active.type).toBe('alternate');
    expect(lines(restored, 'alternate')).toEqual(lines(expected, 'alternate'));
    expect(lines(restored).slice(0, 2)).toEqual(['shell line', '$ vim']);
  });

  it('records the line of each A, B, C and D sequence by its index since the spawn', async () => {
    const screen = createPtyScreen({ cols: 40, rows: 4, scrollback: 100 });
    screen.write(`${osc(`A;${NONCE}`)}$ ${osc(`B;${NONCE}`)}`);
    screen.write(`ls${osc('E;ls;' + NONCE)}\r\n${osc(`C;${NONCE}`)}a\r\nb\r\nc\r\nd\r\n`);
    screen.write(`${osc(`D;0;${NONCE}`)}${osc(`P;Cwd=/x;${NONCE}`)}${osc(`A;${NONCE}`)}$ `);
    const snapshot = await screen.serialize();
    expect(snapshot.marks).toEqual([
      { index: 0, line: 0 },
      { index: 1, line: 0 },
      { index: 3, line: 1 },
      { index: 4, line: 5 },
      { index: 6, line: 5 },
    ]);
    // xterm ignored every sequence, so none of it shows
    const restored = await restore(snapshot, 100);
    expect(lines(restored).slice(0, 5)).toEqual(['$ ls', 'a', 'b', 'c', 'd']);
    screen.dispose();
  });

  it('records no mark in the alternate screen, and drops marks whose lines left the scrollback', async () => {
    const screen = createPtyScreen({ cols: 20, rows: 2, scrollback: 3 });
    screen.write(`${osc(`A;${NONCE}`)}first\r\n\x1b[?1049h${osc(`A;${NONCE}`)}\x1b[?1049l`);
    expect((await screen.serialize()).marks).toEqual([{ index: 0, line: 0 }]);
    screen.write(Array.from({ length: 10 }, (_, n) => `row ${n}`).join('\r\n'));
    expect((await screen.serialize()).marks).toEqual([]);
    screen.dispose();
  });

  it('serializes the screen once the writes before it are parsed and none after', async () => {
    const screen = createPtyScreen({ cols: 20, rows: 4, scrollback: 10 });
    screen.write('before');
    const serialized = screen.serialize();
    screen.write('\r\nafter');
    const restored = await restore(await serialized, 10);
    expect(lines(restored)[0]).toBe('before');
    expect(lines(restored)).not.toContain('after');
    screen.dispose();
  });

  it('rejects a serialize still waiting when the screen is disposed', async () => {
    const screen = createPtyScreen({ cols: 20, rows: 4, scrollback: 10 });
    screen.write('x'.repeat(100_000));
    const serialized = screen.serialize();
    screen.dispose();
    await expect(serialized).rejects.toThrow('disposed');
  });

  it('runs no callback of a write queued before a dispose, which xterm still parses', async () => {
    const serialize = vi.spyOn(SerializeAddon.prototype, 'serialize');
    try {
      const screen = createPtyScreen({ cols: 20, rows: 4, scrollback: 10 });
      const parsed = vi.fn();
      screen.write('x', parsed);
      screen.clear();
      const serialized = screen.serialize();
      screen.dispose();
      await expect(serialized).rejects.toThrow('disposed');
      // xterm's write loop runs on the timer its first write queued, before this one
      await new Promise((resolve) => setTimeout(resolve));
      expect(parsed).not.toHaveBeenCalled();
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      serialize.mockRestore();
    }
  });

  it('rejects a serialize whose serializer throws, leaving nothing uncaught in xterm\'s write loop', async () => {
    const thrown = vi.spyOn(SerializeAddon.prototype, 'serialize').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    try {
      const screen = createPtyScreen({ cols: 20, rows: 4, scrollback: 10 });
      screen.write('x');
      await expect(screen.serialize()).rejects.toThrow('Invalid string length');
      screen.dispose();
    } finally {
      thrown.mockRestore();
    }
  });

  it('serializes only the scrollback whose longest serialization fits a screen, with the marks moved to the rows kept', async () => {
    const cols = 2000;
    const rows = 10;
    const serialize = vi.spyOn(SerializeAddon.prototype, 'serialize');
    try {
      const screen = createPtyScreen({ cols, rows, scrollback: 100_000 });
      screen.write(Array.from({ length: 400 }, (_, n) => `${n === 350 ? osc(`A;${NONCE}`) : ''}line ${n}`).join('\r\n'));
      const snapshot = await screen.serialize();
      screen.dispose();
      const kept = serialize.mock.calls[0]![0]!.scrollback!;
      expect(kept).toBeLessThan(400);
      expect((kept + rows) * (cols + 1) * 80).toBeLessThanOrEqual(MAX_TERMINAL_SCREEN_CHARS);
      const restored = await restore(snapshot, 100_000);
      expect(lines(restored)[0]).toBe(`line ${400 - rows - kept}`);
      expect(snapshot.marks).toHaveLength(1);
      expect(lines(restored)[snapshot.marks[0]!.line]).toBe('line 350');
    } finally {
      serialize.mockRestore();
    }
  });

  it('counts the OSC 633 sequences it parsed, so the next one\'s index follows the screen', async () => {
    const screen = createPtyScreen({ cols: 20, rows: 4, scrollback: 10 });
    screen.write(`${osc(`A;${NONCE}`)}$ ${osc('P;Cwd=/x')}${osc(`B;${NONCE}`)}`);
    expect((await screen.serialize()).sequences).toBe(3);
    screen.dispose();
  });

  it('clears after the output written before the Clear, as the shell\'s view cleared it', async () => {
    const screen = createPtyScreen({ cols: 20, rows: 4, scrollback: 10 });
    screen.write('cleared 1\r\ncleared 2\r\ncleared 3\r\n$ ');
    screen.clear();
    const restored = await restore(await screen.serialize(), 10);
    expect(lines(restored).join('\n')).not.toContain('cleared');
    screen.dispose();
  });

  it('keeps the scrollback it is given later', async () => {
    const screen = createPtyScreen({ cols: 20, rows: 2, scrollback: 5 });
    screen.setScrollback(50);
    screen.write(Array.from({ length: 30 }, (_, n) => `row ${n}`).join('\r\n'));
    const restored = await restore(await screen.serialize(), 50);
    expect(lines(restored)[0]).toBe('row 0');
    screen.dispose();
  });
});

class FakePty implements Pty {
  readonly pid = 7;
  readonly process = 'bash';
  private dataListener: (data: string) => void = () => undefined;
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(): void {}
  print(data: string): void {
    this.dataListener(data);
  }
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {}
}

describe('the pty host sessions with screens', () => {
  it('posts the pending output, then the screen holding it, then the output printed while it was serialized', async () => {
    const posted: HostMessage[] = [];
    const pty = new FakePty();
    const sessions = createPtySessions({
      spawn: () => pty,
      post: (message) => posted.push(message),
      throttleConpty: false,
      readProcessName: false,
      screen: createPtyScreen,
      log: () => undefined,
    });
    const spawn: HostRequest = { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 20, rows: 4, scrollback: 10 };
    await sessions.handle(spawn);
    pty.print('one');
    const serialized = sessions.handle({ type: 'serialize', id: 'term-1' });
    // the serialize has posted the batch and waits for the screen's parse
    await null;
    await null;
    pty.print(' two');
    await serialized;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const kinds = posted.map((message) => (message.type === 'data' ? `data:${message.data}` : message.type));
    expect(kinds).toEqual(['ready', 'data:one', 'screen', 'data: two']);
    const screen = posted.find((message) => message.type === 'screen');
    const restored = await restore(screen as unknown as ScreenSnapshot, 10);
    expect(lines(restored)[0]).toBe('one');
  });

  it('answers a serialize that failed with a blank screen, so main stops waiting, and keeps every terminal running', async () => {
    const posted: HostMessage[] = [];
    const logs: string[] = [];
    const pty = new FakePty();
    const sessions = createPtySessions({ spawn: () => pty, post: (message) => posted.push(message), throttleConpty: false, readProcessName: false, screen: createPtyScreen, log: (line) => logs.push(line) });
    await sessions.handle({ type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 20, rows: 4, scrollback: 10 });
    pty.print(`${osc(`A;${NONCE}`)}$ `);
    const thrown = vi.spyOn(SerializeAddon.prototype, 'serialize').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    try {
      await sessions.handle({ type: 'serialize', id: 'term-1' });
    } finally {
      thrown.mockRestore();
    }
    expect(posted.find((message) => message.type === 'screen')).toEqual({ type: 'screen', id: 'term-1', data: '', cols: 20, rows: 4, marks: [], sequences: 1 });
    expect(logs).toEqual(['the screen of term-1 could not be serialized: Invalid string length']);
    pty.print('after');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted.at(-1)).toEqual({ type: 'data', id: 'term-1', data: 'after' });
  });

  it('gives the screen the scrollback main posts', async () => {
    const posted: HostMessage[] = [];
    const pty = new FakePty();
    const sessions = createPtySessions({ spawn: () => pty, post: (message) => posted.push(message), throttleConpty: false, readProcessName: false, screen: createPtyScreen, log: () => undefined });
    await sessions.handle({ type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 20, rows: 2, scrollback: 5 });
    await sessions.handle({ type: 'scrollback', id: 'term-1', scrollback: 50 });
    pty.print(Array.from({ length: 30 }, (_, n) => `row ${n}`).join('\r\n'));
    await sessions.handle({ type: 'serialize', id: 'term-1' });
    const screen = posted.find((message) => message.type === 'screen');
    expect(lines(await restore(screen as unknown as ScreenSnapshot, 50))[0]).toBe('row 0');
  });
});
