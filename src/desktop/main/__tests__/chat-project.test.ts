import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FolderTargetEntry } from '../../core-protocol';
import { chatProjectKey } from '../chat-project';

const target = (key: string, ownerKey?: string): FolderTargetEntry => ({
  key,
  fsPath: path.resolve(`/projects/${key}`),
  name: key,
  label: key,
  projectScope: true,
  ...(ownerKey !== undefined ? { ownerKey } : {}),
});

// What core last reported: projects alpha and its worktree w; alpha is the default.
const reported = new Map([['alpha', target('alpha')], ['w', target('w', 'alpha')]]);
const client = {
  projectOf: (key: string) => {
    const found = reported.get(key);
    return found?.ownerKey !== undefined ? reported.get(found.ownerKey) : found;
  },
  defaultTarget: () => reported.get('alpha'),
};
const listed = (key: string): boolean => ['alpha', 'plain'].includes(key);

describe('chatProjectKey', () => {
  it("names the project core reports for the chat's folder, a worktree's own project included", () => {
    expect(chatProjectKey('alpha', client, listed)).toBe('alpha');
    expect(chatProjectKey('w', client, listed)).toBe('alpha');
  });

  // Main's project list leads core's report of it back; another project's chat would be remembered as this one's.
  it('names a listed project core has not reported yet, not the default target', () => {
    expect(chatProjectKey('plain', client, listed)).toBe('plain');
  });

  it('names the default target for a folder that left the project list', () => {
    expect(chatProjectKey('removed', client, listed)).toBe('alpha');
  });
});
