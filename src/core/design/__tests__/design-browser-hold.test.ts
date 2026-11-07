import { beforeEach, describe, expect, it, vi } from 'vitest';
import { designFolderOf } from '../design-paths';
import { clearDesigns, designHarness, fakeSession } from './design-harness';

const role = (designId: string, parent: string) => ({ id: `role-${designId}`, type: 'custom', customType: 'damocles.design', data: { v: 1, designId, parentSessionId: parent, ruleSet: 'reduced', title: 'Contacts' } });
const link = (designId: string, parent: string) => ({ id: `link-${designId}`, type: 'custom', customType: 'damocles.design-link', data: { v: 1, designId, folder: designFolderOf(designId), parentSessionId: parent, title: 'Contacts' } });

beforeEach(() => {
  clearDesigns();
});

describe('a design served to the browser stays open while its design chat or its parent is open', () => {
  it('closes the design on the host only when both chats let go of it', () => {
    const designId = 'contacts-0a0a0a0a';
    const chat = designHarness({ session: fakeSession('design-1', [role(designId, 'parent-1')]) });
    const parent = designHarness({ session: fakeSession('parent-1', [link(designId, 'parent-1')]) });
    chat.design.publish();
    parent.design.publish();

    chat.design.dispose();
    expect([...chat.platform.design!.closed, ...parent.platform.design!.closed]).toEqual([]);
    parent.design.dispose();
    expect(parent.platform.design!.closed).toEqual([designId]);
  });

  it('lets go when the panel moves to a conversation without the design, and holds a design it serves from', () => {
    const designId = 'contacts-0b0b0b0b';
    const parent = designHarness({ session: fakeSession('parent-1', [link(designId, 'parent-1')]) });
    expect(parent.design.servedFolderOf(designId)).toBe(designFolderOf(designId));
    expect(parent.design.servedFolderOf('billing-0c0c0c0c')).toBeUndefined();

    parent.current = fakeSession('other-1');
    parent.design.publish();

    expect(parent.platform.design!.closed).toEqual([designId]);
    parent.design.dispose();
    expect(parent.platform.design!.closed).toEqual([designId]);
  });

  it('tells the webview whether the host\'s rule set opens designs from the chat', async () => {
    const parent = designHarness({ session: fakeSession('parent-1', [link('contacts-0d0d0d0d', 'parent-1')]) });
    parent.design.publish();
    await vi.waitFor(() => expect(parent.posted).toContainEqual(expect.objectContaining({ type: 'designState', openInBrowser: true })));
    parent.design.dispose();
  });
});
