import { describe, expect, it, vi } from 'vitest';
import { createEndpoint, CoreProtocolError } from '../endpoint';
import { createLoopback } from '../loopback';
import { CORE_TO_MAIN, MAIN_TO_CORE, MAX_KEY_CHARS, type CoreToMain, type MainToCore } from '../messages';
import { MAX_DESIGN_ID_CHARS } from '../../../shared/design-paths';
import { MAX_CHANGED_PATHS } from '../../../shared/design-render';
import { MAX_MARKUP_JSON_CHARS } from '../../../shared/design-markup';
import { MAX_READ_SPRITE_REF_CHARS, MAX_READ_SPRITES, MAX_RELAYED_THEME_PNG_BYTES, MAX_SHEET_REFS } from '../../../shared/themes/relay';
import { MAX_THEME_NAME_CHARS } from '../../../shared/themes/limits';
import type { ThemeHistoryChange } from '../../../shared/themes/changes';
import { MAX_PROJECT_KEY_CHARS, MAX_PROJECT_LOOKS } from '../../../shared/themes/project-looks';
import { arr, data, INVALID, obj, opt, str } from '../schema';
import { EDITOR_HARD_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { CLIENT_TO_WORKSPACE } from '../../workspace/messages';
import { GitError, gitErrorText, GitUntrustedError, RemoteCancelledError, StashKeptError, SyncBranchChangedError, SyncPushError } from '../../../core/scm/errors';
import { createCoreEndpoint, createMainEndpoint } from '..';
import { createHarness } from '../../../core/forge/__tests__/support/harness';

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
    for (const answer of [{ kind: 'written', mtimeMs: 1.5 }, { kind: 'changed' }, { kind: 'outside' }, { kind: 'notOwned' }, { kind: 'refused', reason: 'held' }, { kind: 'refused', reason: 'otherProcess' }]) {
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

describe('a Files listing', () => {
  const { result } = CLIENT_TO_WORKSPACE.requests['tree.list'];
  const via = { link: 'out', realRoot: '/srv/shared' };

  it('carries a link\'s own target and broken flag, and the link root the folder was reached through', () => {
    const entries = [{ name: 'out', kind: 'dir', link: { target: '/srv/shared' } }, { name: 'gone', kind: 'file', link: { target: '../gone', broken: true } }, { name: 'a.ts', kind: 'file' }];
    expect(result({ ok: true, entries, via })).toEqual({ ok: true, entries, via });
    expect(result({ ok: true, entries })).toEqual({ ok: true, entries });
  });

  it('refuses a link target holding a control character or longer than a path, a broken flag other than true and a via that is not a project path', () => {
    const entry = (link: unknown) => ({ ok: true, entries: [{ name: 'out', kind: 'file', link }] });
    expect(result(entry({ target: 'a\u001b[2Jb' }))).toBe(INVALID);
    expect(result(entry({ target: 'x'.repeat(32_768) }))).toBe(INVALID);
    expect(result(entry({ target: '/a', broken: false }))).toBe(INVALID);
    expect(result(entry({}))).toBe(INVALID);
    expect(result({ ok: true, entries: [], via: { link: '../up', realRoot: '/srv' } })).toBe(INVALID);
    expect(result({ ok: true, entries: [], via: { link: 'out', realRoot: '' } })).toBe(INVALID);
  });

  it('reads an older host\'s entries, which carry no link, as entries with no badge', () => {
    expect(result({ ok: true, entries: [{ name: 'out', kind: 'dir' }] })).toEqual({ ok: true, entries: [{ name: 'out', kind: 'dir' }] });
  });
});

describe('a project path\'s confinement and Files answers', () => {
  const via = { link: 'out', realRoot: '/srv/shared' };
  const drive = { message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] };

  it('carries a confine\'s via, refuses one that is no project path, and refuses oldDaemon, which only a client answers', () => {
    for (const method of ['files.confineExisting', 'files.confineMissing'] as const) {
      const { result } = CLIENT_TO_WORKSPACE.requests[method];
      expect(result({ ok: true, path: '/srv/shared/a.ts', via }), method).toEqual({ ok: true, path: '/srv/shared/a.ts', via });
      expect(result({ ok: true, path: '/srv/shared/a.ts', via: { link: '../up', realRoot: '/srv' } }), method).toBe(INVALID);
      expect(result({ ok: true, path: '/srv/shared/a.ts', via: { link: 'out' } }), method).toBe(INVALID);
      expect(result({ ok: false, reason: 'outside', refusal: 'share' }), method).toEqual({ ok: false, reason: 'outside', refusal: 'share' });
      expect(result({ ok: false, reason: 'outside', refusal: 'oldDaemon' }), method).toBe(INVALID);
    }
  });

  it('carries a failure\'s own words on every refusal that may fail, and refuses words that are no LocalizedText', () => {
    const failed = { ok: false, reason: 'failed', error: drive };
    for (const method of ['files.confineExisting', 'files.confineMissing', 'files.entry', 'tree.list', 'files.createEntry', 'files.renameEntry', 'files.deleteEntry', 'files.clashes', 'files.readFile', 'files.copy', 'files.move', 'files.removeFolder'] as const) {
      const { result } = CLIENT_TO_WORKSPACE.requests[method];
      expect(result(failed), method).toEqual(failed);
      expect(result({ ok: false, reason: 'failed', error: 'The drive Q:\\ did not answer.' }), method).toBe(INVALID);
      expect(result({ ok: false, reason: 'outside', refusal: 'oldDaemon' }), method).toBe(INVALID);
    }
  });

  it('carries sessionFile as an entry\'s and a transfer\'s reason', () => {
    for (const method of ['files.createEntry', 'files.renameEntry', 'files.deleteEntry', 'files.receiveFile', 'files.copy', 'files.move', 'files.makeFolder', 'files.makeLink', 'files.verifyLink', 'files.removeFolder'] as const) {
      expect(CLIENT_TO_WORKSPACE.requests[method].result({ ok: false, reason: 'sessionFile' }), method).toEqual({ ok: false, reason: 'sessionFile' });
    }
    expect(CLIENT_TO_WORKSPACE.requests['files.confineExisting'].result({ ok: false, reason: 'sessionFile' })).toBe(INVALID);
  });

  it('carries an entry\'s session store flag as true or nothing', () => {
    const { result } = CLIENT_TO_WORKSPACE.requests['files.entry'];
    const entry = { ok: true, path: '/srv/app/a', folder: true, identity: { dev: '1', ino: '2', birthtimeNs: '3' } };
    expect(result({ ...entry, sessionStore: true })).toEqual({ ...entry, sessionStore: true });
    expect(result(entry)).toEqual(entry);
    expect(result({ ...entry, sessionStore: false })).toBe(INVALID);
  });
});

describe('the theme history on the wire', () => {
  type Kind = ThemeHistoryChange['kind'];
  // One accepted and one refused value per change kind; a new kind does not compile until it has a row.
  const CHANGES: { readonly [K in Kind]: { readonly taken: Extract<ThemeHistoryChange, { kind: K }>; readonly refused: unknown } } = {
    pick: { taken: { kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles' }, refused: { kind: 'pick', look: 'dark', theme: 'Night', was: '' } },
    save: { taken: { kind: 'save', theme: 'Night', picked: ['dark', 'light'] }, refused: { kind: 'save', theme: 'Night', picked: ['dark', 'light', 'dark'] } },
    create: { taken: { kind: 'create', theme: 'Night' }, refused: { kind: 'create', theme: '' } },
    schedule: { taken: { kind: 'schedule', enabled: true, rules: 2, mode: 'dark' }, refused: { kind: 'schedule', enabled: true, rules: 1.5 } },
    hold: { taken: { kind: 'hold', theme: 'Night', look: 'light' }, refused: { kind: 'hold', theme: 'Night', look: 'auto' } },
    resume: { taken: { kind: 'resume' }, refused: { kind: 'Resume' } },
    rename: { taken: { kind: 'rename', theme: 'Night', was: 'Dusk' }, refused: { kind: 'rename', theme: 'x'.repeat(257), was: 'Dusk' } },
    delete: { taken: { kind: 'delete', theme: 'Night' }, refused: { kind: 'delete', theme: '' } },
    projectLook: { taken: { kind: 'projectLook', project: '', look: 'touches' }, refused: { kind: 'projectLook', project: 'app', look: 'some' } },
    projectPin: { taken: { kind: 'projectPin', project: 'app', theme: 'Arcade', character: null, everyTheme: true }, refused: { kind: 'projectPin', project: 'app', theme: 'Arcade', character: '' } },
    storeRemoved: { taken: { kind: 'storeRemoved', themes: ['Aurora'] }, refused: { kind: 'storeRemoved', themes: [''] } },
    wallpapersOff: { taken: { kind: 'wallpapersOff' }, refused: { kind: 'wallpapers-off' } },
    reset: { taken: { kind: 'reset' }, refused: { kind: 7 } },
    other: { taken: { kind: 'other' }, refused: { kind: 'teleport' } },
    restore: { taken: { kind: 'restore', before: { kind: 'other' } }, refused: { kind: 'restore', before: { kind: 'restore', before: { kind: 'reset' } } } },
  };
  const entries = MAIN_TO_CORE.requests['themes.history'].result;
  const entry = (change: unknown, more: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'e', at: 1, actor: { kind: 'user' }, change, ...more });

  it.each(Object.entries(CHANGES))('takes a %s change with the fields of its kind and refuses one without them', (_kind, { taken, refused }) => {
    expect(entries({ entries: [entry(taken)] })).toEqual({ entries: [entry(taken)] });
    expect(entries({ entries: [entry(refused)] })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['themes.undo'].result({ undone: taken })).toEqual({ undone: taken });
    // the entry an Undo names is optional, and an id when given
    expect(MAIN_TO_CORE.requests['themes.undo'].params({})).toEqual({});
    expect(MAIN_TO_CORE.requests['themes.undo'].params({ expected: 'e1' })).toEqual({ expected: 'e1' });
    expect(MAIN_TO_CORE.requests['themes.undo'].params({ expected: '' })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['themes.undo'].params({ expected: 'e'.repeat(129) })).toBe(INVALID);
    expect(CORE_TO_MAIN.requests['themes.pendingExtended'].params({ entryId: 'e', change: refused })).toBe(INVALID);
  });

  it('drops a field a change kind does not have', () => {
    expect(entries({ entries: [entry({ kind: 'reset', theme: 'x' })] })).toEqual({ entries: [entry({ kind: 'reset' })] });
  });

  it('takes an agent actor only with a chat id of 1 to 128 characters, and cannotUndo only as true', () => {
    const agent = (chatId: string): unknown => ({ entries: [{ ...entry({ kind: 'reset' }), actor: { kind: 'agent', chatId, title: '' } }] });
    expect(entries(agent('c'.repeat(128)))).not.toBe(INVALID);
    expect(entries(agent('c'.repeat(129)))).toBe(INVALID);
    expect(entries(agent(''))).toBe(INVALID);
    expect(entries({ entries: [entry({ kind: 'other' }, { cannotUndo: true })] })).toEqual({ entries: [entry({ kind: 'other' }, { cannotUndo: true })] });
    expect(entries({ entries: [entry({ kind: 'other' }, { cannotUndo: false })] })).toBe(INVALID);
  });

  it('carries the window arrangement a revert at core start put back, beside how the countdown ended', () => {
    const settled = CORE_TO_MAIN.requests['themes.pendingSettled'].params;
    expect(settled({ entryId: 'e', outcome: 'reverted', arrangement: { sidebarWidth: 300 } })).toEqual({ entryId: 'e', outcome: 'reverted', arrangement: { sidebarWidth: 300 } });
    expect(settled({ entryId: 'e', outcome: 'kept' })).toEqual({ entryId: 'e', outcome: 'kept' });
  });

  it("says when core's start ended the countdown, and when it left one another running Damocles counts", () => {
    const settled = CORE_TO_MAIN.requests['themes.pendingSettled'].params;
    expect(settled({ entryId: 'e', outcome: 'kept', atStart: true })).toEqual({ entryId: 'e', outcome: 'kept', atStart: true });
    expect(settled({ entryId: 'e', outcome: 'kept', atStart: 'yes' })).toBe(INVALID);
    const elsewhere = CORE_TO_MAIN.requests['themes.pendingElsewhere'].params;
    expect(elsewhere({ entryId: 'e' })).toEqual({ entryId: 'e' });
    expect(elsewhere({ entryId: '' })).toBe(INVALID);
  });

  it("asks main for an unnamed copy's name by the theme's id and stored name, and takes back a name only", () => {
    const { params, result } = CORE_TO_MAIN.requests['themes.copyName'];
    expect(params({ themeId: 'damocles-aurora', name: 'Aurora', extra: 1 })).toEqual({ themeId: 'damocles-aurora', name: 'Aurora' });
    for (const bad of [{ themeId: 'Aurora', name: 'Aurora' }, { themeId: 'damocles-aurora', name: '' }, { themeId: 'damocles-aurora' }, { name: 'Aurora' }]) expect(params(bad)).toBe(INVALID);
    expect(result({ name: 'Σέλας αντίγραφο' })).toEqual({ name: 'Σέλας αντίγραφο' });
    for (const bad of [{ name: '' }, { name: 7 }, {}]) expect(result(bad)).toBe(INVALID);
  });
});

describe('the theme requests main sends', () => {
  it('has no request that nothing sends', () => {
    expect(Object.keys(MAIN_TO_CORE.requests)).not.toContain('themes.save');
    expect(Object.keys(MAIN_TO_CORE.requests)).not.toContain('themes.schedule');
  });

  it('carries the schedule screen\'s rules alone, up to the number a schedule holds', () => {
    const params = MAIN_TO_CORE.requests['themes.setScheduleRules'].params;
    const rule = { days: ['mon'], minute: 420, theme: 'damocles', look: 'auto' };
    expect(params({ rules: [rule] })).toEqual({ rules: [rule] });
    expect(params({ rules: [] })).toEqual({ rules: [] });
    expect(params({ rules: Array.from({ length: 48 }, () => rule) })).not.toBe(INVALID);
    expect(params({ rules: Array.from({ length: 49 }, () => rule) })).toBe(INVALID);
    expect(params({ rules: [{ ...rule, minute: 1440 }] })).toBe(INVALID);
    expect(params({ schedule: { enabled: true, rules: [rule] } })).toBe(INVALID);
  });

  it('carries the hash of the file the editor opened with its save, and the save\'s answer: the new hash, or that the file moved', () => {
    const { params, result } = MAIN_TO_CORE.requests['themes.saveTheme'];
    const save = { themeId: 'damocles', theme: {} };
    const hash = 'a'.repeat(64);
    expect(params(save)).toEqual(save);
    expect(params({ ...save, baseHash: hash })).toEqual({ ...save, baseHash: hash });
    expect(params({ ...save, baseHash: 'abc' })).toBe(INVALID);
    expect(result({ hash })).toEqual({ hash });
    expect(result({ changed: true })).toEqual({ changed: true });
    expect(result({ changed: false })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['themes.baseHash'].params({ themeId: 'damocles' })).toEqual({ themeId: 'damocles' });
    expect(MAIN_TO_CORE.requests['themes.baseHash'].result({})).toEqual({});
    expect(MAIN_TO_CORE.requests['themes.baseHash'].result({ hash })).toEqual({ hash });
    expect(MAIN_TO_CORE.requests['themes.baseHash'].result({ hash: 'A'.repeat(64) })).toBe(INVALID);
  });

  it('carries the project looks up to the caps their reader keeps', () => {
    const looks = MAIN_TO_CORE.requests['themes.projectLooks'].result;
    const look = { mode: 'touches', accent: '#ff00aa' };
    const many = (count: number): Record<string, unknown> => Object.fromEntries(Array.from({ length: count }, (_, at) => [`c:/work/${at}`, look]));
    expect(looks({ looks: many(MAX_PROJECT_LOOKS) })).not.toBe(INVALID);
    expect(looks({ looks: many(MAX_PROJECT_LOOKS + 1) })).toBe(INVALID);
    expect(looks({ looks: { ['x'.repeat(MAX_PROJECT_KEY_CHARS)]: look } })).not.toBe(INVALID);
    expect(looks({ looks: { ['x'.repeat(MAX_PROJECT_KEY_CHARS + 1)]: look } })).toBe(INVALID);
  });

  it('takes a theme id only in the lowercase form every theme has', () => {
    const remove = MAIN_TO_CORE.requests['themes.delete'].params;
    expect(remove({ themeId: '0f8fad5b-d9cb-469f-a165-70867728950e' })).not.toBe(INVALID);
    expect(remove({ themeId: 'damocles-arcade' })).not.toBe(INVALID);
    for (const themeId of ['', 'New folder', 'Night', 'my_theme', '../x', 'x'.repeat(65)]) expect(remove({ themeId })).toBe(INVALID);
  });
});

describe("a remote chat's theme relay on the wire", () => {
  const DRAFT = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('takes about only as one of its seven words, which main logs, so no other text in that field reaches a log or the store', () => {
    const read = CORE_TO_MAIN.requests['user.theme.read'].params;
    for (const about of ['current', 'installed', 'theme', 'schedule', 'project', 'sprites', 'css']) expect(read({ clientId: 'c', request: { about }, chat: 's' })).toEqual({ clientId: 'c', request: { about }, chat: 's' });
    expect(read({ clientId: 'c', request: {}, chat: 's' })).toEqual({ clientId: 'c', request: {}, chat: 's' });
    expect(read({ clientId: 'c', request: {} })).toBe(INVALID);
    expect(read({ clientId: 'c', request: { about: 'x\ny' }, chat: 's' })).toBe(INVALID);
    expect(read({ clientId: 'c', request: { about: 'other' }, chat: 's' })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['themes.relay.read'].params({ authority: 'ssh+h1', request: { about: 'x\ny' }, chat: 's' })).toBe(INVALID);
  });

  it('carries a screenshot ask with its chat and an optional draft, and answers a shot, a draft to capture or a refusal', () => {
    const take = CORE_TO_MAIN.requests['user.theme.screenshotTake'];
    expect(take.params({ clientId: 'c', chat: { id: 's' }, draft: DRAFT })).toEqual({ clientId: 'c', chat: { id: 's' }, draft: DRAFT });
    // the device names the chat its notice shows from its own records, never by the remote core's word
    expect(take.params({ clientId: 'c', chat: { id: 's', title: 'Your bank chat' } })).toEqual({ clientId: 'c', chat: { id: 's' } });
    expect(take.params({ clientId: 'c' })).toBe(INVALID);
    const shot = { shotId: 'a', url: 'app://damocles/theme-shot/a', width: 10, height: 10 };
    expect(take.result({ kind: 'shot', shot, granted: true })).toEqual({ kind: 'shot', shot, granted: true });
    expect(take.result({ kind: 'refused', reason: 'windowHidden' })).toEqual({ kind: 'refused', reason: 'windowHidden' });
    expect(take.result({ kind: 'refused', reason: 'bored' })).toBe(INVALID);
    expect(take.result({ kind: 'draft', captureId: 'k', draft: { name: 'Warm', theme: { id: 'x' } } })).toEqual({ kind: 'draft', captureId: 'k', draft: { name: 'Warm', theme: { id: 'x' } } });
    const local = CORE_TO_MAIN.requests['themes.screenshotTake'];
    expect(local.params({ chat: { id: 's' }, theme: { id: 'x' }, granted: true })).toEqual({ chat: { id: 's' }, theme: { id: 'x' }, granted: true });
    expect(local.params({ chat: { id: 's' }, granted: false })).toBe(INVALID);
    expect(local.result({ kind: 'shot', shot })).toEqual({ kind: 'shot', shot });
    expect(local.result({ kind: 'draft', captureId: 'k' })).toBe(INVALID);
    const draft = MAIN_TO_CORE.requests['themes.relay.draftTheme'];
    expect(draft.params({ authority: 'ssh+h1', chat: 's', draft: DRAFT })).toEqual({ authority: 'ssh+h1', chat: 's', draft: DRAFT });
    expect(draft.result({ refused: 'Not this chat\'s draft.' })).toEqual({ refused: 'Not this chat\'s draft.' });
    expect(draft.result({ name: 'Draft', theme: { id: 'x' } })).toEqual({ name: 'Draft', theme: { id: 'x' } });
    expect(MAIN_TO_CORE.requests['themes.screenshotGrantRevoke'].params({ chat: 's' })).toEqual({ chat: 's' });
  });

  it("takes a draft only as a draft id wherever a remote core's request names one, so no other text in it reaches a log", () => {
    const forged = 'x\ny';
    expect(CORE_TO_MAIN.requests['user.theme.read'].params({ clientId: 'c', request: { about: 'theme', draft: forged }, chat: 's' })).toBe(INVALID);
    expect(CORE_TO_MAIN.requests['user.theme.screenshotTake'].params({ clientId: 'c', chat: { id: 's' }, draft: forged })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['themes.relay.read'].params({ authority: 'ssh+h1', request: { draft: forged }, chat: 's' })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['themes.relay.draftTheme'].params({ authority: 'ssh+h1', chat: 's', draft: forged })).toBe(INVALID);
    for (const draft of ['d1', DRAFT.toUpperCase(), `${DRAFT}x`]) expect(CORE_TO_MAIN.requests['user.theme.screenshotTake'].params({ clientId: 'c', chat: { id: 's' }, draft }), draft).toBe(INVALID);
  });

  it("answers a draft capture with a shot no grant cleared, or a refusal: never another draft, never a grant's shot", () => {
    const capture = CORE_TO_MAIN.requests['user.theme.screenshotCapture'];
    expect(capture.params({ clientId: 'c', captureId: 'k' })).toEqual({ clientId: 'c', captureId: 'k' });
    const shot = { shotId: 'a', url: 'app://damocles/theme-shot/a', width: 10, height: 10 };
    expect(capture.result({ kind: 'shot', shot, granted: false })).toEqual({ kind: 'shot', shot, granted: false });
    expect(capture.result({ kind: 'refused', reason: 'windowHidden' })).toEqual({ kind: 'refused', reason: 'windowHidden' });
    expect(capture.result({ kind: 'shot', shot, granted: true })).toBe(INVALID);
    expect(capture.result({ kind: 'shot', shot })).toBe(INVALID);
    expect(capture.result({ kind: 'draft', captureId: 'k', draft: { name: 'Warm', theme: { id: 'x' } } })).toBe(INVALID);
  });

  it("drops a remote core's granted on a screenshot ask: this computer's record decides the grant", () => {
    const take = CORE_TO_MAIN.requests['user.theme.screenshotTake'].params;
    expect(take({ clientId: 'c', chat: { id: 's' }, granted: true })).toEqual({ clientId: 'c', chat: { id: 's' } });
  });

  it('refuses a relayed shot answer without granted', () => {
    const shot = { shotId: 'a', url: 'app://damocles/theme-shot/a', width: 10, height: 10 };
    expect(CORE_TO_MAIN.requests['user.theme.screenshotTake'].result({ kind: 'shot', shot })).toBe(INVALID);
    expect(CORE_TO_MAIN.requests['user.theme.screenshotTake'].result({ kind: 'shot', shot, granted: 'yes' })).toBe(INVALID);
  });

  it('bounds the sprites, the region and the draft a ThemeRead names', () => {
    const read = (request: Record<string, unknown>): unknown => CORE_TO_MAIN.requests['user.theme.read'].params({ clientId: 'c', request, chat: 's' });
    expect(read({ about: 'sprites', draft: DRAFT, sprites: Array.from({ length: MAX_READ_SPRITES }, () => 'x'.repeat(MAX_READ_SPRITE_REF_CHARS)) })).not.toBe(INVALID);
    expect(read({ about: 'sprites', theme: 't', sprites: Array.from({ length: MAX_READ_SPRITES + 1 }, () => 'x') })).toBe(INVALID);
    expect(read({ about: 'sprites', theme: 't', sprites: ['x'.repeat(MAX_READ_SPRITE_REF_CHARS + 1)] })).toBe(INVALID);
    expect(read({ about: 'sprites', theme: 't', sprites: [] })).toBe(INVALID);
    expect(read({ about: 'sprites', theme: 't', sprites: [''] })).toBe(INVALID);
    expect(read({ about: 'css', theme: 't', region: 'sidebar' })).not.toBe(INVALID);
    expect(read({ about: 'css', theme: 't', region: 'everywhere' })).toBe(INVALID);
    expect(read({ about: 'theme', draft: '' })).toBe(INVALID);
  });

  it('parses the theme card requests and the project character of this computer\'s core', () => {
    const opened = CORE_TO_MAIN.requests['themes.cardOpened'].params;
    expect(opened({ stageId: 's', theme: { id: 'x' } })).toEqual({ stageId: 's', theme: { id: 'x' } });
    expect(opened({ stageId: '', theme: { id: 'x' } })).toBe(INVALID);
    expect(opened({ theme: { id: 'x' } })).toBe(INVALID);
    const closed = CORE_TO_MAIN.requests['themes.cardClosed'].params;
    expect(closed({ stageId: 's', extra: 1 })).toEqual({ stageId: 's' });
    expect(closed({})).toBe(INVALID);
    const character = CORE_TO_MAIN.requests['themes.projectCharacter'];
    expect(character.params({ key: 'a' })).toEqual({ key: 'a' });
    expect(character.params({})).toBe(INVALID);
    expect(character.result({})).toEqual({});
    const name = 'n'.repeat(MAX_THEME_NAME_CHARS);
    expect(character.result({ character: { themeId: 'damocles-arcade', name, by: 'themePin' } })).toEqual({ character: { themeId: 'damocles-arcade', name, by: 'themePin' } });
    expect(character.result({ character: { themeId: 'damocles-arcade', name: `${name}n`, by: 'themePin' } })).toBe(INVALID);
    expect(character.result({ character: { themeId: 'Arcade', name: 'Pip', by: 'themePin' } })).toBe(INVALID);
    expect(character.result({ character: { themeId: 'damocles-arcade', name: 'Pip', by: 'guess' } })).toBe(INVALID);
  });

  it('bounds a screenshot answer at 16 MiB', () => {
    const shot = CORE_TO_MAIN.requests['user.theme.screenshot'].result;
    expect(shot({ png: new Uint8Array(MAX_RELAYED_THEME_PNG_BYTES) })).not.toBe(INVALID);
    expect(shot({ png: new Uint8Array(MAX_RELAYED_THEME_PNG_BYTES + 1) })).toBe(INVALID);
  });

  it("carries pressed only from main to its own core, as a boolean; a remote core's commit has no such field", () => {
    expect(CORE_TO_MAIN.requests['user.theme.commit'].params({ clientId: 'c', stageId: 's', pressed: true })).toEqual({ clientId: 'c', stageId: 's' });
    expect(CORE_TO_MAIN.requests['user.theme.installCommit'].params({ clientId: 'c', installId: 'i', useArrangement: false, chat: { id: 's' }, pressed: true })).toEqual({ clientId: 'c', installId: 'i', useArrangement: false, chat: { id: 's' } });
    const commit = MAIN_TO_CORE.requests['themes.relay.commit'].params;
    expect(commit({ authority: 'ssh+h1', stageId: 's', pressed: false })).toEqual({ authority: 'ssh+h1', stageId: 's', pressed: false });
    expect(commit({ authority: 'ssh+h1', stageId: 's' })).toEqual({ authority: 'ssh+h1', stageId: 's' });
    expect(commit({ authority: 'ssh+h1', stageId: 's', pressed: 1 })).toBe(INVALID);
    expect(commit({ authority: 'ssh+h1', stageId: 's', pressed: 'true' })).toBe(INVALID);
  });

  it('takes a ThemeRead theme id only as the tool sends it: never empty, at most 64 characters', () => {
    const read = CORE_TO_MAIN.requests['user.theme.read'].params;
    expect(read({ clientId: 'c', request: { about: 'theme', theme: 'x'.repeat(64) }, chat: 's' })).not.toBe(INVALID);
    expect(read({ clientId: 'c', request: { about: 'theme', theme: '' }, chat: 's' })).toBe(INVALID);
    expect(read({ clientId: 'c', request: { about: 'theme', theme: 'x'.repeat(65) }, chat: 's' })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['themes.relay.read'].params({ authority: 'ssh+h1', request: { theme: '' }, chat: 's' })).toBe(INVALID);
    expect(read({ clientId: 'c', request: { about: 'theme', draft: '0f8fad5b-d9cb-469f-a165-70867728950e' }, chat: 's' })).not.toBe(INVALID);
  });

  it("bounds a remote chat's id as the history actor it becomes, where the remote core's request arrives", () => {
    const stage = { tool: 'set', input: {}, toolCallId: 't', planMode: false };
    const install = { installId: 'i', useArrangement: false };
    for (const [length, taken] of [[128, true], [129, false]] as const) {
      const chat = { id: 'c'.repeat(length) };
      const answers = [
        CORE_TO_MAIN.requests['user.theme.stage'].params({ clientId: 'c', ...stage, chat }),
        CORE_TO_MAIN.requests['user.theme.installCommit'].params({ clientId: 'c', ...install, chat }),
        MAIN_TO_CORE.requests['themes.relay.stage'].params({ authority: 'ssh+h1', request: { ...stage, chat } }),
        MAIN_TO_CORE.requests['themes.relay.installCommit'].params({ authority: 'ssh+h1', ...install, chat }),
      ];
      for (const answer of answers) expect(answer !== INVALID).toBe(taken);
    }
  });

  it("bounds a card's prompt id alike on every request that names it", () => {
    for (const [length, taken] of [[128, true], [129, false]] as const) {
      const promptId = 'p'.repeat(length);
      const answers = [
        CORE_TO_MAIN.requests['user.theme.preview'].params({ clientId: 'c', stageId: 's', promptId, on: true }),
        MAIN_TO_CORE.requests['themes.relay.preview'].params({ authority: 'ssh+h1', stageId: 's', promptId, on: true }),
        MAIN_TO_CORE.requests['user.theme.showEnded'].params({ stageId: 's', promptId, reason: 'stopped' }),
        CORE_TO_MAIN.requests['themes.showInWindow'].params({ promptId, theme: {} }),
        CORE_TO_MAIN.requests['themes.stopShowing'].params({ promptId }),
        MAIN_TO_CORE.requests['themes.showEnded'].params({ promptId, reason: 'stopped' }),
      ];
      for (const answer of answers) expect(answer !== INVALID).toBe(taken);
    }
  });

  it('carries the expiry of a staged install from this core to main, and from main to the remote core that staged it', () => {
    expect(CORE_TO_MAIN.events['themes.install.expired']({ installId: 'i' })).toEqual({ installId: 'i' });
    expect(CORE_TO_MAIN.events['themes.install.expired']({})).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['user.theme.installExpired'].params({ installId: 'i' })).toEqual({ installId: 'i' });
    expect(MAIN_TO_CORE.requests['user.theme.installExpired'].params({ installId: '' })).toBe(INVALID);
  });

  it('takes a drawn preview as a view of window or sidebar with an optional look, on themes.render and on a relayed read', () => {
    const render = CORE_TO_MAIN.requests['themes.render'].params;
    expect(render({ theme: {}, view: 'sidebar', look: 'light' })).toEqual({ theme: {}, view: 'sidebar', look: 'light' });
    expect(render({ theme: {}, view: 'window' })).toEqual({ theme: {}, view: 'window' });
    for (const bad of [{ theme: {}, mode: 'dark' }, { theme: {}, view: 'split' }, { theme: {}, view: 'window', look: 'auto' }]) expect(render(bad)).toBe(INVALID);
    const read = CORE_TO_MAIN.requests['user.theme.read'].params;
    const sheet = { clientId: 'c', chat: 's', request: { preview: 'characters', sheetCharacters: ['Pip', '3'] } };
    expect(read(sheet)).toEqual(sheet);
    expect(read({ ...sheet, request: { preview: 'characters', sheetCharacters: [] } })).toBe(INVALID);
    expect(read({ ...sheet, request: { preview: 'characters', sheetCharacters: Array.from({ length: MAX_SHEET_REFS + 1 }, (_, at) => String(at)) } })).toBe(INVALID);
    expect(read({ clientId: 'c', chat: 's', request: { about: 'current', preview: 'window', look: 'dark' } })).toEqual({ clientId: 'c', chat: 's', request: { about: 'current', preview: 'window', look: 'dark' } });
    expect(read({ clientId: 'c', chat: 's', request: { preview: true } })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['themes.relay.read'].params({ authority: 'ssh+h1', chat: 's', request: { preview: 'sidebar' } })).toEqual({ authority: 'ssh+h1', chat: 's', request: { preview: 'sidebar' } });
  });

  it("takes a character sheet's characters by index in the set, and answers its pages with what they show", () => {
    const render = CORE_TO_MAIN.requests['themes.render'];
    expect(render.params({ theme: {}, view: 'characters', characters: [4, 0] })).toEqual({ theme: {}, view: 'characters', characters: [4, 0] });
    for (const characters of [[], [-1], [256], ['Pip'], Array.from({ length: MAX_SHEET_REFS + 1 }, (_, at) => at)]) expect(render.params({ theme: {}, view: 'characters', characters })).toBe(INVALID);
    const png = new Uint8Array([1, 2, 3]);
    const facts = { sheets: [[0, 1]], omitted: [2], unfit: [3], undrawn: [], stills: [{ character: 1, state: 'idle' }], clipped: [{ character: 0, state: 'running', shown: 48, frames: 60 }], selection: 'outline', wallpaper: true };
    expect(render.result({ pngs: [png], sheet: facts })).toEqual({ pngs: [png], sheet: facts });
    expect(render.result({ pngs: [] })).toEqual({ pngs: [] });
    expect(render.result({ pngs: [png, png, png, png, png] })).toBe(INVALID);
    expect(render.result({ pngs: [png], sheet: { ...facts, stills: [{ character: 1, state: 'asleep' }] } })).toBe(INVALID);
    expect(render.result({ pngs: [png], sheet: { ...facts, unfit: [256] } })).toBe(INVALID);
    const { unfit: _unfit, ...withoutUnfit } = facts;
    expect(render.result({ pngs: [png], sheet: withoutUnfit })).toBe(INVALID);
  });

  it('takes keepDraft on a discard only as a boolean, and a discard without it', () => {
    const fromHost = CORE_TO_MAIN.requests['user.theme.discard'].params;
    const toCore = MAIN_TO_CORE.requests['themes.relay.discard'].params;
    expect(fromHost({ clientId: 'c', stageId: 's' })).toEqual({ clientId: 'c', stageId: 's' });
    expect(fromHost({ clientId: 'c', stageId: 's', keepDraft: true })).toEqual({ clientId: 'c', stageId: 's', keepDraft: true });
    expect(fromHost({ clientId: 'c', stageId: 's', keepDraft: 'yes' })).toBe(INVALID);
    expect(toCore({ authority: 'ssh+h1', stageId: 's', keepDraft: true })).toEqual({ authority: 'ssh+h1', stageId: 's', keepDraft: true });
    expect(toCore({ authority: 'ssh+h1', stageId: 's', keepDraft: 1 })).toBe(INVALID);
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
    // an older main parses design.info, so only design.previewAnswer may say a page is missing
    expect(info({ missing: true })).toBe(INVALID);
    expect(info(undefined)).toBeUndefined();
    const answer = MAIN_TO_CORE.requests['design.previewAnswer'].result;
    expect(answer(facts)).not.toBe(INVALID);
    expect(answer({ missing: true })).toEqual({ missing: true });
    expect(answer({ missing: false })).toBe(INVALID);
    expect(answer(undefined)).toBeUndefined();
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

  it('takes design.previewScreen with a file path, answering opened or a localized refusal', () => {
    const preview = MAIN_TO_CORE.requests['design.previewScreen'];
    expect(preview.params({ path: '/home/a/.damocles/designs/d/screens/S1.html' })).toEqual({ path: '/home/a/.damocles/designs/d/screens/S1.html' });
    expect(preview.params({ path: '' })).toBe(INVALID);
    expect(preview.params({})).toBe(INVALID);
    expect(preview.result({ opened: true })).toEqual({ opened: true });
    expect(preview.result({ opened: false })).toBe(INVALID);
    expect(preview.result({ refused: { message: '{0} is not a screen of a design.', args: ['S1.html'] } })).toEqual({ refused: { message: '{0} is not a screen of a design.', args: ['S1.html'] } });
    expect(preview.result({ refused: 'plain text' })).toBe(INVALID);
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
    main.serve('shell.revealPath', () => Promise.reject(new Error('ENOENT: no such file')));
    await expect(core.request('shell.revealPath', { path: '/x' })).rejects.toThrow('ENOENT: no such file');
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
      new SyncPushError(new GitError('git push exited with 1', 1, 'ignored', ' ! [remote rejected] main -> main (protected branch hook declined)')),
    ];
    let next = 0;
    core.serve('scm.call', () => Promise.reject(errors[next++]));
    const rebuilt: unknown[] = [];
    for (let i = 0; i < errors.length; i++) rebuilt.push(await main.request('scm.call', { method: 'fetch', args: ['repo-1', {}] }).catch((err: unknown) => err));
    const [stash, sync, cancelled, untrusted, git, syncPush] = rebuilt as [StashKeptError, SyncBranchChangedError, Error, Error, GitError, SyncPushError];
    expect(syncPush).toBeInstanceOf(SyncPushError);
    expect(syncPush.cause).toBeInstanceOf(GitError);
    expect({ message: syncPush.cause.message, exitCode: syncPush.cause.exitCode, stderr: syncPush.cause.stderr }).toEqual({ message: 'git push exited with 1', exitCode: 1, stderr: ' ! [remote rejected] main -> main (protected branch hook declined)' });
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

describe('CI messages', () => {
  const repo = { authorityKey: 'local', project: 'damocles', endpoints: [], branch: 'feature/forge-accounts', sha: 'a'.repeat(40) };
  const job = { id: 9203, name: 'unit', stage: 'test', state: 'running', kind: 'job', canRetry: false, canCancel: true, hasLog: true, runner: 'shared-03' };

  it('parses a watch, a job action and a commit status call, and refuses a sha or target past their shapes', () => {
    const watch = MAIN_TO_CORE.requests['forge.ci.watch'].params;
    expect(watch({ id: 'status:r1', repo, active: true })).not.toBe(INVALID);
    expect(watch({ id: 'status:r1', active: false })).not.toBe(INVALID);
    expect(watch({ id: 'status:r1', repo: { ...repo, sha: 'HEAD' }, active: true })).toBe(INVALID);
    const action = MAIN_TO_CORE.requests['forge.ci.jobAction'].params;
    expect(action({ repo, target: { jobId: 9203 }, action: 'retry' })).not.toBe(INVALID);
    expect(action({ repo, target: { pipelineId: 54312 }, action: 'cancel' })).not.toBe(INVALID);
    expect(action({ repo, target: { jobId: 0 }, action: 'retry' })).toBe(INVALID);
    expect(action({ repo, target: { url: 'https://evil.test' }, action: 'retry' })).toBe(INVALID);
    expect(action({ repo, target: { jobId: 1 }, action: 'play' })).toBe(INVALID);
    expect(action({ repo, target: { runId: 64312 }, action: 'retry' })).not.toBe(INVALID);
    const page = MAIN_TO_CORE.requests['forge.ci.webUrl'].params;
    expect(page({ repo, target: { sha: 'c'.repeat(40) } })).not.toBe(INVALID);
    expect(page({ repo, target: { sha: 'HEAD' } })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['forge.ci.commitStatus'].params({ repo, sha: 'b'.repeat(64), retry: false })).not.toBe(INVALID);
  });

  it('parses GitHub checks: no pipeline id, runs by stage, a run per job, allowed failures and a cut list', () => {
    const status = MAIN_TO_CORE.requests['forge.ci.watch'].result;
    const checks = {
      serverId: 'github.com',
      serverName: 'github.com',
      kind: 'github',
      id: 0,
      number: 0,
      state: 'failed',
      jobsDone: 2,
      jobsTotal: 2,
      failedCount: 1,
      canRetry: false,
      canCancel: false,
      jobs: [{ ...job, state: 'failed', runId: 64312, allowedFailure: true }, { ...job, id: 9601, stage: '', kind: 'external', hasLog: false, canCancel: false }],
      runs: [{ id: 64312, stage: 'test', canRetry: true, canCancel: false }],
      truncated: true,
    };
    expect(status({ status: 'ready', pipeline: checks })).not.toBe(INVALID);
    expect(status({ status: 'ready', pipeline: { ...checks, runs: [{ id: 0, stage: 'test', canRetry: true, canCancel: false }] } })).toBe(INVALID);
    const commit = MAIN_TO_CORE.requests['forge.ci.commitStatus'].result;
    expect(commit({ status: 'ready', pipeline: { id: 0, number: 0, state: 'failed', serverName: 'github.com', kind: 'github' } })).not.toBe(INVALID);
    expect(commit({ status: 'ready', pipeline: { id: 0, number: 0, state: 'failed', serverName: 'github.com' } })).toBe(INVALID);
  });

  it('parses the views core answers and pushes, with error text as LocalizedText', () => {
    const status = MAIN_TO_CORE.requests['forge.ci.watch'].result;
    const pipeline = { serverId: 'gitlab.com', serverName: 'gitlab.com', kind: 'gitlab', id: 54312, number: 4312, state: 'running', jobsDone: 3, jobsTotal: 5, failedCount: 0, canRetry: false, canCancel: true, jobs: [job] };
    expect(status({ status: 'ready', pipeline })).not.toBe(INVALID);
    expect(status(null)).toBeNull();
    expect(status({ status: 'error', message: { message: '{0} could not answer.', args: ['gitlab.com'] } })).not.toBe(INVALID);
    expect(status({ status: 'error', message: 'plain text' })).toBe(INVALID);
    expect(status({ status: 'ready', pipeline: { ...pipeline, state: 'exploded' } })).toBe(INVALID);
    const changed = CORE_TO_MAIN.events['forge.ci.changed'];
    const log = { status: 'ready', job, pipeline: { id: 54312, number: 4312, ref: 'feature/forge-accounts' }, serverName: 'gitlab.com', kind: 'gitlab', reset: false, text: 'line\n', truncated: false, live: true };
    expect(changed({ id: 'log:t1', log })).not.toBe(INVALID);
    expect(changed({ id: 'log:t1', log: { status: 'githubRunning', job: { ...job, steps: [{ number: 1, name: 'Set up job', state: 'passed' }] }, serverName: 'github.com' } })).not.toBe(INVALID);
    expect(changed({ id: 'status:r1', status: { status: 'none' } })).not.toBe(INVALID);
    expect(changed({ id: 'log:t1', log: { ...log, text: 'x'.repeat(16 * 1024 * 1024 + 1) } })).toBe(INVALID);
  });
});

describe('forge messages', () => {
  const remote = (index: number) => ({ remote: `remote-${index}`, fetch: { protocol: 'https', host: 'gitlab.com', path: `grp/proj-${index}.git`, aliasResolved: false } });

  it('carry a repository with 100 remotes on every call that names its endpoints', () => {
    const endpoints = Array.from({ length: 100 }, (_, index) => remote(index));
    const repo = { authorityKey: 'local', project: 'damocles', endpoints };
    expect(MAIN_TO_CORE.requests['forge.ci.watch'].params({ id: 'status:r1', repo, active: true })).not.toBe(INVALID);
    expect(MAIN_TO_CORE.requests['forge.repoAccounts'].params({ projectKey: 'c:/src/damocles', ...repo })).not.toBe(INVALID);
    expect(MAIN_TO_CORE.requests['forge.prepareGitOperation'].params({ operation: 'push', ...repo, remotes: endpoints.map((item) => item.remote) })).not.toBe(INVALID);
    expect(MAIN_TO_CORE.requests['forge.pushAccess'].params({ repo, remote: 'remote-0' })).not.toBe(INVALID);
    const request = { tool: 'ForgeIssue', input: {}, ...repo };
    expect(MAIN_TO_CORE.requests['user.forge.tool'].params({ request, toolCallId: 'call-1' })).not.toBe(INVALID);
    expect(CORE_TO_MAIN.requests['user.forge.tool'].params({ clientId: 'c1', toolCallId: 'call-1', folder: '/src/damocles', endpoints, tool: 'ForgeIssue', input: {} })).not.toBe(INVALID);
  });

  it('carry a server of the account chip with its account exactly when its state settled one', () => {
    const result = MAIN_TO_CORE.requests['forge.repoAccounts'].result;
    const account = { id: 'gitlab.com|1', login: 'alexios-s', needsSignIn: false };
    const facts = { serverId: 'gitlab.com', server: 'gitlab.com', kind: 'gitlab', remotes: ['origin'], isPush: true, repoPath: 'alexios-s/damocles', accounts: [account] };
    const view = (server: Record<string, unknown>) => ({ projectKey: 'c:/src/damocles', project: 'damocles', servers: [{ ...facts, ...server }] });
    expect(result(view({ state: 'auto', how: 'onlyAccount', account }))).toEqual(view({ state: 'auto', how: 'onlyAccount', account }));
    expect(result(view({ state: 'chosen', how: 'bound' }))).toBe(INVALID);
    expect(result(view({ state: 'ownCredentials', how: 'bound', account }))).toEqual(view({ state: 'ownCredentials' }));
  });

  it("carry a decided target's fork and the hash of its card's text, and refuse a hash that is no SHA-256", () => {
    const expected = { serverId: 'gitlab.com', repoPath: 'grp/app', accountId: 'gitlab.com|2001', sourceRepoPath: 'me/app', contentHash: 'a'.repeat(64) };
    const call = { clientId: 'c1', toolCallId: 'call-1', folder: '/src/app', endpoints: [remote(0)], tool: 'ForgeComment', input: {} };
    expect(CORE_TO_MAIN.requests['user.forge.tool'].params({ ...call, expected })).toEqual({ ...call, expected });
    expect(CORE_TO_MAIN.requests['user.forge.tool'].params({ ...call, expected: { ...expected, contentHash: 'not-a-hash' } })).toBe(INVALID);
  });

  it('carry the mirror of a forge service with a signed-in account and a server at its most git hosts', async () => {
    const harness = await createHarness();
    try {
      const service = harness.service();
      await service.load();
      const gitHosts = Array.from({ length: 15 }, (_, index) => `git${index}.indigital.gr`);
      expect((await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts })).ok).toBe(true);
      await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
      const mirror = service.mirror();
      expect(mirror.servers.find((server) => server.gitHosts.length === 16)).toBeDefined();
      expect(mirror.servers.some((server) => server.hasAccount)).toBe(true);
      expect(CORE_TO_MAIN.mirrors.forge(mirror)).toEqual(mirror);
    } finally {
      await harness.close();
    }
  });

  it('answer a git credential request with a credential, delegation or a refusal, and refuse a refusal without text', () => {
    const answer = MAIN_TO_CORE.requests['forge.gitCredential'].result;
    expect(answer({ answer: { kind: 'credential', username: 'oauth2', password: 'gl-token' }, account: { serverId: 'gitlab.com', accountId: 'gitlab.com|7', login: 'work-alexios', how: 'bound' } })).not.toBe(INVALID);
    expect(answer({ answer: { kind: 'delegate' } })).toEqual({ answer: { kind: 'delegate' } });
    expect(answer({ answer: { kind: 'refused', message: 'Turn on "Agent shells may use this account" for work-alexios.' } })).not.toBe(INVALID);
    expect(answer({ answer: { kind: 'refused', message: '' } })).toBe(INVALID);
    expect(answer({ answer: { kind: 'credential', username: 'oauth2', password: 'gl-token' }, account: { serverId: 'gitlab.com', accountId: 'gitlab.com|7', login: 'work-alexios', how: 'guessed' } })).toBe(INVALID);
    // a target's automatic pick: the account to consent to, and no answer for git beside it
    const consent = { serverId: 'gitlab.com', accountId: 'gitlab.com|7', login: 'work-alexios', how: 'access', canPush: false };
    expect(answer({ consent })).toEqual({ consent });
    expect(answer({ consent: { ...consent, canPush: 'no' } })).toBe(INVALID);
    const params = MAIN_TO_CORE.requests['forge.gitCredential'].params;
    const request = { op: 'get', cwd: '/src/damocles', fields: { protocol: 'https', host: 'gitlab.com', path: 'grp/proj.git' } };
    expect(params({ request, origin: { kind: 'terminal', projectKey: '/src/damocles' }, authorityKey: 'local' })).not.toBe(INVALID);
    expect(params({ request, origin: { kind: 'terminal' }, authorityKey: 'ssh+h1', consentedAccountId: 'gitlab.com|7' })).toMatchObject({ consentedAccountId: 'gitlab.com|7' });
    expect(params({ request: { ...request, op: 'approve' }, origin: { kind: 'terminal' }, authorityKey: 'local' })).toBe(INVALID);
    const relayed = CORE_TO_MAIN.requests['askpass.credential'].result;
    expect(relayed({ kind: 'delegate' })).toEqual({ kind: 'delegate' });
    expect(relayed({ kind: 'refused', message: 'No account was chosen for gitlab.com, so git got no credentials.' })).not.toBe(INVALID);
  });
});
describe('the community store view', () => {
  const view = MAIN_TO_CORE.requests['themes.store.list'].result;
  const seeds = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
  const entry = {
    id: 'aurora', name: 'Aurora', author: 'Ada', description: '', kinds: ['dark'], version: '1.1.0', colors: { dark: seeds }, fonts: [{ family: 'Inter', license: 'OFL-1.1' }], licenses: ['CC0-1.0'],
    hasCss: false, hasLayout: false, hasCharacters: false, hasMoving: false, minAppVersion: '3.8.0', thumbnails: { dark: [{ panel: 'chat', sha256: 'c'.repeat(64) }] },
    status: 'update', installedThemeId: 'theme-1', installedVersion: '1.0.0',
  };
  const listed = { state: 'cached', fetchedAt: 5, refusedReason: { message: 'GitHub answered HTTP {0}.', args: ['503'] }, entries: [entry] };

  it('is parsed entry by entry, and a field main does not know is dropped', () => {
    expect(view(listed)).toEqual(listed);
    expect(view({ state: 'off', entries: [] })).toEqual({ state: 'off', entries: [] });
    expect(view({ ...listed, extra: 1, entries: [{ ...entry, extra: '<img>' }] })).toEqual(listed);
    expect(CORE_TO_MAIN.events['themes.store.updated']({ view: listed, listRead: false })).toEqual({ view: listed, listRead: false });
    expect(CORE_TO_MAIN.events['themes.store.updated']({ view: listed, listRead: 'yes' })).toBe(INVALID);
  });

  it.each([
    ['a state it does not have', { ...listed, state: 'stale' }],
    ['a reason that is not a text', { ...listed, refusedReason: 'plain' }],
    ['an entry id that is no entry id', { ...listed, entries: [{ ...entry, id: '../x' }] }],
    ['a name past its limit', { ...listed, entries: [{ ...entry, name: 'n'.repeat(129) }] }],
    ['a description past its limit', { ...listed, entries: [{ ...entry, description: 'd'.repeat(2001) }] }],
    ['a kind that is no look', { ...listed, entries: [{ ...entry, kinds: ['sepia'] }] }],
    ['a color that is not #rrggbb', { ...listed, entries: [{ ...entry, colors: { dark: { ...seeds, accent: 'url(x)' } } }] }],
    ['a thumbnail whose sha256 is not one', { ...listed, entries: [{ ...entry, thumbnails: { dark: [{ panel: 'chat', sha256: '../../x' }] } }] }],
    ['a thumbnail on a panel the app does not have', { ...listed, entries: [{ ...entry, thumbnails: { dark: [{ panel: 'span', sha256: 'c'.repeat(64) }] } }] }],
    ['a flag that is not a boolean', { ...listed, entries: [{ ...entry, hasCss: 'yes' }] }],
    ['a status it does not have', { ...listed, entries: [{ ...entry, status: 'pending' }] }],
    ['more entries than a list holds', { ...listed, entries: Array.from({ length: 2001 }, () => entry) }],
  ])('is refused with %s', (_name, raw) => {
    expect(view(raw)).toBe(INVALID);
  });
});
