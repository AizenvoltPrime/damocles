import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { TerminalAttachmentInput } from '../../../../shared/types/terminal-attachment';
import { formatIdeContextBlock } from '../../../../shared/ide-context';
import { formatTerminalAttachmentBlock } from '../../../terminal-attachment';
import { reconstructMessages } from '../history-loader';
import { extractFirstUserMessage, newestUniquePrompts } from '../metadata';
import { extractTerminalAttachmentCounts } from '../terminal-attachments';
import { DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY } from '../constants';

const output: TerminalAttachmentInput = { source: 'command', commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', text: 'FAIL a.test.ts', omittedLines: 0 };
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
      { id: 'u1:0', source: 'command', commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', lineCount: 1, omittedLines: 0, preview: 'FAIL a.test.ts' },
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

  it('keeps the wrapper out of the session preview and the prompt history', () => {
    const branch = [user('u1', `${block}\nwhat failed?`), sidecar('u1', 1)];
    expect(extractFirstUserMessage(branch)).toBe('what failed?');
    expect(newestUniquePrompts(branch)).toEqual(['what failed?']);
  });
});
