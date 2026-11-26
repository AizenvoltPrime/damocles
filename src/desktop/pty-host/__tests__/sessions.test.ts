import { describe, expect, it } from 'vitest';
import { TERMINAL_HIGH_WATERMARK_CHARS } from '../../preload/terminal-channels';
import type { HostMessage, HostRequest } from '../protocol';
import { createPtyScreen } from '../screen';
import { createPtySessions, type Pty, type PtySessions } from '../sessions';

class FakePty implements Pty {
  readonly pid = 42;
  readonly process = 'sh';
  paused = false;
  killed = false;
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
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  kill(): void {
    this.killed = true;
  }
}

const SPAWN: Extract<HostRequest, { type: 'spawn' }> = { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 };

function sessionsWith(selfAcknowledge: boolean): { sessions: PtySessions; ptys: FakePty[]; posted: HostMessage[] } {
  const ptys: FakePty[] = [];
  const posted: HostMessage[] = [];
  const sessions = createPtySessions({
    spawn: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
    post: (message) => posted.push(message),
    throttleConpty: false,
    readProcessName: false,
    screen: createPtyScreen,
    selfAcknowledge,
    log: () => undefined,
  });
  return { sessions, ptys, posted };
}

// the screen has consumed every write so far once a serialize answers
const parsed = (sessions: PtySessions): Promise<void> => sessions.handle({ type: 'serialize', id: 'term-1' });

describe('the pty sessions', () => {
  // main issues each id once, so a duplicate is its bug and ends the pty host loudly rather than read as the terminal's end
  it('rejects a spawn whose id is running, starts no second pty and leaves the first running', async () => {
    const { sessions, ptys, posted } = sessionsWith(false);
    await sessions.handle(SPAWN);
    await expect(sessions.handle(SPAWN)).rejects.toThrow('terminal term-1 is already running');
    expect(posted.filter((message) => message.type === 'error')).toEqual([]);
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.killed).toBe(false);
    ptys[0]!.print('still here');
    await parsed(sessions);
    expect(posted.some((message) => message.type === 'data' && message.data === 'still here')).toBe(true);
  });

  it('starts no pty and answers error when its screen cannot be made, holding no session for it', async () => {
    const ptys: FakePty[] = [];
    const posted: HostMessage[] = [];
    let broken = true;
    const sessions = createPtySessions({
      spawn: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
      post: (message) => posted.push(message),
      throttleConpty: false,
      readProcessName: false,
      screen: (options) => {
        if (broken) throw new Error('no screen');
        return createPtyScreen(options);
      },
      log: () => undefined,
    });
    await expect(sessions.handle(SPAWN)).resolves.toBeUndefined();
    expect(posted).toEqual([{ type: 'error', id: 'term-1', message: 'no screen' }]);
    expect(ptys).toHaveLength(0);
    broken = false;
    await sessions.handle(SPAWN);
    expect(posted.at(-1)).toEqual({ type: 'ready', id: 'term-1', pid: 42 });
  });

  it('disposes the screen and answers error when the pty does not start', async () => {
    const posted: HostMessage[] = [];
    const disposed: boolean[] = [];
    let missing = true;
    const sessions = createPtySessions({
      spawn: () => {
        if (missing) throw new Error('no such shell');
        return new FakePty();
      },
      post: (message) => posted.push(message),
      throttleConpty: false,
      readProcessName: false,
      screen: (options) => {
        const screen = createPtyScreen(options);
        const at = disposed.push(false) - 1;
        return {
          ...screen,
          dispose: () => {
            disposed[at] = true;
            screen.dispose();
          },
        };
      },
      log: () => undefined,
    });
    await expect(sessions.handle(SPAWN)).resolves.toBeUndefined();
    expect(posted).toEqual([{ type: 'error', id: 'term-1', message: 'no such shell' }]);
    expect(disposed).toEqual([true]);
    missing = false;
    await sessions.handle(SPAWN);
    expect(posted.at(-1)).toEqual({ type: 'ready', id: 'term-1', pid: 42 });
    expect(disposed).toEqual([true, false]);
  });

  it('forgets the unacknowledged output and resumes the pty when the acknowledging side changes', async () => {
    const { sessions, ptys } = sessionsWith(false);
    await sessions.handle(SPAWN);
    const pty = ptys[0]!;
    pty.print('x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
    await parsed(sessions);
    expect(pty.paused).toBe(true);
    sessions.setSelfAcknowledge(true);
    expect(pty.paused).toBe(false);
    // acknowledged by the screen from here on, whatever the parent acks
    pty.print('x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
    await parsed(sessions);
    expect(pty.paused).toBe(false);
    sessions.setSelfAcknowledge(false);
    pty.print('x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
    await parsed(sessions);
    expect(pty.paused).toBe(true);
    await sessions.handle({ type: 'ack', id: 'term-1', chars: TERMINAL_HIGH_WATERMARK_CHARS + 1 });
    expect(pty.paused).toBe(false);
  });

  it('drops a screen acknowledgement that was pending when the acknowledging side changed', async () => {
    const { sessions, ptys } = sessionsWith(true);
    await sessions.handle(SPAWN);
    const pty = ptys[0]!;
    // parsed only after the switch: its acknowledgement must not count against the parent's
    pty.print('x'.repeat(1000));
    sessions.setSelfAcknowledge(false);
    pty.print('x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
    await parsed(sessions);
    expect(pty.paused).toBe(true);
  });
});
