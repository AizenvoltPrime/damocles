import { describe, expect, it } from 'vitest';
import { MAX_PATH_CHARS } from '../../core-protocol/messages';
import { MAX_RUN_TITLE_CHARS, MAX_TERMINAL_IDLE_DAYS } from '../../daemon/control-messages';
import { INVALID } from '../../core-protocol/schema';
import {
  MAX_KEPT_SHELL_SEQUENCE_CHARS,
  MAX_KEPT_SHELL_SEQUENCES,
  MAX_SHELL_SEQUENCE_CHARS,
  MAX_TERMINAL_ACK_CHARS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ID_LENGTH,
  MAX_TERMINAL_INPUT_CHARS,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_SCREEN_CHARS,
  MAX_TERMINAL_SCREEN_MARKS,
} from '../../preload/terminal-channels';
import { MAX_HOST_MESSAGE_CHARS, MAX_HOST_PROCESS_NAME_CHARS, MAX_SCREEN_SCROLLBACK, parseTerminalView, TERMINAL_BATCH_CHARS } from '../../pty-host/protocol';
import { WORKSPACE_MAX_MESSAGE_BYTES } from '../../workspace/messages';
import * as contract from '../host-messages';

const SPAWN: contract.TerminalHostSpawn = { id: 'term-1', file: '/bin/sh', args: ['-l'], cwd: '/', env: { PATH: '/bin' }, cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '', endpoints: { cli: true, relay: false } };

describe('the terminal host contract', () => {
  // Every value both ends parse with, as it was frozen. A host built with these lives on under every later daemon, so none
  // of them ever changes: a failure here means the edit must be undone, never that this table follows it.
  it('keeps every frozen value', () => {
    const values = Object.fromEntries(Object.entries(contract).filter(([name]) => /^(MAX_HOSTED_|DEFAULT_HOSTED_|HOSTED_|TERMINAL_HOST_(PROTOCOL_VERSION|MAX_MESSAGE_BYTES)$)/.test(name)).map(([name, value]) => [name, value instanceof RegExp ? String(value) : value]));
    expect(values).toEqual({
      TERMINAL_HOST_PROTOCOL_VERSION: 1,
      TERMINAL_HOST_MAX_MESSAGE_BYTES: 1_073_741_824,
      MAX_HOSTED_TERMINALS: 256,
      MAX_HOSTED_ID_CHARS: 50,
      MAX_HOSTED_COLS: 2000,
      MAX_HOSTED_ROWS: 1000,
      MAX_HOSTED_SCROLLBACK: 100_000,
      MAX_HOSTED_TITLE_CHARS: 1024,
      MAX_HOSTED_PROJECT_KEY_CHARS: 32_767,
      MAX_HOSTED_VIEW_CHARS: 1_048_576,
      MAX_HOSTED_PID: 4_294_967_296,
      MAX_HOSTED_IDLE_DAYS: 3650,
      DEFAULT_HOSTED_IDLE_DAYS: 30,
      MAX_HOSTED_FEATURES: 256,
      MAX_HOSTED_INPUT_CHARS: 65_536,
      MAX_HOSTED_ACK_CHARS: 1_000_000,
      MAX_HOSTED_DATA_CHARS: 65_536,
      MAX_HOSTED_SCREEN_CHARS: 33_554_432,
      MAX_HOSTED_SCREEN_MARKS: 400,
      MAX_HOSTED_KEPT_SEQUENCES: 600,
      MAX_HOSTED_SEQUENCE_CHARS: 16_384,
      MAX_HOSTED_KEPT_SEQUENCE_CHARS: 1_048_576,
      MAX_HOSTED_PROCESS_NAME_CHARS: 256,
      MAX_HOSTED_MESSAGE_CHARS: 2000,
      HOSTED_ID: '/^term-[1-9][0-9]{0,14}$/',
      HOSTED_FEATURE: '/^[A-Za-z0-9._-]{1,128}$/',
    });
  });

  it('bounds each field of a message by its frozen value and no other', () => {
    const { requests, events } = contract.DAEMON_TO_TERMINAL_HOST;
    const host = contract.TERMINAL_HOST_TO_DAEMON.events;
    const text = (chars: number): string => 'x'.repeat(chars);
    const terminal = { id: 'term-1', pid: contract.MAX_HOSTED_PID, cols: contract.MAX_HOSTED_COLS, rows: contract.MAX_HOSTED_ROWS, scrollback: contract.MAX_HOSTED_SCROLLBACK, title: text(contract.MAX_HOSTED_TITLE_CHARS), projectKey: text(contract.MAX_HOSTED_PROJECT_KEY_CHARS), view: text(contract.MAX_HOSTED_VIEW_CHARS), detachedAt: 1 };
    const list = requests.list.result;
    expect(list({ terminals: [terminal] })).toEqual({ terminals: [terminal] });
    for (const past of [{ pid: contract.MAX_HOSTED_PID + 1 }, { cols: contract.MAX_HOSTED_COLS + 1 }, { rows: contract.MAX_HOSTED_ROWS + 1 }, { scrollback: contract.MAX_HOSTED_SCROLLBACK + 1 }, { title: text(contract.MAX_HOSTED_TITLE_CHARS + 1) }, { projectKey: text(contract.MAX_HOSTED_PROJECT_KEY_CHARS + 1) }, { view: text(contract.MAX_HOSTED_VIEW_CHARS + 1) }, { view: '' }, { id: 'term-01' }, { id: `term-${'1'.repeat(16)}` }]) {
      expect(list({ terminals: [{ ...terminal, ...past }] })).toBe(INVALID);
    }
    expect(list({ terminals: Array.from({ length: contract.MAX_HOSTED_TERMINALS + 1 }, () => terminal) })).toBe(INVALID);
    expect(events.input({ id: 'term-1', data: text(contract.MAX_HOSTED_INPUT_CHARS) })).not.toBe(INVALID);
    expect(events.input({ id: 'term-1', data: text(contract.MAX_HOSTED_INPUT_CHARS + 1) })).toBe(INVALID);
    expect(events.ack({ id: 'term-1', chars: contract.MAX_HOSTED_ACK_CHARS })).not.toBe(INVALID);
    for (const chars of [0, contract.MAX_HOSTED_ACK_CHARS + 1]) expect(events.ack({ id: 'term-1', chars })).toBe(INVALID);
    expect(requests.idleDays.params({ days: contract.MAX_HOSTED_IDLE_DAYS })).not.toBe(INVALID);
    expect(requests.idleDays.params({ days: contract.MAX_HOSTED_IDLE_DAYS + 1 })).toBe(INVALID);
    expect(host.data({ id: 'term-1', data: text(contract.MAX_HOSTED_DATA_CHARS) })).not.toBe(INVALID);
    for (const data of ['', text(contract.MAX_HOSTED_DATA_CHARS + 1)]) expect(host.data({ id: 'term-1', data })).toBe(INVALID);
    expect(host.process({ id: 'term-1', name: text(contract.MAX_HOSTED_PROCESS_NAME_CHARS + 1) })).toBe(INVALID);
    expect(host.error({ id: 'term-1', message: text(contract.MAX_HOSTED_MESSAGE_CHARS + 1) })).toBe(INVALID);
    const screen = { id: 'term-1', data: '', cols: 80, rows: 24, marks: [], sequences: 0 };
    expect(host.screen(screen)).toEqual(screen);
    expect(host.screen({ ...screen, marks: Array.from({ length: contract.MAX_HOSTED_SCREEN_MARKS + 1 }, () => ({ index: 0, line: 0 })) })).toBe(INVALID);
    expect(host.screen({ ...screen, shellSequences: Array.from({ length: contract.MAX_HOSTED_KEPT_SEQUENCES + 1 }, () => ({ index: 0, body: 'A', time: 0 })) })).toBe(INVALID);
    expect(host.screen({ ...screen, shellSequences: [{ index: 0, body: text(contract.MAX_HOSTED_SEQUENCE_CHARS + 1), time: 0 }] })).toBe(INVALID);
  });

  it('takes the longest view a daemon accepts from a client, as text', () => {
    // every unit a control character, which JSON text spells with six
    const long = '\u0001'.repeat(4096);
    const view = { root: long, profile: { id: long, name: long, file: long, args: Array.from({ length: 16 }, () => long), icon: 'bash' }, startCwd: long, nonce: '0123456789abcdef0123456789abcdef' };
    expect(parseTerminalView(view)).toEqual(view);
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(contract.MAX_HOSTED_VIEW_CHARS);
  });

  // A frozen bound never moves. One of today's limits that grew past it would make this version's daemon send an older host
  // what that host refuses, or refuse what an older host sends: the daemon must then clamp or split for the host link.
  it('has frozen bounds that hold what the daemon and the pty sessions produce today', () => {
    const today: Array<[frozen: number, current: number]> = [
      [contract.MAX_HOSTED_ID_CHARS, MAX_TERMINAL_ID_LENGTH],
      [contract.MAX_HOSTED_COLS, MAX_TERMINAL_COLS],
      [contract.MAX_HOSTED_ROWS, MAX_TERMINAL_ROWS],
      [contract.MAX_HOSTED_SCROLLBACK, MAX_SCREEN_SCROLLBACK],
      [contract.MAX_HOSTED_IDLE_DAYS, MAX_TERMINAL_IDLE_DAYS],
      [contract.MAX_HOSTED_TITLE_CHARS, MAX_RUN_TITLE_CHARS],
      [contract.MAX_HOSTED_PROJECT_KEY_CHARS, MAX_PATH_CHARS],
      [contract.MAX_HOSTED_INPUT_CHARS, MAX_TERMINAL_INPUT_CHARS],
      [contract.MAX_HOSTED_ACK_CHARS, MAX_TERMINAL_ACK_CHARS],
      [contract.MAX_HOSTED_DATA_CHARS, TERMINAL_BATCH_CHARS],
      [contract.MAX_HOSTED_SCREEN_CHARS, MAX_TERMINAL_SCREEN_CHARS],
      [contract.MAX_HOSTED_SCREEN_MARKS, MAX_TERMINAL_SCREEN_MARKS],
      [contract.MAX_HOSTED_KEPT_SEQUENCES, MAX_KEPT_SHELL_SEQUENCES],
      [contract.MAX_HOSTED_SEQUENCE_CHARS, MAX_SHELL_SEQUENCE_CHARS],
      [contract.MAX_HOSTED_KEPT_SEQUENCE_CHARS, MAX_KEPT_SHELL_SEQUENCE_CHARS],
      [contract.MAX_HOSTED_PROCESS_NAME_CHARS, MAX_HOST_PROCESS_NAME_CHARS],
      [contract.MAX_HOSTED_MESSAGE_CHARS, MAX_HOST_MESSAGE_CHARS],
      [contract.TERMINAL_HOST_MAX_MESSAGE_BYTES, WORKSPACE_MAX_MESSAGE_BYTES],
    ];
    for (const [frozen, current] of today) expect(frozen).toBeGreaterThanOrEqual(current);
    expect(contract.TERMINAL_HOST_PROTOCOL_VERSION).toBe(1);
  });

  it('fits a list of every terminal at every field\'s bound in one message', () => {
    const perTerminal = 3 * (contract.MAX_HOSTED_VIEW_CHARS + contract.MAX_HOSTED_TITLE_CHARS + contract.MAX_HOSTED_PROJECT_KEY_CHARS + contract.MAX_HOSTED_ID_CHARS) + 256;
    expect(contract.MAX_HOSTED_TERMINALS * perTerminal).toBeLessThan(contract.TERMINAL_HOST_MAX_MESSAGE_BYTES);
  });

  it('carries a terminal\'s view as text the host never reads, which the daemon parses back', () => {
    const view = { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: ['-l'], icon: 'bash' }, startCwd: '/srv/app', nonce: '0123456789abcdef0123456789abcdef' };
    const parse = contract.DAEMON_TO_TERMINAL_HOST.requests.spawn.params;
    const spawned = parse({ ...SPAWN, view: JSON.stringify(view) });
    expect(spawned).toEqual({ ...SPAWN, view: JSON.stringify(view) });
    expect(parseTerminalView(JSON.parse((spawned as contract.TerminalHostSpawn).view!))).toEqual(view);
    // text of any shape crosses: a later version's view is not this host's to judge
    expect(parse({ ...SPAWN, view: '{"icon":"a shell of 2031"}' })).not.toBe(INVALID);
    expect(parse({ ...SPAWN, view })).toBe(INVALID);
    expect(parse({ ...SPAWN, view: 'x'.repeat(contract.MAX_HOSTED_VIEW_CHARS + 1) })).toBe(INVALID);
    expect(contract.ptySpawn(spawned as contract.TerminalHostSpawn)).toEqual({ type: 'spawn', id: 'term-1', file: '/bin/sh', args: ['-l'], cwd: '/', env: { PATH: '/bin' }, cols: 80, rows: 24, scrollback: 1000 });
  });

  it('refuses a spawn outside the pty host\'s own bounds, and one without a title, a project key or its endpoints', () => {
    const parse = contract.DAEMON_TO_TERMINAL_HOST.requests.spawn.params;
    expect(parse(SPAWN)).toEqual(SPAWN);
    const keyed = { ...SPAWN, endpoints: { cli: true, relay: true, agentKey: '0123456789abcdef01234567' } };
    expect(parse(keyed)).toEqual(keyed);
    for (const broken of [{ ...SPAWN, id: 'term-0' }, { ...SPAWN, cols: 0 }, { ...SPAWN, env: { 'A=B': 'x' } }, { ...SPAWN, title: undefined }, { ...SPAWN, projectKey: 7 }, { ...SPAWN, endpoints: undefined }, { ...SPAWN, endpoints: { cli: true } }, { ...SPAWN, endpoints: { cli: true, relay: false, agentKey: '../agent' } }, null, 'spawn']) expect(parse(broken)).toBe(INVALID);
  });

  it('names its additions under its own feature, and parses what a host forwards: a connection by kind on a stream, and its relay nonce', () => {
    expect(contract.TERMINAL_HOST_FEATURES).toEqual([contract.ENDPOINTS_FEATURE]);
    expect(contract.MAX_HELD_ENDPOINT_CONNECTIONS).toBe(64);
    expect(contract.ENDPOINT_HOLD_MS).toBe(30_000);
    const { connection, relayNonce } = contract.TERMINAL_HOST_TO_DAEMON.events;
    for (const valid of [{ stream: 17, kind: 'cli', terminalId: 'term-1' }, { stream: 19, kind: 'agent', key: '0123456789abcdef01234567' }, { stream: 21, kind: 'relay' }]) expect(connection(valid)).toEqual(valid);
    for (const broken of [{ stream: 2, kind: 'relay' }, { stream: 17, kind: 'cli', terminalId: 'term-0' }, { stream: 17, kind: 'agent', key: 'A'.repeat(24) }, { stream: 17, kind: 'agent' }, { stream: 17, kind: 'socket' }]) expect(connection(broken)).toBe(INVALID);
    expect(relayNonce({ nonce: 'a'.repeat(64) })).toEqual({ nonce: 'a'.repeat(64) });
    for (const nonce of ['a'.repeat(63), 'A'.repeat(64), 7]) expect(relayNonce({ nonce })).toBe(INVALID);
  });

  it('takes an attach with no idle limit, and refuses a feature name or a limit outside the bounds', () => {
    const parse = contract.DAEMON_TO_TERMINAL_HOST.requests.attach.params;
    expect(parse({ features: [] })).toEqual({ features: [] });
    expect(parse({ features: ['terminalHost.endpoints'], idleDays: 0, later: true })).toEqual({ features: ['terminalHost.endpoints'], idleDays: 0 });
    for (const broken of [{}, { features: ['a name'] }, { features: [], idleDays: contract.MAX_HOSTED_IDLE_DAYS + 1 }, { features: [], idleDays: 1.5 }, { features: Array.from({ length: contract.MAX_HOSTED_FEATURES + 1 }, (_, index) => `f${index}`) }]) expect(parse(broken)).toBe(INVALID);
  });
});
