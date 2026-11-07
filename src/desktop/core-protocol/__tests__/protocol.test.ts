import { describe, expect, it, vi } from 'vitest';
import { createEndpoint, CoreProtocolError } from '../endpoint';
import { createLoopback } from '../loopback';
import { CORE_TO_MAIN, MAIN_TO_CORE, MAX_KEY_CHARS, type CoreToMain, type MainToCore } from '../messages';
import { MAX_DESIGN_ID_CHARS } from '../../../shared/design-paths';
import { MAX_CHANGED_PATHS } from '../../../shared/design-render';
import { MAX_MARKUP_JSON_CHARS } from '../../../shared/design-markup';
import { arr, data, INVALID, obj, opt, str } from '../schema';
import { EDITOR_HARD_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { CLIENT_TO_WORKSPACE } from '../../workspace/messages';
import { GitError, gitErrorText, GitUntrustedError, RemoteCancelledError, StashKeptError, SyncBranchChangedError } from '../../../core/scm/errors';
import { createCoreEndpoint, createMainEndpoint } from '..';

const quiet = (): void => undefined;

function pair(onViolation?: (error: CoreProtocolError) => void) {
  const { main, core } = createLoopback();
  const options = { log: quiet, ...(onViolation ? { onViolation } : {}) };
  return {
    transports: { main, core },
    main: createEndpoint<MainToCore, CoreToMain>({ transport: main, outgoing: MAIN_TO_CORE, incoming: CORE_TO_MAIN, ...options }),
    core: createEndpoint<CoreToMain, MainToCore>({ transport: core, outgoing: CORE_TO_MAIN, incoming: MAIN_TO_CORE, ...options }),
  };
}

describe('parsers', () => {
  it('keep only the fields they know, and leave an absent optional field absent', () => {
    const parse = obj({ name: str(10), note: opt(str(10)), tags: arr(str(5), 2) });
    expect(parse({ name: 'a', tags: ['x'], extra: 1, note: undefined })).toEqual({ name: 'a', tags: ['x'] });
    expect(Object.keys(parse({ name: 'a', tags: [] }) as object)).toEqual(['name', 'tags']);
    expect(parse({ name: 'a', tags: ['x', 'y', 'z'] })).toBe(INVALID);
    expect(parse({ name: 'far too long', tags: [] })).toBe(INVALID);
  });

  it('take JSON-shaped data within its size and nothing else', () => {
    const parse = data(20);
    expect(parse({ a: [1, 'two', null, undefined, true] })).not.toBe(INVALID);
    expect(parse({ text: 'x'.repeat(30) })).toBe(INVALID);
    expect(parse(new Map([['a', 1]]))).toBe(INVALID);
    expect(parse({ frame: new ArrayBuffer(2), view: new Uint8Array(2) })).not.toBe(INVALID);
    expect(parse({ frame: new ArrayBuffer(64) })).toBe(INVALID);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(parse(cycle)).toBe(INVALID);
    const shared = { a: 1 };
    expect(parse({ left: shared, right: shared })).not.toBe(INVALID);
  });
});

describe('numbers a peer sends', () => {
  const memory = { id: 'g1', kind: 'fact', content: 'c', contentHash: 'h', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 };
  const resolve = MAIN_TO_CORE.requests['user.memory.resolve'].result;

  it('take a relayed memory\'s times only as whole milliseconds from 0 up', () => {
    expect(resolve([{ id: 'g1', memory }])).not.toBe(INVALID);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(resolve([{ id: 'g1', memory: { ...memory, createdAt: bad } }])).toBe(INVALID);
      expect(resolve([{ id: 'g1', memory: { ...memory, updatedAt: bad } }])).toBe(INVALID);
    }
  });

  it('take a sent file\'s time only as a finite number, before 1970 included', () => {
    const receive = CLIENT_TO_WORKSPACE.requests['files.receiveFile'].params;
    const file = { project: { key: '/srv/app', fsPath: '/srv/app', name: 'app' }, relativeDir: '', name: 'a.txt', stream: 1024, mode: 0o644, replace: false, size: 3 };
    for (const mtimeMs of [0, -86_400_000.5, 1_700_000_000_000.25]) expect(receive({ ...file, mtimeMs })).not.toBe(INVALID);
    for (const mtimeMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(receive({ ...file, mtimeMs })).toBe(INVALID);
  });

  it('give each name of the e2e proxy answers at least one answer', () => {
    const answers = MAIN_TO_CORE.requests['e2e.clientNetworkAnswers'].params;
    expect(answers({ answers: { 'a.test': [['127.0.0.1']] } })).not.toBe(INVALID);
    expect(answers({ answers: { 'a.test': [] } })).toBe(INVALID);
  });
});

describe('a session file write', () => {
  const write = MAIN_TO_CORE.requests['sessionFiles.write'];
  const sha = 'a'.repeat(64);

  it('takes the bytes as bytes within the editor\'s limit, and the expected hash only as a sha256 or null', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(write.params({ path: '/home/u/.damocles/pi/agent/sessions/x/a_b.jsonl', bytes, expectedSha256: sha })).toEqual({ path: '/home/u/.damocles/pi/agent/sessions/x/a_b.jsonl', bytes, expectedSha256: sha });
    expect(write.params({ path: '/s/a_b.jsonl', bytes, expectedSha256: null })).toEqual({ path: '/s/a_b.jsonl', bytes, expectedSha256: null });
    expect(write.params({ path: '/s/a_b.jsonl', bytes: [1, 2, 3], expectedSha256: sha })).toBe(INVALID);
    expect(write.params({ path: '/s/a_b.jsonl', bytes: new Uint8Array(EDITOR_HARD_MAX_DOCUMENT_BYTES + 1), expectedSha256: sha })).toBe(INVALID);
    expect(write.params({ path: '/s/a_b.jsonl', bytes, expectedSha256: 'A'.repeat(64) })).toBe(INVALID);
    expect(write.params({ path: '/s/a_b.jsonl', bytes })).toBe(INVALID);
  });

  it('answers only an outcome main acts on', () => {
    for (const answer of [{ kind: 'written', mtimeMs: 1.5 }, { kind: 'changed' }, { kind: 'outside' }, { kind: 'refused', reason: 'held' }, { kind: 'refused', reason: 'otherProcess' }]) {
      expect(write.result(answer)).toEqual(answer);
    }
    expect(write.result({ kind: 'written', mtimeMs: Number.NaN })).toBe(INVALID);
    expect(write.result({ kind: 'refused', reason: 'busy' })).toBe(INVALID);
    expect(write.result({ kind: 'refused', reason: 'held', message: 'free text' })).toEqual({ kind: 'refused', reason: 'held' });
  });

  it('reaches main from a workspace read as the flag true or nothing, on a file or a missing one', () => {
    const bytes = new Uint8Array([1]);
    for (const method of ['files.read', 'files.readOutside'] as const) {
      const { result } = CLIENT_TO_WORKSPACE.requests[method];
      const read = { kind: 'bytes', bytes, mtimeMs: 1, dev: 2, ino: 3 };
      expect(result({ ...read, sessionFile: true }), method).toEqual({ ...read, sessionFile: true });
      expect(result(read), method).toEqual(read);
      expect(result({ kind: 'missing', sessionFile: true }), method).toEqual({ kind: 'missing', sessionFile: true });
      expect(result({ ...read, sessionFile: false }), method).toBe(INVALID);
      expect(result({ kind: 'missing', sessionFile: 'yes' }), method).toBe(INVALID);
    }
  });
});

describe('the design preview’s wire', () => {
  it('takes a design file as bytes with a fidelity, tooLarge or nothing, and nothing else', () => {
    const read = MAIN_TO_CORE.requests['design.read'].result;
    expect(read({ bytes: new Uint8Array([1]), fidelity: 'static' })).not.toBe(INVALID);
    expect(read({ bytes: new Uint8Array([1]), fidelity: null })).not.toBe(INVALID);
    expect(read('tooLarge')).toBe('tooLarge');
    expect(read(undefined)).toBeUndefined();
    expect(read({ bytes: 'text', fidelity: 'static' })).toBe(INVALID);
    expect(read({ bytes: new Uint8Array([1]), fidelity: 'scripted' })).toBe(INVALID);
  });

  it('takes design.markup with a bounded base64 PNG and the markup for core to parse, answering F<n> or a localized refusal', () => {
    const markup = MAIN_TO_CORE.requests['design.markup'];
    const json = { screen: 'S1', file: 'screens/S1.html', viewport: { breakpoint: 'xl', width: 1280 }, zoom: 1, pixelRatio: 2, state: 'default', marks: [] };
    expect(markup.params({ panelId: 'p', png: 'iVBORw0KGgo=', json })).toEqual({ panelId: 'p', png: 'iVBORw0KGgo=', json });
    expect(markup.params({ panelId: 'p', png: 'A'.repeat(3_932_161), json })).toBe(INVALID);
    expect(markup.params({ panelId: 'p', png: 42, json })).toBe(INVALID);
    expect(markup.result({ feedbackId: 'F1' })).toEqual({ feedbackId: 'F1' });
    expect(markup.result({ refused: { message: 'This design chat is not running.' } })).toEqual({ refused: { message: 'This design chat is not running.' } });
    expect(markup.result({ refused: 'plain text' })).toBe(INVALID);
  });

  it('takes a screen’s facts only with whole widths and bounded names', () => {
    const info = MAIN_TO_CORE.requests['design.info'].result;
    const facts = { path: '/home/u/.damocles/designs/d/screens/S1.html', screenId: 'S1', title: null, breakpoints: [{ name: 'xl', width: 1280 }], primary: 1280, checked: [640], journey: [], states: ['default'] };
    expect(info(facts)).not.toBe(INVALID);
    expect(info({ ...facts, primary: 12.5 })).toBe(INVALID);
    expect(info({ ...facts, states: ['x'.repeat(200)] })).toBe(INVALID);
    expect(info({ ...facts, breakpoints: [{ name: 'xl', width: -1 }] })).toBe(INVALID);
  });

  it('takes the tweaks of design.info only with token names, 2 to 5 controls and 2 to 8 stops, and absent from an older core', () => {
    const info = MAIN_TO_CORE.requests['design.info'].result;
    const facts = { path: '/p/screens/S1.html', screenId: 'S1', title: null, breakpoints: [], primary: 1280, checked: [], journey: [], states: [] };
    const control = (id: string, property: string, stops: string[]) => ({ id, label: id, property, kind: 'segment', stops: stops.map((token) => ({ token, value: '1px' })), locked: null });
    const tweaks = { toolCallId: 'call-1', controls: [control('radius', '--radius', ['--radius-sm', '--radius-lg']), { ...control('accent', '--accent', ['--a', '--b']), kind: 'swatch', locked: { decisionId: 'D1', value: '--a' } }] };
    expect(info(facts)).toEqual(facts);
    expect(info({ ...facts, tweaks: null })).toEqual({ ...facts, tweaks: null });
    expect(info({ ...facts, tweaks })).toEqual({ ...facts, tweaks });
    expect(info({ ...facts, tweaks: { ...tweaks, controls: [tweaks.controls[0]] } })).toBe(INVALID);
    expect(info({ ...facts, tweaks: { ...tweaks, controls: [control('radius', 'radius', ['--a', '--b']), tweaks.controls[1]] } })).toBe(INVALID);
    expect(info({ ...facts, tweaks: { ...tweaks, controls: [control('radius', '--radius', ['--a', '--b);}']), tweaks.controls[1]] } })).toBe(INVALID);
    expect(info({ ...facts, tweaks: { ...tweaks, controls: [control('radius', '--radius', ['--a']), tweaks.controls[1]] } })).toBe(INVALID);
  });

  it('takes design.tweak with a tweak id and a token, answering kept or a localized refusal', () => {
    const tweak = MAIN_TO_CORE.requests['design.tweak'];
    expect(tweak.params({ panelId: 'p', tweakId: 'radius', value: '--radius-lg' })).toEqual({ panelId: 'p', tweakId: 'radius', value: '--radius-lg' });
    expect(tweak.params({ panelId: 'p', tweakId: 'radius', value: '12px' })).toBe(INVALID);
    expect(tweak.result({ kept: true })).toEqual({ kept: true });
    expect(tweak.result({ kept: false })).toBe(INVALID);
    expect(tweak.result({ refused: { message: 'This design continues in another chat.' } })).toEqual({ refused: { message: 'This design continues in another chat.' } });
    expect(tweak.result({ refused: 'plain text' })).toBe(INVALID);
  });

  it('takes design.openPreview with a design and a path only, and design.changed with at most MAX_CHANGED_PATHS paths', () => {
    const open = CORE_TO_MAIN.requests['design.openPreview'].params;
    expect(open({ panelId: 'p', designId: 'd', relPath: 'screens/S1.html' })).toEqual({ panelId: 'p', designId: 'd', relPath: 'screens/S1.html' });
    expect(open({ panelId: 'p', designId: 'd', relPath: 'screens/S1.html', width: 900, url: 'https://example.com/' })).toEqual({ panelId: 'p', designId: 'd', relPath: 'screens/S1.html' });
    const changed = CORE_TO_MAIN.events['design.changed'];
    expect(changed({ designId: 'd', paths: Array.from({ length: MAX_CHANGED_PATHS }, (_, index) => `f${index}`) })).not.toBe(INVALID);
    expect(changed({ designId: 'd', paths: Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, index) => `f${index}`) })).toBe(INVALID);
  });

  it('bounds every design message\'s design id by MAX_DESIGN_ID_CHARS, which core\'s ids never pass', () => {
    const longest = 'd'.repeat(MAX_DESIGN_ID_CHARS);
    const over = `${longest}d`;
    const file = { relPath: 'screens/S1.html' };
    const capture = { ...file, width: 390, state: null, scale: 2 };
    for (const [parser, params] of [
      [CORE_TO_MAIN.requests['design.openPreview'].params, { panelId: 'p', ...file }],
      [CORE_TO_MAIN.requests['design.capture'].params, capture],
      [MAIN_TO_CORE.requests['design.read'].params, file],
      [MAIN_TO_CORE.requests['design.info'].params, file],
      [CORE_TO_MAIN.events['design.changed'], { paths: [] }],
    ] as const) {
      expect((parser as (raw: unknown) => unknown)({ ...params, designId: longest })).not.toBe(INVALID);
      expect((parser as (raw: unknown) => unknown)({ ...params, designId: over })).toBe(INVALID);
    }
  });

  it('takes the markup main sends core only as plain JSON data within MAX_MARKUP_JSON_CHARS', () => {
    const params = MAIN_TO_CORE.requests['design.markup'].params;
    expect(params({ panelId: 'p', png: 'iVBORw0KGgo=', json: { marks: [{ text: 'x'.repeat(MAX_MARKUP_JSON_CHARS - 64) }] } })).not.toBe(INVALID);
    expect(params({ panelId: 'p', png: 'iVBORw0KGgo=', json: { marks: [{ text: 'x'.repeat(MAX_MARKUP_JSON_CHARS) }] } })).toBe(INVALID);
    expect(params({ panelId: 'p', png: 'iVBORw0KGgo=', json: { at: new Date(0) } })).toBe(INVALID);
  });

  it('takes a tweak declaration\'s tool call id at a key\'s bound, since a provider\'s call id has no fixed length', () => {
    const info = MAIN_TO_CORE.requests['design.info'].result;
    const control = (id: string, property: string) => ({ id, label: id, property, kind: 'segment', stops: [{ token: '--a', value: '1px' }, { token: '--b', value: '2px' }], locked: null });
    const facts = { path: '/p/screens/S1.html', screenId: 'S1', title: null, breakpoints: [], primary: 1280, checked: [], journey: [], states: [] };
    const tweaks = { toolCallId: 'c'.repeat(MAX_KEY_CHARS), controls: [control('radius', '--radius'), control('space', '--space')] };
    expect(info({ ...facts, tweaks })).toEqual({ ...facts, tweaks });
    expect(info({ ...facts, tweaks: { ...tweaks, toolCallId: 'c'.repeat(MAX_KEY_CHARS + 1) } })).toBe(INVALID);
  });
});

describe('the loopback transport', () => {
  it('delivers a structured clone, on the caller\'s stack', () => {
    const { main, core } = createLoopback();
    const received: unknown[] = [];
    core.onMessage((raw) => received.push(raw));
    const sent = { nested: { value: 1 } };
    main.post(sent);
    sent.nested.value = 2;
    expect(received).toEqual([{ nested: { value: 1 } }]);
    expect(received[0]).not.toBe(sent);
  });

  it('refuses what cannot be cloned', () => {
    const { main, core } = createLoopback();
    core.onMessage(quiet);
    expect(() => main.post({ run: () => undefined })).toThrow(/could not be cloned/);
  });
});

describe('the endpoint', () => {
  it('answers a request with the result its handler resolves', async () => {
    const { main, core } = pair();
    main.serve('secrets.get', ({ key }) => Promise.resolve(`value of ${key}`));
    expect(await core.request('secrets.get', { key: 'k' })).toBe('value of k');
  });

  it('rejects with the handler\'s error message', async () => {
    const { main, core } = pair();
    main.serve('editor.readText', () => Promise.reject(new Error('ENOENT: no such file')));
    await expect(core.request('editor.readText', { path: '/x' })).rejects.toThrow('ENOENT: no such file');
  });

  it('aborts the handler\'s signal when the caller aborts', async () => {
    const { main, core } = pair();
    let seen: AbortSignal | undefined;
    main.serve('dialogs.pickFolder', (_options, signal) => {
      seen = signal;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined)));
    });
    const controller = new AbortController();
    const answer = core.request('dialogs.pickFolder', {}, controller.signal);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
    expect(await answer).toBeUndefined();
  });

  it('rejects pending requests on close', async () => {
    const { main, core } = pair();
    main.serve('trust.request', () => new Promise(() => undefined));
    const pending = core.request('trust.request', { folderPath: '/p' });
    core.close('core went away');
    await expect(pending).rejects.toThrow('core went away');
    await expect(core.request('secrets.keys', {})).rejects.toThrow('core went away');
  });

  it('delivers mirror deltas in version order', () => {
    const { main, core } = pair();
    const patches: unknown[] = [];
    core.onMirror('language', (patch) => patches.push(patch));
    main.publish('language', { language: 'en' });
    main.publish('language', { language: 'el' });
    expect(patches).toEqual([{ language: 'en' }, { language: 'el' }]);
  });

  it('sends a delta before the reply that depends on it', async () => {
    const { main, core } = pair();
    const order: string[] = [];
    core.onMirror('trust', () => order.push('delta'));
    main.serve('trust.request', async ({ folderPath }) => {
      main.publish('trust', { keys: [folderPath], granted: [folderPath] });
      return true;
    });
    await core.request('trust.request', { folderPath: '/p' }).then(() => order.push('reply'));
    expect(order).toEqual(['delta', 'reply']);
  });

  // Electron's postMessage throws a plain Error for what it cannot clone, not the DOMException structuredClone throws.
  it('settles a request whose result cannot cross as a plain failure, whatever error the transport throws', async () => {
    const { main, core } = createLoopback();
    const lines: string[] = [];
    const electronLike = {
      post: (message: unknown) => {
        if ((message as { result?: unknown }).result instanceof Function) throw new Error('An object could not be cloned.');
        main.post(message);
      },
      onMessage: main.onMessage,
    };
    const mainEnd = createEndpoint<MainToCore, CoreToMain>({ transport: electronLike, outgoing: MAIN_TO_CORE, incoming: CORE_TO_MAIN, log: (line) => lines.push(line) });
    const coreEnd = createEndpoint<CoreToMain, MainToCore>({ transport: core, outgoing: CORE_TO_MAIN, incoming: MAIN_TO_CORE, log: quiet });
    mainEnd.serve('secrets.get', () => Promise.resolve((() => 'x') as unknown as string));
    await expect(coreEnd.request('secrets.get', { key: 'k' })).rejects.toThrow('An object could not be cloned.');
    expect(lines).toEqual([expect.stringContaining('response 1 could not be sent')]);
  });

  it('keeps a topic\'s version when its delta could not be sent, so the next delta is the next version', () => {
    const { main, core } = pair();
    const patches: unknown[] = [];
    core.onMirror('state', (patch) => patches.push(patch));
    expect(() => main.publish('state', { scope: 'global', key: 'k', value: () => undefined })).toThrow(/could not be cloned/);
    main.publish('state', { scope: 'global', key: 'k', value: 1 });
    expect(patches).toEqual([{ scope: 'global', key: 'k', value: 1 }]);
  });
});

describe('a protocol violation', () => {
  it('is thrown in process', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'event', name: 'secrets.changed', payload: { key: 7 } })).toThrow(CoreProtocolError);
    expect(() => transports.main.post({ kind: 'nonsense' })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'request', id: 1, method: 'fs.deleteEverything', params: {} })).toThrow(CoreProtocolError);
  });

  it('includes a skipped mirror version', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'mirror', topic: 'language', version: 2, patch: { language: 'en' } })).toThrow(/expected v1/);
  });

  it('includes a result outside the contract, which also rejects the call', async () => {
    const violations: CoreProtocolError[] = [];
    const { main, core } = pair((error) => violations.push(error));
    main.serve('shell.openExternal', () => 'yes' as unknown as boolean);
    await expect(core.request('shell.openExternal', { url: 'https://example.com/' })).rejects.toThrow(CoreProtocolError);
    expect(violations).toHaveLength(1);
  });

  it('includes a response to no request', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'response', id: 41, ok: true, result: undefined })).toThrow(/unknown request/);
  });
});

describe('core\'s own requests and answers outside the contract', () => {
  const tooManyIds = Array.from({ length: 65 }, (_, n) => `id-${n}`);

  it('fail that one request in core, which main never sees, and the channel stays up', async () => {
    const { main, core } = createLoopback();
    const violations: CoreProtocolError[] = [];
    const mainEnd = createMainEndpoint(main, quiet, (error) => violations.push(error));
    const coreEnd = createCoreEndpoint(core, quiet);
    const served = vi.fn(async () => []);
    mainEnd.serve('user.memory.resolve', served);
    await expect(coreEnd.request('user.memory.resolve', { clientId: 'client-a', ids: tooManyIds })).rejects.toThrow(CoreProtocolError);
    expect(served).not.toHaveBeenCalled();
    expect(violations).toEqual([]);
    await expect(coreEnd.request('user.memory.resolve', { clientId: 'client-a', ids: ['id-1'] })).resolves.toEqual([]);
  });

  it('reach main as a failed call, never as a violation', async () => {
    const { main, core } = createLoopback();
    const violations: CoreProtocolError[] = [];
    const mainEnd = createMainEndpoint(main, quiet, (error) => violations.push(error));
    const coreEnd = createCoreEndpoint(core, quiet);
    const tags = Array.from({ length: 65 }, (_, n) => `tag-${n}`);
    coreEnd.serve('user.memory.resolve', async () => [{ id: 'g1', memory: { id: 'g1', kind: 'fact' as const, content: 'c', contentHash: 'h', tags, createdAt: 1, updatedAt: 1 } }]);
    await expect(mainEnd.request('user.memory.resolve', { ids: ['g1'] })).rejects.toThrow(/answer to user\.memory\.resolve/);
    expect(violations).toEqual([]);
  });
});

describe('main\'s requests and answers, and either side\'s events, outside the contract', () => {
  const tooLong = 'd'.repeat(129);

  it('fail main\'s request in main and its answer in core, so core never sees them as a violation and stays up', async () => {
    const { main, core } = createLoopback();
    const violations: CoreProtocolError[] = [];
    const logged: string[] = [];
    const mainEnd = createMainEndpoint(main, (line) => logged.push(line));
    const coreEnd = createCoreEndpoint(core, quiet, (error) => violations.push(error));
    const served = vi.fn(() => undefined);
    coreEnd.serve('design.info', served);
    await expect(mainEnd.request('design.info', { designId: tooLong, relPath: 'screens/S1.html' })).rejects.toThrow(CoreProtocolError);
    expect(served).not.toHaveBeenCalled();
    mainEnd.serve('design.capture', () => ({ png: new Uint8Array([1]), cssWidth: 390, cssHeight: 0, contentHeight: 0, scale: 2 }));
    await expect(coreEnd.request('design.capture', { designId: 'd', relPath: 'screens/S1.html', width: 390, state: null, scale: 2 })).rejects.toThrow(/answer to design\.capture/);
    expect(violations).toEqual([]);
    expect(logged.filter((line) => line.includes('Bug'))).toHaveLength(2);
    await expect(mainEnd.request('design.info', { designId: 'd', relPath: 'screens/S1.html' })).resolves.toBeUndefined();
  });

  it('drop an event outside the contract on the sending side with a log line, never ending the receiving side', () => {
    const { main, core } = createLoopback();
    const violations: CoreProtocolError[] = [];
    const logged: string[] = [];
    const mainEnd = createMainEndpoint(main, quiet, (error) => violations.push(error));
    const coreEnd = createCoreEndpoint(core, (line) => logged.push(line), (error) => violations.push(error));
    const changed = vi.fn();
    mainEnd.onEvent('design.changed', changed);
    coreEnd.emit('design.changed', { designId: tooLong, paths: [] });
    coreEnd.emit('design.changed', { designId: 'd', paths: [] });
    expect(changed.mock.calls).toEqual([[{ designId: 'd', paths: [] }]]);
    expect(logged).toEqual(['[core-protocol] Bug: a design.changed event outside the contract was dropped']);
    const steps = vi.fn();
    coreEnd.onEvent('worktrees.setupStep', steps);
    mainEnd.emit('worktrees.setupStep', { worktreeId: 'w'.repeat(10_000) } as never);
    expect(steps).not.toHaveBeenCalled();
    expect(violations).toEqual([]);
  });

  it('still end the channel where the receiving side parses what a peer posted past its own check', () => {
    const { main, core } = createLoopback();
    const violations: CoreProtocolError[] = [];
    createMainEndpoint(main, quiet, (error) => violations.push(error));
    core.post({ kind: 'event', name: 'design.changed', payload: { designId: tooLong, paths: [] } });
    expect(violations.map((error) => error.message)).toEqual(['Core protocol violation: event design.changed']);
  });
});

describe('the facade', () => {
  it('pairs main\'s and core\'s endpoints over one transport pair', async () => {
    const { main, core } = createLoopback();
    const mainEnd = createMainEndpoint(main, quiet);
    const coreEnd = createCoreEndpoint(core, quiet);
    const handler = vi.fn(() => Promise.resolve('PROXY x:1'));
    mainEnd.serve('network.resolveProxy', handler);
    expect(await coreEnd.request('network.resolveProxy', { url: 'https://a/' })).toBe('PROXY x:1');
    expect(handler).toHaveBeenCalledWith({ url: 'https://a/' }, expect.any(AbortSignal));
  });
});

describe('source control errors across the channel', () => {
  const pairWith = (onViolation?: (error: CoreProtocolError) => void) => {
    const { main, core } = createLoopback();
    return { main: createMainEndpoint(main, quiet, onViolation), core: createCoreEndpoint(core, quiet, onViolation), transports: { main, core } };
  };

  it('are rebuilt in main as the classes ScmHost acts on, with their fields', async () => {
    const { main, core } = pairWith();
    const confirmed = { branch: 'main', remote: 'origin', upstreamBranch: 'main' };
    const errors: Error[] = [
      new StashKeptError({ message: 'Your changes are in the stash' }, 'failed', 'a'.repeat(40), new GitError('git pull exited with 1', 1, 'out', 'error: conflict in a.ts')),
      new SyncBranchChangedError({ message: 'The branch changed' }, 'push', confirmed, null),
      new RemoteCancelledError(),
      new GitUntrustedError(),
      new GitError('git fetch exited with 128', 128, 'ignored', 'fatal: unable to access'),
    ];
    let next = 0;
    core.serve('scm.call', () => Promise.reject(errors[next++]));
    const rebuilt: unknown[] = [];
    for (let i = 0; i < errors.length; i++) rebuilt.push(await main.request('scm.call', { method: 'fetch', args: ['repo-1', {}] }).catch((err: unknown) => err));
    const [stash, sync, cancelled, untrusted, git] = rebuilt as [StashKeptError, SyncBranchChangedError, Error, Error, GitError];
    expect(stash).toBeInstanceOf(StashKeptError);
    expect({ text: stash.text, message: stash.message, outcome: stash.outcome, stash: stash.stash }).toEqual({ text: { message: 'Your changes are in the stash' }, message: 'Your changes are in the stash', outcome: 'failed', stash: 'a'.repeat(40) });
    expect(stash.cause).toBeInstanceOf(GitError);
    expect(gitErrorText(stash.cause)).toBe('error: conflict in a.ts');
    expect(sync).toBeInstanceOf(SyncBranchChangedError);
    expect({ text: sync.text, stage: sync.stage, confirmed: sync.confirmed, found: sync.found }).toEqual({ text: { message: 'The branch changed' }, stage: 'push', confirmed, found: null });
    expect(cancelled).toBeInstanceOf(RemoteCancelledError);
    expect(untrusted).toBeInstanceOf(GitUntrustedError);
    expect(git).toBeInstanceOf(GitError);
    expect({ exitCode: git.exitCode, stderr: git.stderr, stdout: git.stdout }).toEqual({ exitCode: 128, stderr: 'fatal: unable to access', stdout: '' });
  });

  it('cross as their message when the contract names no class for them', async () => {
    const { main, core } = pairWith();
    core.serve('scm.call', () => Promise.reject(new TypeError('boom')));
    const err = await main.request('scm.call', { method: 'refresh', args: ['repo-1'] }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe('boom');
  });

  it('are a violation when they name a class outside the contract or carry the wrong fields', async () => {
    const violations: CoreProtocolError[] = [];
    const transports = createLoopback();
    const main = createMainEndpoint(transports.main, quiet, (error) => violations.push(error));
    transports.core.onMessage((raw) => {
      const request = raw as { kind: string; id: number };
      if (request.kind !== 'request') return;
      const fault = request.id === 1 ? { name: 'ProcessExit', data: {} } : { name: 'StashKeptError', data: { outcome: 'exploded' } };
      transports.core.post({ kind: 'response', id: request.id, ok: false, error: 'x', fault });
    });
    await expect(main.request('scm.call', { method: 'refresh', args: [] })).rejects.toThrow(CoreProtocolError);
    await expect(main.request('scm.call', { method: 'refresh', args: [] })).rejects.toThrow(CoreProtocolError);
    expect(violations.map((violation) => violation.message)).toEqual(['Core protocol violation: error ProcessExit of scm.call', 'Core protocol violation: error StashKeptError of scm.call']);
  });
});

describe('a chat\'s activity and worktree state', () => {
  const activity = {
    state: 'requires_action',
    pendingKinds: ['approval'],
    pendingPrompts: [
      { id: 'toolu_1', kind: 'approval', owner: { kind: 'main' }, summary: { message: 'edit {0}', args: ['a.ts'] } },
      { id: 'toolu_2', kind: 'approval', owner: { kind: 'team', teamId: 't', agentId: 'a', agentName: 'Reviewer' } },
    ],
    background: false,
  };
  const worktree = {
    panelId: 'panel-1',
    projectPath: '/p',
    workingFolder: '/w',
    worktreeId: 'wt-1',
    busy: false,
    state: { phase: 'settingUp', place: 'worktree', canHandOff: false, sharedWith: 2, setupStep: { command: 'npm ci', index: 1, total: 2 } },
  };

  it('reach main with the fields main acts on', () => {
    const { main, transports } = pair();
    const received: unknown[] = [];
    main.onEvent('chat.activity', (payload) => received.push(payload));
    main.onEvent('chat.worktreeState', ({ event }) => received.push(event));
    transports.core.post({ kind: 'event', name: 'chat.activity', payload: { panelId: 'panel-1', activity: { ...activity, extra: 1 } } });
    transports.core.post({ kind: 'event', name: 'chat.worktreeState', payload: { event: worktree } });
    expect(received).toEqual([{ panelId: 'panel-1', activity }, worktree]);
  });

  it('are a violation when a field main acts on is malformed', () => {
    const { transports } = pair();
    const prompt = activity.pendingPrompts[0]!;
    expect(() => transports.core.post({ kind: 'event', name: 'chat.activity', payload: { panelId: 'p', activity: { ...activity, pendingPrompts: [{ ...prompt, id: 7 }] } } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.activity', payload: { panelId: 'p', activity: { ...activity, state: 'busy' } } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.worktreeState', payload: { event: { ...worktree, state: { ...worktree.state, phase: 'gone' } } } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.worktreeState', payload: { event: { ...worktree, busy: 'no' } } })).toThrow(CoreProtocolError);
  });
});

describe('core\'s text main renders', () => {
  const outcome = { kind: 'error', message: { message: 'The provider refused: {0}', args: ['overloaded'] } };
  const rateLimit = { kind: 'rateLimit', windowId: 'five_hour', windowLabel: { message: 'Session (5hr)' }, resetsAt: 1 };
  const crossing = { provider: 'anthropic', windowId: 'five_hour', windowLabel: { message: 'Weekly {0}', args: ['Opus'] }, threshold: 80, utilization: 81.5, planName: 'Max 20x' };

  it('reaches main as LocalizedText in a turn outcome and a usage crossing', () => {
    const { main, transports } = pair();
    const received: unknown[] = [];
    main.onEvent('chat.turnSettled', ({ outcome: settled }) => received.push(settled));
    main.onEvent('chat.usageThreshold', ({ crossing: crossed }) => received.push(crossed));
    for (const settled of [outcome, rateLimit, { kind: 'completed', durationMs: 5 }, { kind: 'cancelled' }]) transports.core.post({ kind: 'event', name: 'chat.turnSettled', payload: { panelId: 'p', outcome: settled } });
    transports.core.post({ kind: 'event', name: 'chat.usageThreshold', payload: { crossing } });
    expect(received).toEqual([outcome, rateLimit, { kind: 'completed', durationMs: 5 }, { kind: 'cancelled' }, crossing]);
  });

  it('is a violation at the parse when it is not LocalizedText', () => {
    const { transports } = pair();
    const settle = (settled: unknown) => (): void => transports.core.post({ kind: 'event', name: 'chat.turnSettled', payload: { panelId: 'p', outcome: settled } });
    expect(settle({ kind: 'error', message: 'The provider refused' })).toThrow(CoreProtocolError);
    expect(settle({ ...rateLimit, windowLabel: 'Session (5hr)' })).toThrow(CoreProtocolError);
    expect(settle({ kind: 'exploded' })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.usageThreshold', payload: { crossing: { ...crossing, windowLabel: 'Weekly' } } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.usageThreshold', payload: { crossing: { ...crossing, threshold: 50 } } })).toThrow(CoreProtocolError);
  });

  it('reaches main as LocalizedText in a catalog refusal, and a string there is a violation', async () => {
    const violations: CoreProtocolError[] = [];
    const { main, core } = pair((error) => violations.push(error));
    const refusal = { ok: false, reason: 'invalid', message: { message: 'A chat name is at most {0} characters.', args: [200] } };
    let answer: unknown = refusal;
    core.serve('catalog.rename', () => answer as never);
    expect(await main.request('catalog.rename', { sessionId: 's', name: 'n' })).toEqual(refusal);
    answer = { ok: true };
    expect(await main.request('catalog.rename', { sessionId: 's', name: 'n' })).toEqual({ ok: true });
    answer = { ok: false, reason: 'failed', message: 'disk full' };
    await expect(main.request('catalog.rename', { sessionId: 's', name: 'n' })).rejects.toThrow(CoreProtocolError);
    expect(violations).toHaveLength(1);
  });

  it('reaches main as LocalizedText in a commit\'s failure, and a string there is a violation', async () => {
    const violations: CoreProtocolError[] = [];
    const { main, core } = pair((error) => violations.push(error));
    const request = { repoId: 'r', message: 'm', variant: {}, saved: [] };
    const refusal = { ok: false, reason: 'failed', error: { message: 'Invalid branch name' } };
    let answer: unknown = refusal;
    core.serve('scm.commit', () => answer as never);
    expect(await main.request('scm.commit', request)).toEqual(refusal);
    answer = { ok: false, reason: 'nothingToCommit' };
    expect(await main.request('scm.commit', request)).toEqual({ ok: false, reason: 'nothingToCommit' });
    answer = { ok: true };
    expect(await main.request('scm.commit', request)).toEqual({ ok: true });
    answer = { ok: false, reason: 'failed', error: 'Invalid branch name' };
    await expect(main.request('scm.commit', request)).rejects.toThrow(CoreProtocolError);
    answer = { ok: false, reason: 'failed' };
    await expect(main.request('scm.commit', request)).rejects.toThrow(CoreProtocolError);
    answer = { ok: false, reason: 'exploded' };
    await expect(main.request('scm.commit', request)).rejects.toThrow(CoreProtocolError);
    expect(violations).toHaveLength(3);
  });
});

describe('the scm namespace', () => {
  it('refuses a method outside SCM_CALLS', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'request', id: 1, method: 'scm.call', params: { method: 'dispose', args: [] } })).toThrow(CoreProtocolError);
  });

  it('takes a repository\'s flags field by field, a remote operation only by its name', () => {
    const { transports } = pair();
    const flags = { kind: 'repositoryState', repoId: 'r', busy: true, running: 'push', lastRemote: { op: 'fetch', outcome: 'cancelled', stashKept: false, seq: 1 } };
    transports.core.post({ kind: 'mirror', topic: 'scm', version: 1, patch: flags });
    expect(() => transports.core.post({ kind: 'mirror', topic: 'scm', version: 2, patch: { ...flags, running: 'clone' } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'mirror', topic: 'scm', version: 2, patch: { ...flags, busy: 'yes' } })).toThrow(CoreProtocolError);
  });
});

describe('a message name', () => {
  it('is a violation when it names an inherited property or holds a character that could forge a log line', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'event', name: 'constructor', payload: {} })).toThrow(CoreProtocolError);
    expect(() => transports.main.post({ kind: 'mirror', topic: 'toString', version: 1, patch: {} })).toThrow(CoreProtocolError);
    expect(() => transports.main.post({ kind: 'panel', panelId: 'p', op: 'hasOwnProperty', payload: {} })).toThrow(CoreProtocolError);
    expect(() => transports.main.post({ kind: 'event', name: 'secrets.changed\n[core] forged', payload: { key: 'k' } })).toThrow(/malformed envelope/);
  });
});

describe('PanelCreate.parent', () => {
  const create = { kind: 'chat', title: 'Damocles', localResourceRoots: ['/r'] };

  it('carries a design chat\'s parent by its view id, and parses a create without one as before', () => {
    expect(CORE_TO_MAIN.panelOps.create({ ...create, parent: 'view-parent-1' })).toEqual({ ...create, parent: 'view-parent-1' });
    expect(CORE_TO_MAIN.panelOps.create(create)).toEqual(create);
  });

  it('refuses a parent that is not a view id', () => {
    expect(CORE_TO_MAIN.panelOps.create({ ...create, parent: 42 })).toBe(INVALID);
    expect(CORE_TO_MAIN.panelOps.create({ ...create, parent: '' })).toBe(INVALID);
  });
});
