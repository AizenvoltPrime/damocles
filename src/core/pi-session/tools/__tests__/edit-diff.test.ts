import { execFileSync } from 'node:child_process';
import { applyPatch } from 'diff';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { generateDiffString, generateUnifiedPatch } from '@earendil-works/pi-coding-agent';
import { applyReplacementsToOriginal, editDiffWindows, firstChangedLine, normalizeToLF, type TextReplacement } from '../edit-diff';
import { windowedEditPatch } from '../../../diff/jobs';

/** The windowed patch with no time budget. */
function editPatch(path: string, content: string, newContent: string, replacements: readonly TextReplacement[]): string {
  const result = windowedEditPatch(path, editDiffWindows(content, newContent, replacements), Infinity);
  if (!('patch' in result)) throw new Error(`no patch: ${result.patchOmitted}`);
  return result.patch;
}

/** Small deterministic generator (mulberry32), using the high bits. */
function createRandom(seed: number): (max: number) => number {
  let state = seed;
  return (max) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

function applyReplacements(content: string, replacements: TextReplacement[]): string {
  let result = '';
  let position = 0;
  for (const replacement of replacements) {
    result += content.slice(position, replacement.matchIndex) + replacement.newText;
    position = replacement.matchIndex + replacement.matchLength;
  }
  return result + content.slice(position);
}

/** Random content and sorted, disjoint, non-empty replacements; `distinct` makes every line unique. */
function randomCase(random: (max: number) => number, distinct: boolean) {
  const lineCount = random(400);
  const lines = Array.from({ length: lineCount }, (_, i) => (distinct ? `line ${i}` : ['a', 'b', '', '}'][random(4)]!));
  const content = lines.join('\n') + (random(2) === 0 ? '\n' : '');
  const replacements: TextReplacement[] = [];
  let position = 0;
  const count = 1 + random(4);
  for (let i = 0; i < count && position < content.length; i++) {
    const matchIndex = position + random(Math.min(content.length - position, 300));
    if (matchIndex >= content.length) break;
    const matchLength = 1 + random(Math.min(content.length - matchIndex, 120));
    const newLines = Array.from({ length: random(4) }, (_, j) => `new ${i} ${j}`);
    const newText = random(3) === 0 ? '' : newLines.join('\n') + (random(2) === 0 ? '\n' : '');
    replacements.push({ matchIndex, matchLength, newText });
    position = matchIndex + matchLength;
  }
  return { content, replacements, newContent: applyReplacements(content, replacements) };
}

describe('firstChangedLine', () => {
  it.each([true, false])('is the first changed line of pi\'s whole-file diff (distinct lines: %s)', (distinct) => {
    const random = createRandom(distinct ? 3 : 4);
    for (let run = 0; run < 2000; run++) {
      const { content, newContent } = randomCase(random, distinct);
      expect(firstChangedLine(content, newContent), `run ${run}`).toBe(content === newContent ? undefined : generateDiffString(content, newContent).firstChangedLine);
    }
  });
});

// pi 1.5.2 `test/edit-diff-window.test.ts:54`.
describe('windowedEditPatch', () => {
  it('matches pi\'s whole-file patch when lines are distinct', () => {
    const random = createRandom(1);
    for (let run = 0; run < 2000; run++) {
      const { content, replacements, newContent } = randomCase(random, true);
      if (content === newContent) continue;
      expect(editPatch('f.txt', content, newContent, replacements), `run ${run}`).toBe(generateUnifiedPatch('f.txt', content, newContent));
    }
  });

  it('produces a patch that applies when lines repeat', () => {
    const random = createRandom(2);
    for (let run = 0; run < 2000; run++) {
      const { content, replacements, newContent } = randomCase(random, false);
      if (content === newContent) continue;
      expect(applyPatch(content, editPatch('f.txt', content, newContent, replacements)), `run ${run}`).toBe(newContent);
    }
  });

  it('handles a replacement of many lines', () => {
    const newText = 'x\n'.repeat(150000);
    const patch = editPatch('f.txt', 'a\nb\n', `${newText}b\n`, [{ matchIndex: 0, matchLength: 2, newText }]);
    expect(applyPatch('a\nb\n', patch)).toBe(`${newText}b\n`);
  });

  it('omits the patch as too large once its windows pass the time budget', () => {
    const before = Array.from({ length: 3_000 }, (_, i) => `  const value${i} = compute(${i});`).join('\n');
    const after = Array.from({ length: 3_000 }, (_, i) => `  let renamed${i} = other(${i * 7});`).join('\n');
    const windows = editDiffWindows(before, after, [{ matchIndex: 0, matchLength: before.length, newText: after }]);
    expect(windowedEditPatch('f.txt', windows, 50)).toEqual({ patchOmitted: 'tooLarge' });
  });

  it('diffs a small change in a 20 MB file with a 96 MB heap', async () => {
    // A child process, so a regression to diffing the whole file runs out of memory instead of passing; bundled, since
    // the sources' extensionless imports do not resolve under Node's own loader.
    const contents = `
      import { editDiffWindows } from "../edit-diff";
      import { windowedEditPatch } from "../../../diff/jobs";
      const filler = "x".repeat(99) + "\\n";
      const half = filler.repeat(100000);
      const base = half + "TARGET = 1\\n" + half;
      const changed = half + "TARGET = 2\\n" + half;
      const windows = editDiffWindows(base, changed, [{ matchIndex: half.length, matchLength: 10, newText: "TARGET = 2" }]);
      const { patch } = windowedEditPatch("big.txt", windows, Infinity);
      process.stdout.write(patch.split("\\n").filter((line) => /^(@@|[+-]TARGET)/.test(line)).join("\\n"));
    `;
    const bundled = await build({ stdin: { contents, resolveDir: __dirname, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
    const output = execFileSync(process.execPath, ['--max-old-space-size=96', '--input-type=module'], {
      encoding: 'utf-8',
      input: bundled.outputFiles[0]!.text,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(output).toBe('@@ -99997,9 +99997,9 @@\n-TARGET = 1\n+TARGET = 2');
  });
});

describe('many replacements on one long line', () => {
  it.each([
    ['no line ending', ''],
    ['a trailing CRLF', '\r\n'],
    ['a trailing lone CR', '\r'],
  ])('diff and splice 20 000 replacements in a 2 MB line with %s in linear time', (_label, ending) => {
    const original = `${'x'.repeat(95)}foo()`.repeat(20000) + ending;
    const content = normalizeToLF(original);
    const replacements: TextReplacement[] = [];
    for (let index = content.indexOf('foo'); index !== -1; index = content.indexOf('foo', index + 3)) {
      replacements.push({ matchIndex: index, matchLength: 3, newText: 'bar' });
    }
    const newContent = applyReplacements(content, replacements);

    const started = performance.now();
    const patch = editPatch('min.js', content, newContent, replacements);
    const written = applyReplacementsToOriginal(original, replacements);
    const elapsed = performance.now() - started;

    expect(replacements).toHaveLength(20000);
    expect(applyPatch(content, patch)).toBe(newContent);
    expect(written).toBe(original.replaceAll('foo', 'bar'));
    // Rescanning the line per replacement takes 6 to 12 s here; one pass over it takes about 10 ms.
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('applyReplacementsToOriginal', () => {
  it('equals the replacements applied to the normalized text, once normalized', () => {
    const random = createRandom(3);
    const endings = ['\n', '\r\n', '\r'];
    for (let run = 0; run < 2000; run++) {
      const { content, replacements } = randomCase(random, false);
      const original = content.replace(/\n/g, () => endings[random(3)]!);
      // A lone CR before an empty LF line reads as one CRLF, which is another normalized text.
      if (normalizeToLF(original) !== content) continue;
      expect(normalizeToLF(applyReplacementsToOriginal(original, replacements)), `run ${run}`).toBe(applyReplacements(content, replacements));
    }
  });

  it('keeps the bytes outside the replaced ranges, and gives new line breaks the ending of the line they start on', () => {
    const original = 'one\r\ntwo\nthree\r\nfour\n';
    const content = normalizeToLF(original);
    const replacements = [{ matchIndex: content.indexOf('two'), matchLength: 3, newText: '2a\n2b' }];
    expect(applyReplacementsToOriginal(original, replacements)).toBe('one\r\n2a\n2b\nthree\r\nfour\n');
    const onCrlf = [{ matchIndex: content.indexOf('three'), matchLength: 5, newText: '3a\n3b' }];
    expect(applyReplacementsToOriginal(original, onCrlf)).toBe('one\r\ntwo\n3a\r\n3b\r\nfour\n');
  });

  it('does not merge a kept lone CR with an inserted line feed into one CRLF', () => {
    const original = 'a\rb\nc\n';
    const replacements = [{ matchIndex: 2, matchLength: 1, newText: '\nB' }];
    expect(applyReplacementsToOriginal(original, replacements)).toBe('a\r\n\nB\nc\n');
  });
});
