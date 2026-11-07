import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { StartDesignDetails } from '../../../shared/types/design';
import { designLinkEntryData, type DesignLink } from '../design-entries';
import { designFolderOf, designStateDirOf, forkDesignId, newDesignId } from '../design-paths';
import { claimDesignLink, readBriefRecords, readDesignLink } from '../design-state';
import { createStartDesignTool, type SessionShown, type StartDesignDeps } from '../tools/start-design';
import { clearDesigns } from './design-harness';

const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
type Tool = { execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: StartDesignDetails }> };
const FIRST = 'Add a contacts page';

function harness(sessionId = 'parent-1', branch: Record<string, unknown>[] = []) {
  const opened: string[] = [];
  const panels = {
    openDesignChat: vi.fn(async (seed: { designId: string }) => {
      const id = `design-${opened.length + 1}`;
      opened.push(id);
      // The new chat takes the link at its first bind, as SessionDesign.recordSeededRole does.
      await claimDesignLink(designStateDirOf(seed.designId), id, { designId: seed.designId, folder: designFolderOf(seed.designId), title: 'Contacts', parentSessionId: sessionId });
      return id;
    }),
    showSession: vi.fn(async (): Promise<SessionShown> => 'shown'),
    sessionTitle: async () => undefined,
  };
  const deps: StartDesignDeps = {
    enabled: () => true,
    designChat: () => false,
    sessionId: () => sessionId,
    firstMessage: () => FIRST,
    branch: () => branch,
    ruleSet: () => 'full',
    appendLink: (link: DesignLink) => { branch.push({ id: `l${branch.length}`, type: 'custom', customType: 'damocles.design-link', data: designLinkEntryData(link) }); },
    offerBrief: vi.fn(),
    panels: () => panels,
    publish: vi.fn(),
  };
  const start = (brief: string) => (createStartDesignTool(pi, deps) as unknown as Tool).execute('call', { title: 'Contacts', brief });
  return { deps, panels, branch, start };
}

beforeEach(clearDesigns);

describe('StartDesign', () => {
  it('creates the design folder, the link and a brief for the new design chat, which takes them', async () => {
    const h = harness();
    const result = await h.start('Design the contacts list');
    const designId = newDesignId('parent-1', FIRST);
    expect(result.details).toEqual({ designId, folder: designFolderOf(designId), designSessionId: 'design-1', reopened: false, title: 'Contacts' });
    expect(fs.existsSync(designFolderOf(designId))).toBe(true);
    expect(h.panels.openDesignChat).toHaveBeenCalledWith({ designId, title: 'Contacts', parentSessionId: 'parent-1', ruleSet: 'full' });
    expect(h.branch.map((e) => e['customType'])).toEqual(['damocles.design-link']);
    expect((await readDesignLink(designStateDirOf(designId)))?.designSessionId).toBe('design-1');
    expect((await readBriefRecords(designStateDirOf(designId))).map((b) => [b.text, b.designSessionId, b.reopened])).toEqual([['Design the contacts list', 'design-1', false]]);
  });

  it('reopens the same design chat with the new request as a brief (PD-2)', async () => {
    const h = harness();
    await h.start('Design the contacts list');
    const again = await h.start('Add a filter by status');
    expect(again.details).toMatchObject({ designSessionId: 'design-1', reopened: true });
    expect(h.panels.openDesignChat).toHaveBeenCalledTimes(1);
    expect(h.panels.showSession).toHaveBeenCalledWith('design-1');
    const briefs = await readBriefRecords(designStateDirOf(again.details.designId));
    expect(briefs.at(-1)).toMatchObject({ text: 'Add a filter by status', designSessionId: 'design-1', reopened: true });
    expect(h.deps.offerBrief).toHaveBeenCalledWith('design-1', briefs.at(-1)!.briefId);
    expect(h.branch.filter((e) => e['customType'] === 'damocles.design-link')).toHaveLength(1);
  });

  it('opens a new design chat on the same folder when the old one was deleted (PD-43)', async () => {
    const h = harness();
    await h.start('Design the contacts list');
    fs.writeFileSync(path.join(designFolderOf(newDesignId('parent-1', FIRST)), 'design.md'), '# kept');
    h.panels.showSession.mockResolvedValueOnce('missing');
    const result = await h.start('Continue the list');
    expect(result.details).toMatchObject({ designSessionId: 'design-2', reopened: false });
    const link = await readDesignLink(designStateDirOf(result.details.designId));
    expect([link?.designSessionId, link?.superseded]).toEqual(['design-2', ['design-1']]);
    expect((await readBriefRecords(designStateDirOf(result.details.designId))).filter((b) => b.designSessionId === 'design-2').map((b) => b.context)).toEqual([{ kind: 'takeover' }]);
  });

  it('gives a fork its own design whose brief names the inherited folder (PD-37)', async () => {
    const parent = harness();
    await parent.start('Design the contacts list');
    const fork = harness('fork-1', [...parent.branch]);
    const result = await fork.start('Try a card layout');
    const inherited = newDesignId('parent-1', FIRST);
    expect(result.details.designId).toBe(forkDesignId(inherited, 'fork-1'));
    const [brief] = await readBriefRecords(designStateDirOf(result.details.designId));
    expect(brief?.context).toEqual({ kind: 'fork', folder: designFolderOf(inherited) });
  });

  it('refuses while design mode is off and in a design chat', async () => {
    const h = harness();
    await expect((createStartDesignTool(pi, { ...h.deps, enabled: () => false }) as unknown as Tool).execute('c', { title: 'x', brief: 'y' })).rejects.toThrow(/Design mode is off/);
    await expect((createStartDesignTool(pi, { ...h.deps, designChat: () => true }) as unknown as Tool).execute('c', { title: 'x', brief: 'y' })).rejects.toThrow(/cannot start another design/);
  });
});
