// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { editor as MonacoEditor } from 'monaco-editor/editor/editor.api';
import type { DamoclesScmApi, ScmQuickDiffBaseResult } from '../../preload/scm-channels';
import { createQuickDiffHandler, type QuickDiffReply, type QuickDiffRequest } from '../editor/quick-diff/quick-diff-compute';

const workers = vi.hoisted(() => {
  // The quick diff worker double: it records what it is sent and fails on demand, as a worker that cannot load does.
  class FakeWorker extends EventTarget {
    static started: FakeWorker[] = [];
    // set, every worker answers as the real one does, a task later
    static handle: ((request: QuickDiffRequest) => QuickDiffReply | undefined) | undefined;
    readonly sent: QuickDiffRequest[] = [];
    terminated = false;
    constructor() {
      super();
      FakeWorker.started.push(this);
    }
    postMessage(request: QuickDiffRequest): void {
      this.sent.push(request);
      const reply = FakeWorker.handle?.(request);
      if (reply) setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: reply })));
    }
    terminate(): void {
      this.terminated = true;
    }
    fail(): void {
      this.dispatchEvent(new Event('error'));
    }
  }
  return FakeWorker;
});
vi.mock('../editor/quick-diff/quick-diff.worker?worker', () => ({ default: workers }));

const { createQuickDiffModel } = await import('../editor/quick-diff/quick-diff-model');

const BASE: ScmQuickDiffBaseResult = { ok: true, indexText: 'a\n', indexOid: 'a'.repeat(40), headText: null, headOid: null, hasStaged: false };

function fakeModel(): MonacoEditor.ITextModel {
  return { id: 'model-1', getVersionId: () => 1, getValue: () => 'b\n', onDidChangeContent: () => ({ dispose: () => undefined }) } as unknown as MonacoEditor.ITextModel;
}

const api = (quickDiffBase: DamoclesScmApi['quickDiffBase']): DamoclesScmApi => ({ quickDiffBase }) as unknown as DamoclesScmApi;
const target = { repoId: 'repo-1', path: 'a.txt' };

beforeEach(() => {
  workers.started.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  workers.handle = undefined;
});

describe('the quick diff model', () => {
  it('shows no marks and lets every waiter go when its worker fails, and diffs in a new worker afterwards', async () => {
    const model = createQuickDiffModel(api(async () => BASE), fakeModel(), target, () => () => undefined);
    await vi.waitFor(() => expect(workers.started[0]?.sent.map((request) => request.kind)).toEqual(['base', 'diff']));
    expect(model.status.value).toBe('reading');
    const waiting = model.current();
    workers.started[0]!.fail();
    expect(await waiting).toBeNull();
    expect(workers.started[0]!.terminated).toBe(true);
    expect(model.status.value).toBe('none');
    void model.current();
    expect(workers.started[1]!.sent.map((request) => request.kind)).toEqual(['base', 'diff']);
    model.dispose();
  });

  it('takes a base read that rejects as no base', async () => {
    const model = createQuickDiffModel(api(() => Promise.reject(new Error('main failed'))), fakeModel(), target, () => () => undefined);
    await vi.waitFor(() => expect(model.status.value).toBe('none'));
    expect(model.state.value).toBeNull();
    expect(await model.current()).toBeNull();
    model.dispose();
  });

  it('answers an action that comes before the first base read lands with that base, not with no state', async () => {
    workers.handle = createQuickDiffHandler();
    let answer: (base: ScmQuickDiffBaseResult) => void = () => undefined;
    const model = createQuickDiffModel(api(() => new Promise((resolve) => (answer = resolve))), fakeModel(), target, () => () => undefined);
    const waiting = model.current();
    answer(BASE);
    expect(await waiting).toMatchObject({ indexOid: BASE.indexOid, primary: [{ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 }] });
    model.dispose();
  });

  it('answers an action after the status revision moved with the index read for it, never the index before', async () => {
    workers.handle = createQuickDiffHandler();
    let index: ScmQuickDiffBaseResult = BASE;
    let revision: () => void = () => undefined;
    const model = createQuickDiffModel(api(async () => index), fakeModel(), target, (listener) => {
      revision = listener;
      return () => undefined;
    });
    await vi.waitFor(() => expect(model.status.value).toBe('ready'));
    index = { ...BASE, indexText: 'b\n', indexOid: 'b'.repeat(40) };
    revision();
    expect(await model.current()).toMatchObject({ indexOid: 'b'.repeat(40), primary: [] });
    model.dispose();
  });

  it('says none for a file main gives no base', async () => {
    const refused = createQuickDiffModel(api(async () => ({ ok: false, reason: 'untracked' })), fakeModel(), target, () => () => undefined);
    await vi.waitFor(() => expect(refused.status.value).toBe('none'));
    refused.dispose();
  });
});
