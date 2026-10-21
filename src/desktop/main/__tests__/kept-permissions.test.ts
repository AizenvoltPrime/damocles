import { describe, expect, it } from 'vitest';
import type { ChatPermissions } from '../../core-protocol';
import { KeptPermissions } from '../kept-permissions';

const ASK_NO_YOLO: ChatPermissions = { permissionMode: 'default', dangerouslySkipPermissions: false };
const PLAN: ChatPermissions = { permissionMode: 'plan', dangerouslySkipPermissions: false };

const publishedBy = (entries: Record<string, ChatPermissions>) => (viewId: string): ChatPermissions | undefined => entries[viewId];

describe('KeptPermissions', () => {
  it('hands the reopen after a core ended what that core published for each chat still open', () => {
    const kept = new KeptPermissions();
    kept.coreEnded(['view-1', 'view-2'], publishedBy({ 'view-1': ASK_NO_YOLO, 'view-2': PLAN, 'view-closed': PLAN }));
    expect([...kept.reopening(true)]).toEqual([['view-1', ASK_NO_YOLO], ['view-2', PLAN]]);
  });

  it('keeps what it handed a core that ended before it published the chat, and nothing for a chat never published', () => {
    const kept = new KeptPermissions();
    kept.coreEnded(['view-1'], publishedBy({ 'view-1': ASK_NO_YOLO }));
    kept.reopening(true);
    kept.coreEnded(['view-1', 'view-new'], publishedBy({}));
    expect([...kept.reopening(true)]).toEqual([['view-1', ASK_NO_YOLO]]);
  });

  it('hands a launch or a reopened window nothing, and forgets what it kept for a later restart', () => {
    const kept = new KeptPermissions();
    kept.coreEnded(['view-1'], publishedBy({ 'view-1': ASK_NO_YOLO }));
    expect(kept.reopening(false).size).toBe(0);
    kept.coreEnded(['view-1'], publishedBy({}));
    expect(kept.reopening(true).size).toBe(0);
  });
});
