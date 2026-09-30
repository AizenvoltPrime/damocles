import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ImageBlock } from '../../../shared/types/content';
import type { ToolResultOwner } from '../../../shared/types/session';
import { initPiLoader } from '../pi-loader';
import { toImageBlocks } from '../branch-text';
import { findAgentFile, indexTeamMemberFiles, subagentsDir, teamMembersDir } from '../agent-records';
import { ensurePiSessionDir } from './session-dir';
import { resolvePiSessionFile } from './reading';

/**
 * The images of the `toolResult` entry for `toolCallId` in one pi session file (`[]` for a failed result), or
 * null when the file holds no such entry. Streams the file, parsing only lines that contain the JSON-encoded id.
 */
export async function findToolResultImagesInFile(path: string, toolCallId: string): Promise<ImageBlock[] | null> {
  const pi = await initPiLoader();
  if (!pi) throw new Error('The pi runtime is unavailable, so tool result images cannot be read.');
  const needle = JSON.stringify(toolCallId);
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(needle)) continue;
      for (const entry of pi.parseSessionEntries(line)) {
        if (entry.type !== 'message') continue;
        const message = (entry as { message?: { role?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown } }).message;
        if (message?.role === 'toolResult' && message.toolCallId === toolCallId) return message.isError === true ? [] : toImageBlocks(message.content);
      }
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** The images a tool call's stored result carries; `[]` when its session file or the result is absent. */
export async function loadToolResultImages(
  cwd: string,
  sessionId: string,
  toolCallId: string,
  owner: ToolResultOwner,
): Promise<ImageBlock[]> {
  switch (owner.kind) {
    case 'session': {
      const file = await resolvePiSessionFile(cwd, sessionId);
      return file ? ((await findToolResultImagesInFile(file, toolCallId)) ?? []) : [];
    }
    case 'subagent': {
      // A resume appends to the launch file, so one file holds every call the agent made.
      const file = await findAgentFile(subagentsDir(ensurePiSessionDir(cwd), sessionId), owner.agentId);
      return file ? ((await findToolResultImagesInFile(file, toolCallId)) ?? []) : [];
    }
    case 'team': {
      const files = (await indexTeamMemberFiles(teamMembersDir(ensurePiSessionDir(cwd), sessionId, owner.teamId))).get(owner.agentId) ?? [];
      for (const { path } of [...files].reverse()) {
        const images = await findToolResultImagesInFile(path, toolCallId);
        if (images) return images;
      }
      return [];
    }
  }
}
