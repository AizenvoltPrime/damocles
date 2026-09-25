import { isImageBlock, type ImageBlock, type UserContentBlock } from '@shared/types/content';

export interface SteerRequest {
  agentId: string;
  message: string;
  images: ImageBlock[];
}

export type SteerCommand =
  | { kind: 'none' }
  | { kind: 'usage' }
  | { kind: 'elements' }
  | ({ kind: 'steer' } & SteerRequest);

/** ChatInput puts the typed text last, so any other text block is a browser element attachment. */
export function parseSteerCommand(content: string | UserContentBlock[]): SteerCommand {
  const typed = typeof content === 'string' ? content : content[content.length - 1];
  const text = typeof typed === 'string' ? typed : typed?.type === 'text' ? typed.text : undefined;
  const trimmed = text?.trim();
  if (!trimmed || !/^\/steer\b/.test(trimmed)) return { kind: 'none' };

  const blocks = typeof content === 'string' ? [] : content;
  if (blocks.some((block) => block !== typed && block.type === 'text')) return { kind: 'elements' };

  const match = trimmed.match(/^\/steer\s+(\S+)(?:\s+(.*))?$/s);
  const message = (match?.[2] ?? '').trim();
  const images = blocks.filter(isImageBlock);
  if (!match || (!message && !images.length)) return { kind: 'usage' };
  return { kind: 'steer', agentId: match[1]!, message, images };
}
