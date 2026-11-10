import { afterEach, describe, expect, it, vi } from 'vitest';

// the runner's module builds windows only in the renderer process, which these tests replace
vi.mock('electron', () => ({ BrowserWindow: class {}, protocol: {}, app: {}, net: {} }));
import { DesignRendererHost, type RendererChild } from '../design/design-renderer-host';
import { MAX_METHOD_CHARS, MAX_URL_CHARS, parseRendererMessage, readRequest, type MainToRenderer } from '../design/design-renderer-protocol';
import { DesignRunner } from '../design/design-runner';
import type { JourneyStep } from '../../../shared/types/design';
import { contactsPage, type FakeJourneyPage } from './fake-journey-page';
import contacts from '../../../../e2e/fixtures/design-app/static/contacts.preview-journey.json' with { type: 'json' };

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
};

/** A renderer process main drives by messages; `answer` decides each reply, and it can freeze, crash or misbehave. */
function fakeChild(answer: (message: MainToRenderer, child: FakeChild) => void = defaultAnswer) {
  const child = {
    sent: [] as MainToRenderer[],
    messageListeners: new Set<(raw: unknown) => void>(),
    exitListeners: new Set<(description: string) => void>(),
    killed: 0,
    frozen: false,
    emit(raw: unknown) {
      for (const listener of [...this.messageListeners]) listener(raw);
    },
    exit(description: string) {
      for (const listener of [...this.exitListeners]) listener(description);
    },
  };
  const api: RendererChild & typeof child = Object.assign(child, {
    send: (message: MainToRenderer) => {
      child.sent.push(message);
      if (!child.frozen) queueMicrotask(() => answer(message, api));
    },
    onMessage: (listener: (raw: unknown) => void) => {
      child.messageListeners.add(listener);
      return { dispose: () => { child.messageListeners.delete(listener); } };
    },
    onExit: (listener: (description: string) => void) => {
      child.exitListeners.add(listener);
      return { dispose: () => { child.exitListeners.delete(listener); } };
    },
    kill: () => {
      child.killed++;
      child.exit('signal SIGKILL');
    },
  });
  setImmediate(() => api.emit({ t: 'ready' }));
  return api;
}
type FakeChild = ReturnType<typeof fakeChild>;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0x0c, 0, 0, 7, 0x08]);

function defaultAnswer(message: MainToRenderer, child: FakeChild): void {
  if (message.t === 'read') return;
  if (message.t === 'page' && message.op === 'evaluate') {
    const code = message.args[0] as string;
    child.emit({ t: 'done', id: message.id, ok: true, value: code.startsWith('[') ? [1200, 390, 390] : JSON.stringify({ h: 1200, sw: 390, cw: 390, els: [], over: [] }) });
    return;
  }
  child.emit({ t: 'done', id: message.id, ok: true, value: message.t === 'page' && message.op === 'screenshot' ? PNG : undefined });
}

const target = { authority: 'local', designId: 'contacts-1a2b3c4d' };
const capture = { relPath: 'screens/S1.html', width: 390, state: null, scale: 2 };

/** The page's load asks main for one design file, then finishes once main answered it. */
function readingAnswer(message: MainToRenderer, child: FakeChild): void {
  if (message.t === 'page' && message.op === 'load') {
    child.emit({ t: 'read', id: 7, method: 'GET', url: 'damocles-design://abc/screens/S1.html' });
    return;
  }
  if (message.t === 'read') {
    child.emit({ t: 'done', id: (child.sent.find((sent) => sent.t === 'page' && sent.op === 'load') as { id: number }).id, ok: true, value: undefined });
    return;
  }
  defaultAnswer(message, child);
}

interface HostOptions {
  readonly pingMs?: number;
  readonly answerMs?: number;
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly read?: (method: string, url: string) => Promise<Response>;
  // the process exits at once, as one that cannot start does
  readonly exitAtStart?: boolean;
}

function setUp(answer?: (message: MainToRenderer, child: FakeChild) => void, options: HostOptions = {}) {
  const children: FakeChild[] = [];
  const logged: string[] = [];
  const { read: readFile, exitAtStart, ...timing } = options;
  const read = vi.fn(readFile ?? (async (_method: string, _url: string) => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
  const host = new DesignRendererHost({
    start: async () => {
      const child = fakeChild(answer);
      children.push(child);
      if (exitAtStart) {
        child.messageListeners.clear();
        child.onMessage = () => ({ dispose: () => undefined });
        setImmediate(() => child.exit('exit code 1'));
      }
      return child;
    },
    read,
    log: (line) => logged.push(line),
    ...timing,
  });
  const runner = new DesignRunner({ openPage: (origin, width, events) => host.openPage(origin, width, events), log: () => undefined });
  return { host, runner, children, logged, read };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the design renderer process', () => {
  it('starts at the first run, opens one page per run in it, and closes it when the run ends', async () => {
    const { runner, children } = setUp();
    expect(children).toHaveLength(0);
    const shot = await runner.capture(target, capture, new AbortController().signal);
    expect(shot.png).toEqual(PNG);
    expect(children).toHaveLength(1);
    const ops = children[0]!.sent.map((message) => (message.t === 'page' ? message.op : message.t));
    expect(ops[0]).toBe('open');
    expect(ops).toContain('load');
    expect(ops).toContain('screenshot');
    await flush();
    expect(children[0]!.sent.at(-1)).toMatchObject({ t: 'page', op: 'close' });
    await runner.capture(target, capture, new AbortController().signal);
    expect(children).toHaveLength(1);
  });

  it('answers a design scheme request of the renderer as the preview does, through main', async () => {
    const { runner, children, read } = setUp(readingAnswer);
    await runner.capture(target, capture, new AbortController().signal);
    expect(read).toHaveBeenCalledWith('GET', 'damocles-design://abc/screens/S1.html');
    const answer = children[0]!.sent.find((message) => message.t === 'read') as Extract<MainToRenderer, { t: 'read' }>;
    expect(answer).toMatchObject({ id: 7, status: 200 });
    expect(new TextDecoder().decode(answer.body)).toBe('<html></html>');
  });

  it('kills a renderer that stops answering, fails its runs, and starts a new one for the next run (a print dialog\'s hang)', async () => {
    const { runner, children, logged } = setUp((message, child) => {
      if (message.t === 'page' && message.op === 'load') {
        child.frozen = true;
        return;
      }
      defaultAnswer(message, child);
    }, { pingMs: 10, answerMs: 40 });
    await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow(/The design renderer was ended: it stopped answering/);
    expect(children[0]!.killed).toBe(1);
    expect(logged).toContain('[design] ending the design renderer: it stopped answering');
    children.length = 0;
    await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow();
    expect(children).toHaveLength(1);
  });

  it('answers a read whose body fails with 500, so the page\'s request never waits for the run\'s timeout', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const broken = { status: 200, headers: new Headers(), arrayBuffer: () => Promise.reject(new Error('the body broke')) } as unknown as Response;
    const { runner, children } = setUp(readingAnswer, { read: async () => broken });
    await runner.capture(target, capture, new AbortController().signal);
    await flush();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(children[0]!.sent.find((message) => message.t === 'read')).toMatchObject({ id: 7, status: 500, headers: [] });
  });

  it('kills the renderer when a page will not close after a Stop', async () => {
    const { runner, children } = setUp((message, child) => {
      if (message.t === 'page' && (message.op === 'load' || message.op === 'close')) return;
      defaultAnswer(message, child);
    }, { pingMs: 1000, answerMs: 40 });
    const stop = new AbortController();
    const run = runner.capture(target, capture, stop.signal);
    await flush();
    stop.abort(new Error('Stop'));
    await expect(run).rejects.toThrow('Stop');
    await vi.waitFor(() => expect(children[0]!.killed).toBe(1));
  });

  it('ends the runs of a renderer that exits, and of one main stops when its window closes or it quits', async () => {
    const { host, runner, children } = setUp((message, child) => {
      if (message.t === 'page' && message.op === 'load') return;
      defaultAnswer(message, child);
    });
    const crashed = runner.capture(target, capture, new AbortController().signal);
    await flush();
    children[0]!.exit('exit code 3');
    await expect(crashed).rejects.toThrow(/The design renderer ended \(exit code 3\)/);
    const closing = runner.capture(target, capture, new AbortController().signal);
    await flush();
    host.stop('the Damocles window closed');
    await expect(closing).rejects.toThrow(/the Damocles window closed/);
    expect(children[1]!.killed).toBe(1);
  });

  it('kills a renderer whose message is outside the contract', async () => {
    for (const bad of [
      { t: 'done', id: 999_999, ok: true, value: undefined },
      { t: 'shell', command: 'calc.exe' },
      { t: 'console', page: 1, text: 'x'.repeat(5000) },
      { t: 'read', id: 1, method: 'GET', url: 'x'.repeat(9000) },
    ]) {
      const { runner, children } = setUp((message, child) => {
        if (message.t === 'page' && message.op === 'load') {
          child.emit(bad);
          return;
        }
        defaultAnswer(message, child);
      });
      await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow(/The design renderer was ended/);
      expect(children[0]!.killed, JSON.stringify(bad).slice(0, 40)).toBe(1);
    }
  });

  it('has the renderer answer a page\'s request main would refuse itself, so plain page content never ends the renderer', () => {
    const longest = `damocles-design://abc/${'a'.repeat(MAX_URL_CHARS - 'damocles-design://abc/'.length)}`;
    expect(parseRendererMessage(readRequest(3, 'GET', longest))).toEqual({ t: 'read', id: 3, method: 'GET', url: longest });
    expect(readRequest(4, 'GET', `${longest}a`)).toBeUndefined();
    expect(readRequest(5, 'X'.repeat(MAX_METHOD_CHARS + 1), 'damocles-design://abc/a.png')).toBeUndefined();
  });

  it('kills a renderer that answers a capture with anything but bounded bytes', async () => {
    for (const value of ['iVBOR', new Uint8Array(32 * 1024 * 1024 + 1)]) {
      const { runner, children } = setUp((message, child) => {
        if (message.t === 'page' && message.op === 'screenshot') {
          child.emit({ t: 'done', id: message.id, ok: true, value });
          return;
        }
        defaultAnswer(message, child);
      });
      await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow();
      expect(children[0]!.killed).toBe(1);
    }
  });

  it('kills a renderer that never says it is ready, and one whose start lands after main stopped it', async () => {
    const silent: FakeChild[] = [];
    const host = new DesignRendererHost({
      start: async () => {
        const child = fakeChild();
        child.messageListeners.clear();
        child.onMessage = () => ({ dispose: () => undefined });
        silent.push(child);
        return child;
      },
      read: async () => new Response(''),
      log: () => undefined,
      startMs: 30,
    });
    const runner = new DesignRunner({ openPage: (origin, width, events) => host.openPage(origin, width, events), log: () => undefined });
    await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow(/did not start/);
    expect(silent[0]!.killed).toBe(1);
    let release!: (child: FakeChild) => void;
    const late = new DesignRendererHost({ start: () => new Promise<FakeChild>((resolve) => (release = resolve)), read: async () => new Response(''), log: () => undefined });
    const page = late.openPage('damocles-design://abc', 390, { consoleError: () => undefined, gone: () => undefined });
    const loading = page.load('damocles-design://abc/screens/S1.html');
    late.stop('Damocles is quitting');
    const child = fakeChild();
    release(child);
    await expect(loading).rejects.toThrow();
    await flush();
    expect(child.killed).toBe(1);
  });

  it('passes the page\'s console errors to its run', async () => {
    const { runner } = setUp((message, child) => {
      if (message.t === 'page' && message.op === 'load') child.emit({ t: 'console', page: 1, text: 'TypeError: x is undefined' });
      defaultAnswer(message, child);
    });
    const probe = await runner.probe(target, { relPath: 'screens/S1.html', widths: [390], state: null }, new AbortController().signal);
    expect(probe.consoleErrors).toEqual(['TypeError: x is undefined']);
  });

  it('relays the CDP commands of a journey to the page by name and parameters, and hands their answers to the journey unread', async () => {
    const pages = new Map<number, FakeJourneyPage>();
    const { runner, children } = setUp((message, child) => {
      if (message.t === 'open') pages.set(message.page, contactsPage(message.width));
      if (message.t === 'page' && message.op === 'resize') pages.set(message.page, contactsPage(message.args[0] as number));
      if (message.t === 'page' && message.op === 'cdp') {
        pages.get(message.page)!.send(message.args[0] as never, message.args[1] as Record<string, unknown>).then((value) => child.emit({ t: 'done', id: message.id, ok: true, value }), (err: Error) => child.emit({ t: 'done', id: message.id, ok: false, error: err.message }));
        return;
      }
      defaultAnswer(message, child);
    });
    const run = await runner.journey(target, { relPath: 'screens/S1.html', widths: [390], state: null, steps: contacts.steps as JourneyStep[], outline: false }, new AbortController().signal);
    expect(run.widths[0]).toMatchObject({ width: 390, passed: true });
    const cdp = children[0]!.sent.filter((message): message is Extract<MainToRenderer, { t: 'page' }> => message.t === 'page' && message.op === 'cdp');
    // the media pin goes first, before the page loads
    expect(cdp[0]!.args[0]).toBe('Emulation.setEmulatedMedia');
    expect(cdp[1]!.args).toEqual(['Runtime.releaseObjectGroup', { objectGroup: 'damocles-journey' }]);
    expect(cdp.some((message) => message.args[0] === 'Input.dispatchKeyEvent' && (message.args[1] as { key: string }).key === 'Escape')).toBe(true);
    expect(children[0]!.killed).toBe(0);
  });

  it('stops pinging once a page that failed to open is gone, so a busy renderer with no page is not killed', async () => {
    const { runner, children } = setUp((message, child) => {
      if (message.t === 'open') {
        child.emit({ t: 'done', id: message.id, ok: false, error: 'No window' });
        return;
      }
      if (message.t === 'ping') return;
      defaultAnswer(message, child);
    }, { pingMs: 10, answerMs: 40 });
    await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow('No window');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(children[0]!.killed).toBe(0);
  });

  it('starts a renderer that keeps ending at most three times again in 5 minutes, then refuses with the reason until Restart Engine', async () => {
    let clock = 0;
    const { host, runner, children } = setUp(undefined, { exitAtStart: true, now: () => clock });
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow('The design renderer ended (exit code 1)');
      clock += 1000;
    }
    expect(children).toHaveLength(4);
    await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow(/ended 4 times in 5 minutes.*exit code 1.*Restart Engine/);
    expect(children).toHaveLength(4);
    host.reset();
    await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow('The design renderer ended (exit code 1)');
    expect(children).toHaveLength(5);
  });

  it('does not count the ends main asks for, and starts again once 5 minutes passed', async () => {
    let clock = 0;
    const { runner, children } = setUp(undefined, { exitAtStart: true, now: () => clock });
    for (let attempt = 0; attempt < 3; attempt++) await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow();
    clock += 5 * 60 * 1000;
    for (let attempt = 0; attempt < 2; attempt++) await expect(runner.capture(target, capture, new AbortController().signal)).rejects.toThrow('The design renderer ended (exit code 1)');
    expect(children).toHaveLength(5);
    const asked = setUp((message, child) => {
      if (message.t === 'page' && message.op === 'load') return;
      defaultAnswer(message, child);
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = asked.runner.capture(target, capture, new AbortController().signal);
      await flush();
      asked.host.stop('the Damocles window closed');
      await expect(run).rejects.toThrow(/the Damocles window closed/);
    }
    expect(asked.children).toHaveLength(5);
  });

  it('stops a renderer that held no page for 5 minutes, and the next run starts a new one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { runner, children, logged } = setUp();
    await runner.capture(target, capture, new AbortController().signal);
    await flush();
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(children[0]!.killed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(children[0]!.killed).toBe(1);
    expect(logged).toContain('[design] ending the design renderer: it held no page for 5 minutes');
    await runner.capture(target, capture, new AbortController().signal);
    expect(children).toHaveLength(2);
  });
});
