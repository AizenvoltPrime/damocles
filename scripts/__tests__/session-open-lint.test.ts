import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { ESLint } from 'eslint';

// pi's SessionManager.open reads, and createBranchedSession writes, a whole session file on the calling thread; engine code
// uses openAsync and createBranchedSessionAsync, and only the metadata index's parse thread opens synchronously
// (docs/invariants.md "Session store").
const ROOT = join(import.meta.dirname, '..', '..');
const eslint = new ESLint({ cwd: ROOT });
const OPENS = [
  'declare const pi: { SessionManager: { open(file: string): unknown } };',
  'declare const SessionManager: { open(file: string): unknown };',
  'export const a = pi.SessionManager.open(\'a.jsonl\');',
  'export const b = SessionManager.open(\'b.jsonl\');',
  'export class C { private readonly _pi = pi; c(): unknown { return this._pi.SessionManager.open(\'c.jsonl\'); } }',
].join('\n');
const INDIRECT_OPENS = [
  'declare const pi: { SessionManager: { open(file: string): unknown } };',
  'export const d = pi.SessionManager.open.call(pi.SessionManager, \'d.jsonl\');',
  'export const e = pi.SessionManager[\'open\'](\'e.jsonl\');',
  'export const f = pi.SessionManager.open;',
  'export const { open } = pi.SessionManager;',
].join('\n');
const ASYNC_OPENS = [
  'declare const pi: { SessionManager: { openAsync(file: string): Promise<unknown> } };',
  'export const a = pi.SessionManager.openAsync(\'a.jsonl\');',
].join('\n');
const BRANCHES = [
  'declare const sm: { createBranchedSession(leaf: string): unknown; createBranchedSessionAsync(leaf: string): Promise<unknown> };',
  'export const a = sm.createBranchedSession(\'leaf\');',
  'export const b = sm.createBranchedSessionAsync(\'leaf\');',
].join('\n');

async function findings(text: string, file: string): Promise<number> {
  const [result] = await eslint.lintText(`${text}\n`, { filePath: join(ROOT, file) });
  return (result?.messages ?? []).filter((message) => message.ruleId === 'damocles/session-open-async').length;
}

describe('damocles/session-open-async', () => {
  it('fails each synchronous open in engine code, and passes openAsync', async () => {
    expect(await findings(OPENS, 'src/core/pi-session/session-open-probe.ts')).toBe(3);
    expect(await findings(OPENS, 'src/core/team/session-open-probe.ts')).toBe(3);
    expect(await findings(ASYNC_OPENS, 'src/core/pi-session/session-open-probe.ts')).toBe(0);
  }, 60_000);

  it('fails an open reached through call, a computed key, a reference or destructuring', async () => {
    expect(await findings(INDIRECT_OPENS, 'src/core/pi-session/session-open-probe.ts')).toBe(4);
  }, 60_000);

  it('fails a synchronous branch write in engine code, and passes createBranchedSessionAsync', async () => {
    expect(await findings(BRANCHES, 'src/core/pi-session/session-open-probe.ts')).toBe(1);
    expect(await findings(BRANCHES, 'src/core/pi-session/__tests__/session-open-probe.test.ts')).toBe(0);
  }, 60_000);

  it('passes the metadata index parse thread and tests', async () => {
    expect(await findings(OPENS, 'src/core/pi-session/session-store/meta-index/parser.ts')).toBe(0);
    expect(await findings(OPENS, 'src/core/pi-session/__tests__/session-open-probe.test.ts')).toBe(0);
  }, 60_000);
});
