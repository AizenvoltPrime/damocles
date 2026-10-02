import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { limitMcpContent, MCP_OUTPUT_MAX_BYTES, removeSavedMcpOutputs, saveMcpOutputToTempFile, truncateMiddle } from '../content';
import type { ContentBlock } from '../types';

const written: string[] = [];
afterEach(() => {
  for (const path of written.splice(0)) rmSync(path, { force: true });
});

describe('truncateMiddle (pi port)', () => {
  it('leaves text within the limit untouched', () => {
    expect(truncateMiddle('a\nb\n', 10)).toEqual({ content: 'a\nb\n', truncated: false, removedChars: 0, totalBytes: 4, totalLines: 2 });
  });

  it('keeps the head and the tail and names how much it cut', () => {
    const result = truncateMiddle('0123456789', 4);
    expect(result).toEqual({ content: '01…6 chars truncated…89', truncated: true, removedChars: 6, totalBytes: 10, totalLines: 1 });
  });

  it('never splits a multi-byte character', () => {
    const result = truncateMiddle('ααααα', 5);
    expect(result.content).toBe('α…3 chars truncated…α');
    expect(result.content).not.toContain('\uFFFD');
  });
});

describe('limitMcpContent', () => {
  it('passes a result within 20 KB through unchanged', async () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'x'.repeat(MCP_OUTPUT_MAX_BYTES) }];
    await expect(limitMcpContent(content, () => Promise.reject(new Error('must not save')))).resolves.toEqual({ content });
  });

  it('cuts a long result in the middle, saves the full text, and names the file in the result', async () => {
    const full = `HEAD\n${'m'.repeat(MCP_OUTPUT_MAX_BYTES * 2)}\nTAIL`;
    const saved: string[] = [];
    const image: ContentBlock = { type: 'image', data: 'aGk=', mimeType: 'image/png' };

    const { content, fullOutputPath } = await limitMcpContent([{ type: 'text', text: full }, image], async (text) => {
      saved.push(text);
      return '/tmp/damocles-mcp-0123456789abcdef.txt';
    });

    expect(saved).toEqual([full]);
    expect(fullOutputPath).toBe('/tmp/damocles-mcp-0123456789abcdef.txt');
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual(image);
    const text = (content[0] as { text: string }).text;
    expect(text.startsWith('Warning: truncated output (original token count: ')).toBe(true);
    expect(text).toContain('Total output lines: 3');
    expect(text).toContain('HEAD');
    expect(text).toContain('TAIL');
    expect(text).toContain('chars truncated');
    expect(text).toContain('[Full output: /tmp/damocles-mcp-0123456789abcdef.txt (read it with offset/limit)]');
    expect(Buffer.byteLength(text)).toBeLessThan(MCP_OUTPUT_MAX_BYTES + 512);
  });

  it('joins every text block before measuring, as pi does', async () => {
    const half = 'y'.repeat(MCP_OUTPUT_MAX_BYTES / 2 + 10);
    const saved: string[] = [];
    await limitMcpContent([{ type: 'text', text: half }, { type: 'text', text: half }], async (text) => {
      saved.push(text);
      return 'p';
    });
    expect(saved).toEqual([`${half}\n${half}`]);
  });

  it('still cuts the text when the file cannot be written, and says so', async () => {
    const { content, fullOutputPath } = await limitMcpContent([{ type: 'text', text: 'z'.repeat(MCP_OUTPUT_MAX_BYTES + 1) }], async () => {
      throw new Error('disk full');
    });
    expect(fullOutputPath).toBeUndefined();
    expect((content[0] as { text: string }).text).toContain('[Could not save the full output: disk full]');
  });

  it('writes the full text where Read can open it, under an unguessable name', async () => {
    const full = `start ${'q'.repeat(MCP_OUTPUT_MAX_BYTES * 2)} end`;
    const { fullOutputPath } = await limitMcpContent([{ type: 'text', text: full }]);
    written.push(fullOutputPath!);

    expect(dirname(fullOutputPath!)).toBe(tmpdir());
    expect(basename(fullOutputPath!)).toMatch(/^damocles-mcp-[0-9a-f]{16}\.txt$/);
    expect(readFileSync(fullOutputPath!, 'utf-8')).toBe(full);
  });

  it.skipIf(process.platform === 'win32')('makes the saved file readable by the user only', async () => {
    const path = await saveMcpOutputToTempFile('private');
    written.push(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('gives every saved file its own name', async () => {
    const [a, b] = await Promise.all([saveMcpOutputToTempFile('a'), saveMcpOutputToTempFile('b')]);
    written.push(a, b);
    expect(a).not.toBe(b);
  });

  it('removes every saved full-output file when the runtime shuts down', async () => {
    const { fullOutputPath } = await limitMcpContent([{ type: 'text', text: 'r'.repeat(MCP_OUTPUT_MAX_BYTES + 1) }]);
    const direct = await saveMcpOutputToTempFile('direct');
    written.push(fullOutputPath!, direct);

    await removeSavedMcpOutputs();

    expect(existsSync(fullOutputPath!)).toBe(false);
    expect(existsSync(direct)).toBe(false);
  });
});
