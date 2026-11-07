import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { LocalizedError } from '../../../../../shared/localized-text';
import { l } from '../../../../l10n';
import { createDesignHandlers } from '../design-handlers';
import type { HandlerContext, HandlerDependencies } from '../../types';
import type { ExtensionToWebviewMessage } from '../../../../../shared/types/messages';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

function setup(replayJourney: (toolCallId: string, reducedMotion: boolean) => Promise<void>) {
  const posted: ExtensionToWebviewMessage[] = [];
  const handlers = createDesignHandlers({ platform: createFakePlatform({ capabilities: { designPreview: true } }), postMessage: (_to: unknown, message: ExtensionToWebviewMessage) => posted.push(message) } as unknown as HandlerDependencies);
  const replay = vi.fn(replayJourney);
  const ctx = { reply: {}, panelId: 'p1', session: { design: { replayJourney: replay } } } as unknown as HandlerContext;
  const send = (message: Record<string, unknown>) => handlers.replayDesignJourney!({ type: 'replayDesignJourney', ...message } as never, ctx);
  return { posted, replay, send };
}

describe('replayDesignJourney (D93)', () => {
  it('asks the chat\'s design to replay the call by its id alone, and answers the asking view once it ended', async () => {
    const { posted, replay, send } = setup(async () => undefined);
    await send({ toolCallId: 'journey-1', reducedMotion: true, steps: [{ action: 'click', target: { selector: 'body' } }], relPath: '../../.ssh/id_ed25519' });
    expect(replay).toHaveBeenCalledWith('journey-1', true);
    expect(posted).toEqual([{ type: 'designJourneyReplayed', toolCallId: 'journey-1', ok: true }]);
  });

  it('passes a refusal through as its localized text, and names any other failure', async () => {
    const refused = setup(async () => {
      throw new LocalizedError(l('This journey is no longer in this chat.'));
    });
    await refused.send({ toolCallId: 'journey-1', reducedMotion: false });
    expect(refused.posted).toEqual([{ type: 'designJourneyReplayed', toolCallId: 'journey-1', ok: false, error: { message: 'This journey is no longer in this chat.' } }]);
    const failed = setup(async () => {
      throw new Error('The preview is not showing: select its design chat and try again');
    });
    await failed.send({ toolCallId: 'journey-1', reducedMotion: 'yes' });
    expect(failed.replay).toHaveBeenCalledWith('journey-1', false);
    expect(failed.posted[0]).toMatchObject({ type: 'designJourneyReplayed', ok: false, error: { message: 'Could not replay the journey: {0}' } });
  });

  it('drops a request whose call id is not a bounded string', async () => {
    const { posted, replay, send } = setup(async () => undefined);
    await send({ toolCallId: 7, reducedMotion: false });
    await send({ toolCallId: 'x'.repeat(129), reducedMotion: false });
    expect(replay).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });
});
