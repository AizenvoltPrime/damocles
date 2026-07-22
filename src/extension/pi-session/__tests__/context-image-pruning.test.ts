import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { pruneStaleImages } from '../context-image-pruning';

const PLACEHOLDER =
  '[Image removed: an older screenshot was pruned to keep the request within provider size limits. Capture a fresh screenshot (BrowserScreenshot) or re-read the file if this content is still needed.]';

/** A tool-result message carrying `n` image blocks plus a trailing text block. */
function toolResult(id: string, imageCount: number, text = `result ${id}`): AgentMessage {
  const images = Array.from({ length: imageCount }, (_, i) => ({
    type: 'image' as const,
    data: `${id}-img-${i}`,
    mimeType: 'image/png',
  }));
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'BrowserScreenshot',
    content: [...images, { type: 'text' as const, text }],
    isError: false,
    timestamp: 0,
  };
}

/** One tool-result message per image, oldest first. */
function toolResultsWithImages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => toolResult(`t${i}`, 1));
}

/** Count image blocks across all toolResult messages. */
function imageCount(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.role === 'toolResult') for (const b of m.content) if (b.type === 'image') n++;
  return n;
}

describe('pruneStaleImages — boundary policy', () => {
  it('≤6 images: prunedCount 0 and every element keeps reference identity', () => {
    const input = toolResultsWithImages(6);
    const { messages, prunedCount } = pruneStaleImages(input);
    expect(prunedCount).toBe(0);
    input.forEach((m, i) => expect(messages[i]).toBe(m));
  });

  it('7 images: oldest 3 replaced by the exact placeholder; images 3–6 intact', () => {
    const input = toolResultsWithImages(7);
    const { messages, prunedCount } = pruneStaleImages(input);
    expect(prunedCount).toBe(3);
    // First 3 pruned → the single content block is now the constant placeholder text.
    for (let i = 0; i < 3; i++) {
      expect(messages[i]).not.toBe(input[i]);
      const block = (messages[i] as { content: { type: string; text?: string }[] }).content[0];
      expect(block).toEqual({ type: 'text', text: PLACEHOLDER });
    }
    // Images 3..6 kept verbatim, same references.
    for (let i = 3; i < 7; i++) expect(messages[i]).toBe(input[i]);
    expect(imageCount(messages)).toBe(4);
  });

  it('preserves text blocks inside pruned tool results', () => {
    // A single tool result with 7 images + a text block → boundary 3, first 3 images pruned, text kept.
    const input: AgentMessage[] = [toolResult('multi', 7, 'keep me')];
    const { messages, prunedCount } = pruneStaleImages(input);
    expect(prunedCount).toBe(3);
    const content = (messages[0] as { content: { type: string; text?: string }[] }).content;
    expect(content.filter((b) => b.type === 'text' && b.text === PLACEHOLDER)).toHaveLength(3);
    expect(content.filter((b) => b.type === 'image')).toHaveLength(4);
    expect(content[content.length - 1]).toEqual({ type: 'text', text: 'keep me' });
  });

  it('9 images: boundary still 3 (byte-stable between triggers)', () => {
    const at7 = pruneStaleImages(toolResultsWithImages(7));
    const at9 = pruneStaleImages(toolResultsWithImages(9));
    expect(at7.prunedCount).toBe(3);
    expect(at9.prunedCount).toBe(3);
    // Same first-3 pruned at both sizes.
    for (let i = 0; i < 3; i++) {
      expect((at9.messages[i] as { content: { text?: string }[] }).content[0].text).toBe(PLACEHOLDER);
    }
    expect(imageCount(at9.messages)).toBe(6);
  });

  it('10 images: boundary jumps to 6', () => {
    const { prunedCount, messages } = pruneStaleImages(toolResultsWithImages(10));
    expect(prunedCount).toBe(6);
    expect(imageCount(messages)).toBe(4);
  });

  it('counts multiple image blocks in one tool result individually (boundary can split a message)', () => {
    // 4 images in the first message, 4 in the second → T=8 → boundary 3: first message's images
    // 0,1,2 pruned, image 3 kept; second message untouched.
    const first = toolResult('a', 4);
    const second = toolResult('b', 4);
    const { messages, prunedCount } = pruneStaleImages([first, second]);
    expect(prunedCount).toBe(3);
    const firstContent = (messages[0] as { content: { type: string; text?: string }[] }).content;
    expect(firstContent.slice(0, 3).every((b) => b.type === 'text' && b.text === PLACEHOLDER)).toBe(true);
    expect(firstContent[3].type).toBe('image');
    expect(messages[1]).toBe(second);
  });

  it('never counts or prunes user/assistant/custom message images', () => {
    const input: AgentMessage[] = [
      { role: 'user', content: [{ type: 'image', data: 'u', mimeType: 'image/png' }, { type: 'text', text: 'hi' }], timestamp: 0 },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic', provider: 'anthropic', model: 'm', usage: {} as never, stopReason: 'stop', timestamp: 0 },
      { role: 'custom', content: 'note', timestamp: 0 } as unknown as AgentMessage,
      ...toolResultsWithImages(7),
    ];
    const { messages, prunedCount } = pruneStaleImages(input);
    // Only the 7 toolResult images count toward T → boundary 3; the user image is untouched.
    expect(prunedCount).toBe(3);
    expect(messages[0]).toBe(input[0]);
    expect(messages[1]).toBe(input[1]);
    expect(messages[2]).toBe(input[2]);
  });

  it('does not mutate the input array or message objects', () => {
    const input = toolResultsWithImages(7);
    const snapshot = JSON.parse(JSON.stringify(input));
    input.forEach((m) => Object.freeze((m as { content: unknown }).content) && Object.freeze(m));
    pruneStaleImages(input);
    expect(input).toEqual(snapshot);
  });

  it('acceptance scale: 64 images → B=60, 4 kept, 60 constant placeholders', () => {
    const input = toolResultsWithImages(64);
    const { messages, prunedCount } = pruneStaleImages(input);
    expect(prunedCount).toBe(60);
    expect(imageCount(messages)).toBe(4);
    const placeholders = messages.filter(
      (m) => m.role === 'toolResult' && m.content.some((b) => b.type === 'text' && b.text === PLACEHOLDER),
    );
    expect(placeholders).toHaveLength(60);
  });
});
