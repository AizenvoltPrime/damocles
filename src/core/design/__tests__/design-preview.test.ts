import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { designPreviewInfo, readPreviewFile } from '../design-preview';
import { designFolderOf, designStateDirOf } from '../design-paths';
import { updateDesignLink } from '../design-state';
import { readManifest } from '../design-files';
import { TOOL_EDIT } from '../../../shared/tool-names';
import { SessionDesign } from '../session-design';
import { clearDesigns, designHarness, fakeSession, type DesignHarness } from './design-harness';

const DESIGN = 'contacts-1a2b3c4d';
const role = (ruleSet: 'full' | 'reduced' = 'full') => ({ id: 'role', type: 'custom', customType: 'damocles.design', data: { v: 1, designId: DESIGN, parentSessionId: 'parent-1', ruleSet, title: 'Contacts' } });
const link = () => ({ id: 'link', type: 'custom', customType: 'damocles.design-link', data: { v: 1, designId: DESIGN, folder: designFolderOf(DESIGN), parentSessionId: 'parent-1', title: 'Contacts' } });

const DESIGN_MD = ['---', 'app: Vue 3', 'viewports:', '  primary: xl', '  checked: [base, sm, 1100, nope]', '  journey: [md]', '---', '# Contacts', ''].join('\n');
const SCREEN = '<!doctype html><html data-ds-screen="S1" data-ds-states="default empty x&quot;]{} default"><head><title> Contacts </title></head><body></body></html>';

function writeDesign(files: Record<string, string>): string {
  const folder = designFolderOf(DESIGN);
  for (const [relPath, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, relPath)), { recursive: true });
    fs.writeFileSync(path.join(folder, relPath), content);
  }
  return folder;
}

const inventory = (values: Record<string, number>): string => JSON.stringify({ schemaVersion: 1, stack: 'Vue', tokens: null, breakpoints: { source: 'tailwind', values }, components: [], screens: [], types: [], stores: [], actions: [] });

function previewHost(): DesignPreviewHost & { opens: unknown[][]; changes: unknown[][]; shows: boolean } {
  const opens: unknown[][] = [];
  const changes: unknown[][] = [];
  const host = {
    opens,
    changes,
    shows: true,
    open: async (...args: unknown[]) => {
      opens.push(args);
      return host.shows;
    },
    changed: (...args: unknown[]) => {
      changes.push(args);
    },
    capture: () => Promise.reject(new Error('No design runner')),
    probe: () => Promise.reject(new Error('No design runner')),
    journey: () => Promise.reject(new Error('unused')),
    replayJourney: () => Promise.reject(new Error('unused')),
  };
  return host;
}

function withPreview(harness: DesignHarness): ReturnType<typeof previewHost> {
  const host = previewHost();
  // desktop has the preview and no DesignHost
  Object.assign(harness.platform, { designPreview: host, design: undefined });
  Object.assign(harness.platform.capabilities, { designPreview: true });
  return host;
}

beforeEach(() => {
  clearDesigns();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('design.info: a screen\'s widths and declared states (PD-8, PD-44)', () => {
  it('reads the breakpoints ascending, resolves the viewports by preset or width, and keeps only the alphabet of state names', async () => {
    const folder = writeDesign({ 'inventory.json': inventory({ xl: 1280, sm: 640, md: 768, 'bad name': 900 }), 'design.md': DESIGN_MD, 'screens/S1.html': SCREEN });
    const info = await designPreviewInfo(folder, 'screens/S1.html');
    expect(info).toEqual({
      path: path.join(fs.realpathSync.native(folder), 'screens', 'S1.html'),
      screenId: 'S1',
      title: 'Contacts',
      breakpoints: [{ name: 'sm', width: 640 }, { name: 'md', width: 768 }, { name: 'xl', width: 1280 }],
      primary: 1280,
      checked: [390, 640, 1100],
      journey: [768],
      states: ['default', 'empty'],
    });
  });

  it('falls back to 1280 and no breakpoints without design.md or inventory.json, and answers nothing for a missing or outside screen', async () => {
    const folder = writeDesign({ 'screens/S1.html': '<html><body></body></html>' });
    expect(await designPreviewInfo(folder, 'screens/S1.html')).toMatchObject({ breakpoints: [], primary: 1280, checked: [], journey: [], states: [], screenId: null, title: null });
    expect(await designPreviewInfo(folder, 'screens/S2.html')).toBeUndefined();
    expect(await designPreviewInfo(folder, '../outside.html')).toBeUndefined();
  });

  it('reads a file with the fidelity it is served with, and nothing outside the folder', async () => {
    const folder = writeDesign({ 'screens/S1.html': SCREEN, 'manifest.json': JSON.stringify({ schemaVersion: 1, designId: DESIGN, plan: null, fidelity: 'interactive', status: 'draft', version: null, screens: [], updatedAt: new Date().toISOString() }) });
    expect(await readPreviewFile(folder, DESIGN, 'screens/S1.html')).toEqual({ bytes: Buffer.from(SCREEN), fidelity: 'interactive' });
    expect(await readPreviewFile(folder, DESIGN, '../x.html')).toBeUndefined();
    expect(await readPreviewFile(folder, DESIGN, 'screens/none.html')).toBeUndefined();
  });
});

describe('the design a core serves to main is one a chat of it holds', () => {
  it('resolves a design only while its design chat or its parent holds it, and tells main once a chat begins to', () => {
    expect(SessionDesign.heldFolderOf(DESIGN)).toBeUndefined();
    const parent = designHarness({ session: fakeSession('parent-1', [link()]) });
    const host = withPreview(parent);
    parent.design.publish();
    expect(SessionDesign.heldFolderOf(DESIGN)).toBe(designFolderOf(DESIGN));
    expect(SessionDesign.heldFolderOf('billing-0c0c0c0c')).toBeUndefined();
    expect(host.changes).toEqual([[DESIGN, []]]);
    parent.design.dispose();
    expect(SessionDesign.heldFolderOf(DESIGN)).toBeUndefined();
  });

  it('publishes openPreview on a host with the preview tab, and not where the rule set has none', async () => {
    const full = designHarness({ session: fakeSession('parent-1', [link()]) });
    withPreview(full);
    full.design.publish();
    await vi.waitFor(() => expect(full.posted).toContainEqual(expect.objectContaining({ type: 'designState', openPreview: true })));
    full.design.dispose();
    const reduced = designHarness({ session: fakeSession('parent-2', [link()]) });
    reduced.design.publish();
    await vi.waitFor(() => expect(reduced.posted).toContainEqual(expect.objectContaining({ type: 'designState', openPreview: false })));
    reduced.design.dispose();
    // a design chat recorded where previews are off offers none on a host that has them, since its own rule set refuses
    const recorded = designHarness({ session: fakeSession('design-1', [role('reduced')]) });
    withPreview(recorded);
    recorded.design.publish();
    await vi.waitFor(() => expect(recorded.posted).toContainEqual(expect.objectContaining({ type: 'designState', openPreview: false })));
    recorded.design.dispose();
  });
});

describe('a design chat\'s writes open and refresh its previews (PD-33)', () => {
  // The shapes the real tools take: pi's `write` (Damocles' replacement) `{ path, content }`, Damocles' `Edit` `{ file_path, … }`.
  const write = (session: ReturnType<typeof fakeSession>, id: string, filePath: string, isError = false, toolName = 'write'): void => {
    const args = toolName === TOOL_EDIT ? { file_path: filePath, old_string: 'a', new_string: 'b' } : { path: filePath, content: '<p>' };
    session.emit({ type: 'tool_execution_start', toolCallId: id, toolName, args });
    session.emit({ type: 'tool_execution_end', toolCallId: id, toolName, result: {}, isError });
  };

  it('opens a screen\'s tab at its first write only, and sends design.changed once the writes pause for 150 ms', async () => {
    vi.useFakeTimers();
    const session = fakeSession('design-1', [role()]);
    const chat = designHarness({ session });
    const host = withPreview(chat);
    chat.design.track(session.session);
    const folder = designFolderOf(DESIGN);
    write(session, 't1', path.join(folder, 'screens', 'S1.html'));
    write(session, 't2', path.join(folder, 'screens', 'S1.html'));
    write(session, 't3', path.join(folder, 'design.md'), false, TOOL_EDIT);
    write(session, 't4', path.join(folder, 'screens', 'S2.html'), true);
    write(session, 't5', path.join(folder, '..', 'elsewhere.html'));
    // resolved as the write tool resolves it, the `@` prefix included
    write(session, 't6', `@${path.join(folder, 'variants', 'a.html')}`, false, TOOL_EDIT);
    await vi.advanceTimersByTimeAsync(149);
    expect(host.changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.changes).toEqual([[DESIGN, ['screens/S1.html', 'design.md', 'variants/a.html']]]);
    expect(host.opens).toEqual([['design-panel', DESIGN, 'screens/S1.html']]);
    chat.design.dispose();
  });

  it('marks a finished version edited at the first designer write after it, keeping its number', async () => {
    const session = fakeSession('design-1', [role()]);
    const chat = designHarness({ session });
    withPreview(chat);
    chat.design.track(session.session);
    const folder = designFolderOf(DESIGN);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ schemaVersion: 1, designId: DESIGN, plan: null, fidelity: null, status: 'finished', version: 1, screens: [], updatedAt: '2026-01-01T00:00:00.000Z' }));
    write(session, 'e1', path.join(folder, 'design.md'), false, TOOL_EDIT);
    // in the folder writes a restore waits for
    await chat.design.settledWrites();
    expect(await readManifest(folder, DESIGN)).toMatchObject({ status: 'draft', version: 1 });
    await vi.waitFor(() => expect(chat.posted).toContainEqual(expect.objectContaining({ type: 'designState', design: expect.objectContaining({ status: 'draft', version: 1 }) })));
    chat.design.dispose();
  });

  it('opens a parent\'s Open preview in the design chat link.json names, and refuses a design that is not its own', async () => {
    const parent = designHarness({ session: fakeSession('parent-1', [link()]) });
    withPreview(parent);
    // no link.json names a design chat yet
    expect(await parent.design.openPreview(DESIGN, 'screens/S1.html')).toEqual({ refused: expect.objectContaining({ message: 'Open the design chat to preview {0}.' }) });
    expect(await parent.design.openPreview('billing-0c0c0c0c', 'screens/S1.html')).toEqual({ refused: expect.objectContaining({ message: 'Could not preview {0}.' }) });
    expect(parent.panels.showSession).not.toHaveBeenCalled();
    parent.design.dispose();
  });

  it('refuses a parent\'s Open preview when the design chat could not be shown on the asking device, and opens nothing', async () => {
    await updateDesignLink(designStateDirOf(DESIGN), () => ({ schemaVersion: 1, designId: DESIGN, folder: designFolderOf(DESIGN), title: 'Contacts', parentSessionId: 'parent-1', designSessionId: 'design-1', superseded: [] }));
    const parent = designHarness({ session: fakeSession('parent-1', [link()]) });
    const host = withPreview(parent);
    parent.panels.showSession.mockResolvedValueOnce('notShown');
    expect(await parent.design.openPreview(DESIGN, 'screens/S1.html')).toEqual({ refused: { message: 'The design chat could not be shown on this device, so {0} did not open.', args: ['screens/S1.html'] } });
    expect(parent.panels.showSession).toHaveBeenCalledWith('design-1');
    expect(host.opens).toEqual([]);
    parent.design.dispose();
  });

  it('refuses a design chat\'s own Open preview when no app the work may open it in shows the chat', async () => {
    const chat = designHarness({ session: fakeSession('design-1', [role()]) });
    const host = withPreview(chat);
    host.shows = false;
    expect(await chat.design.openPreview(DESIGN, 'screens/S1.html')).toEqual({ refused: { message: 'Open the design chat to preview {0}.', args: ['screens/S1.html'] } });
    host.shows = true;
    expect(await chat.design.openPreview(DESIGN, 'screens/S1.html')).toEqual({ opened: true });
    chat.design.dispose();
  });

  it('opens nothing on a host without the preview tab', async () => {
    const session = fakeSession('design-1', [role('reduced')]);
    const chat = designHarness({ session });
    expect(await chat.design.openPreview(DESIGN, 'screens/S1.html')).toEqual({ refused: expect.objectContaining({ message: 'This chat shows no design previews.' }) });
    chat.design.dispose();
  });
});
