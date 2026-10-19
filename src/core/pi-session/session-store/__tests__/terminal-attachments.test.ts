import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { TerminalAttachmentInput } from '../../../../shared/types/terminal-attachment';
import { formatIdeContextBlock } from '../../../../shared/ide-context';
import { formatTerminalAttachmentBlock } from '../../../terminal-attachment';
import { reconstructMessages } from '../history-loader';
import { extractFirstUserMessage, newestUniquePrompts } from '../metadata';
import { extractTerminalAttachmentCounts } from '../terminal-attachments';
import { DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY } from '../constants';

const output: TerminalAttachmentInput = { kind: 'terminal', source: 'command', commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', text: 'FAIL a.test.ts', omittedLines: 0 };
const block = formatTerminalAttachmentBlock(output);

function user(id: string, text: string): SessionEntry {
  return { id, type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } } as unknown as SessionEntry;
}
function sidecar(userEntryId: string, count: unknown): SessionEntry {
  return { id: `t-${userEntryId}`, type: 'custom', customType: DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY, data: { userEntryId, count } } as unknown as SessionEntry;
}

function replayedUser(branch: SessionEntry[]) {
  const message = reconstructMessages(branch).messages.find((candidate) => candidate.kind === 'user');
  if (message?.kind !== 'user') throw new Error('no user message');
  return message;
}

describe('terminal attachments in history', () => {
  it('shows the chip and the typed text, never the wrapper, for a prompt its sidecar records', () => {
    const ide = formatIdeContextBlock({ type: 'opened_file', filePath: 'a.ts' });
    const message = replayedUser([user('u1', `${block}\n${ide}\nwhat failed?`), sidecar('u1', 1)]);
    expect(message.content).toBe('what failed?');
    expect(message.terminalAttachments).toEqual([
      { id: 'u1:0', kind: 'terminal', source: 'command', commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', lineCount: 1, omittedLines: 0, preview: 'FAIL a.test.ts' },
    ]);
  });

  it('keeps typed text that imitates the wrapper as text, with no chip, when no sidecar names the entry', () => {
    const typed = `${block}\nplease look`;
    const message = replayedUser([user('u1', typed), sidecar('other', 1)]);
    expect(message.content).toBe(typed);
    expect(message.terminalAttachments).toBeUndefined();
  });

  it('takes only as many blocks as the sidecar counts', () => {
    const message = replayedUser([user('u1', `${block}\n${block}\nhi`), sidecar('u1', 1)]);
    expect(message.terminalAttachments).toHaveLength(1);
    expect(message.content).toBe(`${block}\nhi`);
  });

  it('ignores a malformed sidecar', () => {
    expect(extractTerminalAttachmentCounts([sidecar('u1', 0), sidecar('u2', 1.5), sidecar('u3', '2'), sidecar('', 1), sidecar('u4', 2)])).toEqual(new Map([['u4', 2]]));
  });

  describe("an attachment's own images, the last ones of the prompt", () => {
    const image = (data: string) => ({ type: 'image', data, mimeType: 'image/png' });
    const withImages = (id: string, text: string, images: string[]) =>
      ({ id, type: 'message', message: { role: 'user', content: [{ type: 'text', text }, ...images.map(image)] } }) as unknown as SessionEntry;
    const imageSidecar = (userEntryId: string, count: number, images: unknown) =>
      ({ id: `t-${userEntryId}`, type: 'custom', customType: DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY, data: { userEntryId, count, images } }) as unknown as SessionEntry;
    const imageData = (message: ReturnType<typeof replayedUser>) =>
      (message.contentBlocks ?? []).flatMap((b) => (b.type === 'image' ? [(b as { source: { data: string } }).source.data] : []));

    it('stay behind their chip on reload, as live, while the typed images still show', () => {
      const message = replayedUser([withImages('u1', `${block}\nlook`, ['typed', 'resource']), imageSidecar('u1', 1, 1)]);
      expect(imageData(message)).toEqual(['typed']);
      expect(message.content).toBe('look');
    });

    it('leave no image block when the attachments brought every image', () => {
      expect(replayedUser([withImages('u1', `${block}\nlook`, ['resource']), imageSidecar('u1', 1, 1)]).contentBlocks).toBeUndefined();
    });

    it('are all shown for a sidecar written before the count existed', () => {
      expect(imageData(replayedUser([withImages('u1', `${block}\nlook`, ['a', 'b']), sidecar('u1', 1)]))).toEqual(['a', 'b']);
    });

    it('are all shown when the count is malformed, which leaves the blocks it records stripped', () => {
      for (const images of [0, -1, 1.5, '1', null]) {
        const branch = [withImages('u1', `${block}\nlook`, ['typed', 'resource']), imageSidecar('u1', 1, images)];
        expect(extractTerminalAttachmentCounts(branch), String(images)).toEqual(new Map([['u1', 1]]));
        const message = replayedUser(branch);
        expect(imageData(message), String(images)).toEqual(['typed', 'resource']);
        expect(message.content).toBe('look');
        expect(message.terminalAttachments).toHaveLength(1);
      }
    });
  });

  it('keeps the wrapper out of the session preview and the prompt history', () => {
    const branch = [user('u1', `${block}\nwhat failed?`), sidecar('u1', 1)];
    expect(extractFirstUserMessage(branch)).toBe('what failed?');
    expect(newestUniquePrompts(branch)).toEqual(['what failed?']);
  });
});
