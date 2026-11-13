import { describe, expect, it } from 'vitest';
import { CI_LOG_LIMITS, CiLogParser, rowText, type CiLogKind, type CiLogRow } from '../ci-log';

const ESC = '\u001b';

function parse(text: string, chunks?: readonly number[], kind: CiLogKind = 'gitlab'): CiLogParser {
  const parser = new CiLogParser(kind);
  if (!chunks) {
    parser.push(text);
  } else {
    let at = 0;
    for (const size of chunks) {
      parser.push(text.slice(at, at + size));
      at += size;
    }
    parser.push(text.slice(at));
  }
  parser.end();
  return parser;
}

const plain = (parser: CiLogParser): string[] => parser.rows.map(rowText);

// GitLab's own trace shape: markers, \r, an erase sequence and the header on one line
const GITLAB_LOG = [
  `${ESC}[0KRunning with gitlab-runner 17.9.0`,
  `${ESC}[0Ksection_start:1746349920:prepare_executor[collapsed=true]\r${ESC}[0K${ESC}[36;1mPreparing the "docker" executor${ESC}[0;m`,
  'Using Docker executor with image node:22 ...',
  `${ESC}[0Ksection_end:1746349925:prepare_executor\r${ESC}[0K`,
  `${ESC}[0Ksection_start:1746349926:step_script\r${ESC}[0K${ESC}[36;1mExecuting "step_script" stage of the job script${ESC}[0;m`,
  '$ npm ci',
  `${ESC}[0Ksection_start:1746349927:inner\r${ESC}[0KInner`,
  'inside',
  `${ESC}[0Ksection_end:1746349930:inner\r${ESC}[0K`,
  'Progress: 10%\rProgress: 100%',
  `${ESC}[0Ksection_end:1746349990:step_script\r${ESC}[0K`,
  `${ESC}[31;1mERROR: Job failed: exit code 1${ESC}[0;m`,
].join('\n');

describe('CiLogParser', () => {
  it('reads SGR colours: palette, bright, 256-colour and truecolor, and resets', () => {
    const parser = parse([
      `${ESC}[31mred${ESC}[0m plain`,
      `${ESC}[1;92mbright${ESC}[22;39m done`,
      `${ESC}[38;5;208morange${ESC}[48;5;244mgrey bg${ESC}[38;5;3myellow`,
      `${ESC}[0m${ESC}[38;2;10;20;30mtrue${ESC}[48;2;1;2;3mboth${ESC}[m end`,
      `${ESC}[3;4;7mstyled${ESC}[23;24;27mnot`,
    ].join('\n'));
    const [first, second, third, fourth, fifth] = parser.rows;
    expect(first!.spans).toEqual([{ text: 'red', fg: { palette: 1 } }, { text: ' plain' }]);
    expect(second!.spans).toEqual([{ text: 'bright', fg: { palette: 10 }, bold: true }, { text: ' done' }]);
    expect(third!.spans).toEqual([
      { text: 'orange', fg: { rgb: [255, 102, 0] } },
      { text: 'grey bg', fg: { rgb: [255, 102, 0] }, bg: { rgb: [133, 133, 133] } },
      { text: 'yellow', fg: { palette: 3 }, bg: { rgb: [133, 133, 133] } },
    ]);
    expect(fourth!.spans).toEqual([{ text: 'true', fg: { rgb: [10, 20, 30] } }, { text: 'both', fg: { rgb: [10, 20, 30] }, bg: { rgb: [1, 2, 3] } }, { text: ' end' }]);
    expect(fifth!.spans).toEqual([{ text: 'styled', italic: true, underline: true, inverse: true }, { text: 'not' }]);
  });

  it('reads the colon form of extended colours and ignores other sub-parameters', () => {
    const parser = parse(`${ESC}[38:2::1:2:3mcs${ESC}[38:2:4:5:6mno${ESC}[48:5:9;4:3mbg`);
    expect(parser.rows[0]!.spans).toEqual([
      { text: 'cs', fg: { rgb: [1, 2, 3] } },
      { text: 'no', fg: { rgb: [4, 5, 6] } },
      { text: 'bg', fg: { rgb: [4, 5, 6] }, bg: { palette: 9 }, underline: true },
    ]);
  });

  it('titles a GitLab section with no header text by its key', () => {
    expect(parse('section_start:1:bare_key\r\nx').sections[0]!.title).toBe('bare_key');
  });

  it('carries the style across lines, as a terminal does', () => {
    const parser = parse(`${ESC}[32mgreen\nstill green${ESC}[0m\nplain`);
    expect(parser.rows.map((row) => row.spans)).toEqual([[{ text: 'green', fg: { palette: 2 } }], [{ text: 'still green', fg: { palette: 2 } }], [{ text: 'plain' }]]);
  });

  it('lets a \\r overwrite what came before it on the line', () => {
    expect(plain(parse('Progress: 10%\rProgress: 55%\rProgress: 100%\nnext\r\nkept\r'))).toEqual(['Progress: 100%', 'next', 'kept']);
  });

  it('reads GitLab sections: nesting, [collapsed=true], durations, header stamps; marker-only lines show nothing', () => {
    const parser = parse(GITLAB_LOG);
    expect(plain(parser)).toEqual([
      'Running with gitlab-runner 17.9.0',
      'Preparing the "docker" executor',
      'Using Docker executor with image node:22 ...',
      'Executing "step_script" stage of the job script',
      '$ npm ci',
      'Inner',
      'inside',
      'Progress: 100%',
      'ERROR: Job failed: exit code 1',
    ]);
    expect(parser.sections).toEqual([
      expect.objectContaining({ id: 0, title: 'Preparing the "docker" executor', depth: 0, headerRow: 1, endRow: 2, collapsed: true, durationSeconds: 5 }),
      expect.objectContaining({ id: 1, title: 'Executing "step_script" stage of the job script', depth: 0, headerRow: 3, endRow: 7, collapsed: false, durationSeconds: 64 }),
      expect.objectContaining({ id: 2, title: 'Inner', parent: 1, depth: 1, headerRow: 5, endRow: 6, collapsed: false, durationSeconds: 3 }),
    ]);
    expect(parser.rows[1]).toMatchObject({ header: 0, section: 0, timestamp: '2025-05-04T09:12:00.000Z' });
    expect(parser.rows[1]!.spans).toEqual([{ text: 'Preparing the "docker" executor', fg: { palette: 6 }, bold: true }]);
    expect(parser.rows[2]).toMatchObject({ section: 0 });
    expect(parser.rows[2]!.header).toBeUndefined();
    expect(parser.rows[6]).toMatchObject({ section: 2 });
    expect(parser.rows[7]).toMatchObject({ section: 1 });
    expect(parser.rows[8]!.section).toBeUndefined();
    expect(parser.rows.map((row) => row.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('closes inner sections with a mismatched section_end and ignores an unknown one', () => {
    const parser = parse([
      'section_start:10:outer\r\u001b[0KOuter',
      'section_start:11:inner\r\u001b[0KInner',
      'a',
      'section_end:12:nosuch\r\u001b[0K',
      'b',
      'section_end:20:outer\r\u001b[0K',
      'after',
    ].join('\n'));
    expect(plain(parser)).toEqual(['Outer', 'Inner', 'a', 'b', 'after']);
    expect(parser.sections[0]).toMatchObject({ endRow: 3, durationSeconds: 10 });
    expect(parser.sections[1]).toMatchObject({ endRow: 3 });
    expect(parser.sections[1]!.durationSeconds).toBeUndefined();
    expect(parser.rows[4]!.section).toBeUndefined();
  });

  it('keeps a section open until end(), which closes it at the last row', () => {
    const parser = new CiLogParser('gitlab');
    parser.push('section_start:1:s\r\u001b[0KTitle\nline\n');
    expect(parser.sections[0]!.endRow).toBeUndefined();
    parser.end();
    expect(parser.sections[0]!.endRow).toBe(1);
  });

  it('reads GitHub groups with per-line stamps and their durations', () => {
    const parser = parse([
      '2026-05-04T09:12:30.0000000Z ##[group]Run npm ci',
      '2026-05-04T09:12:30.1000000Z npm ci',
      '2026-05-04T09:12:42.0000000Z added 812 packages',
      '2026-05-04T09:12:42.5000000Z ##[endgroup]',
      `2026-05-04T09:12:43.0000000Z ${ESC}[31mfailed${ESC}[0m`,
    ].join('\n'), undefined, 'github');
    expect(plain(parser)).toEqual(['Run npm ci', 'npm ci', 'added 812 packages', 'failed']);
    expect(parser.sections).toEqual([expect.objectContaining({ id: 0, title: 'Run npm ci', name: 'Run npm ci', headerRow: 0, endRow: 2, durationSeconds: 13 })]);
    expect(parser.rows[0]).toMatchObject({ header: 0, section: 0, timestamp: '2026-05-04T09:12:30.0000000Z' });
    expect(parser.rows[3]!.section).toBeUndefined();
    expect(parser.rows[3]!.timestamp).toBe('2026-05-04T09:12:43.0000000Z');
  });

  it("reads GitHub's error, warning and notice commands as the row's level", () => {
    const parser = parse([
      `2026-05-04T09:12:30.0000000Z ##[error]${ESC}[31mProcess completed with exit code 1.`,
      '2026-05-04T09:12:31.0000000Z ##[warning]Node.js 16 actions are deprecated.',
      '2026-05-04T09:12:32.0000000Z ##[notice]Cache restored',
      '2026-05-04T09:12:33.0000000Z ##[debug]kept as written',
    ].join('\n'), undefined, 'github');
    expect(parser.rows.map((row) => [row.level, rowText(row)])).toEqual([
      ['error', 'Process completed with exit code 1.'],
      ['warning', 'Node.js 16 actions are deprecated.'],
      ['notice', 'Cache restored'],
      [undefined, '##[debug]kept as written'],
    ]);
    expect(parser.rows[0]!.spans).toEqual([{ text: 'Process completed with exit code 1.', fg: { palette: 1 } }]);
    expect(plain(parse('##[error]not a workflow command here'))).toEqual(['##[error]not a workflow command here']);
  });

  it('reads GitLab runner stamps and joins a + continuation to its line', () => {
    const parser = parse([
      '2026-05-04T09:12:30.123456Z 00O $ npm ci',
      '2026-05-04T09:12:31.000000Z 01E+ (continued)',
      '2026-05-04T09:12:32.000000Z 00O next',
    ].join('\n'));
    expect(plain(parser)).toEqual(['$ npm ci (continued)', 'next']);
    expect(parser.rows[0]!.timestamp).toBe('2026-05-04T09:12:30.123456Z');
  });

  it("reads each server's stamps only on that server's log", () => {
    const github = '2026-05-04T09:12:30.0000000Z started';
    const gitlab = '2026-05-04T09:12:30.123456Z 00O $ npm ci';
    expect(parse(github).rows[0]).toEqual({ line: 1, spans: [{ text: github }] });
    const stamped = parse(gitlab, undefined, 'github').rows[0]!;
    expect([rowText(stamped), stamped.timestamp]).toEqual(['00O $ npm ci', '2026-05-04T09:12:30.123456Z']);
    expect(parse(`${gitlab}\n2026-05-04T09:12:31.000000Z 00O+ more`, undefined, 'github').rows).toHaveLength(2);
  });

  it('peeks at the held lines as end() would add them, without adding them', () => {
    const parser = new CiLogParser('gitlab');
    parser.push(`2026-05-04T09:12:30.000000Z 00O ${ESC}[32m$ npm ci\n2026-05-04T09:12:31.000000Z 00O+ --quiet`);
    expect(parser.rows).toEqual([]);
    const peeked = (): readonly CiLogRow[] => parser.peekHeld();
    expect(peeked()).toEqual([{ line: 1, spans: [{ text: '$ npm ci --quiet', fg: { palette: 2 } }], timestamp: '2026-05-04T09:12:30.000000Z' }]);
    parser.push('\n2026-05-04T09:12:32.000000Z 00O next\n2026-05-04T09:12:33.000000Z 00O par');
    expect(plain(parser)).toEqual(['$ npm ci --quiet']);
    expect(peeked().map((row) => [row.line, rowText(row)])).toEqual([[2, 'next'], [3, 'par']]);
    expect(peeked()[0]!.spans).toEqual([{ text: 'next', fg: { palette: 2 } }]);
    parser.end();
    expect(plain(parser)).toEqual(['$ npm ci --quiet', 'next', 'par']);
    expect(parser.peekHeld()).toEqual([]);
  });

  it('peeks at a partial line inside an open section and leaves the sections alone', () => {
    const parser = new CiLogParser('gitlab');
    parser.push('section_start:1:s\r\u001b[0KTitle\nhalf');
    expect(parser.peekHeld()).toEqual([{ line: 2, spans: [{ text: 'half' }], section: 0 }]);
    parser.push('\nsection_end:2:s\r\u001b[0K\nsection_start:3:t\r');
    expect(parser.peekHeld()).toEqual([]);
    expect(parser.sections).toHaveLength(1);
  });

  it('hands each row to its sink and keeps none', () => {
    const rows: CiLogRow[] = [];
    const parser = new CiLogParser('gitlab', (row) => rows.push(row));
    parser.push(`${GITLAB_LOG}\n`);
    parser.end();
    expect(parser.rows).toEqual([]);
    expect(rows).toEqual(parse(GITLAB_LOG).rows);
    expect(parser.sections).toEqual(parse(GITLAB_LOG).sections);
  });

  it('parses the same whatever the chunk boundaries, inside escape sequences, markers and \\r\\n', () => {
    const text = `${GITLAB_LOG}\n2026-05-04T09:12:30.0000000Z ##[group]G\n${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\\r\n${ESC}[38;2;1;2;3mtc`;
    const whole = parse(text);
    for (let size = 1; size <= 7; size++) {
      const chunks = Array.from({ length: Math.ceil(text.length / size) }, () => size);
      const split = parse(text, chunks);
      expect(split.rows).toEqual(whole.rows);
      expect(split.sections).toEqual(whole.sections);
    }
    for (let cut = 0; cut < text.length; cut++) {
      const split = parse(text, [cut]);
      expect(split.rows).toEqual(whole.rows);
    }
  });

  it('holds a partial last line until its newline or end()', () => {
    const parser = new CiLogParser('gitlab');
    parser.push('one\ntw');
    expect(plain(parser)).toEqual(['one']);
    parser.push('o\nthr');
    expect(plain(parser)).toEqual(['one', 'two']);
    parser.end();
    expect(plain(parser)).toEqual(['one', 'two', 'thr']);
    expect(() => parser.push('more')).toThrow();
  });

  it('drops OSC titles and links, other escapes and control characters', () => {
    const parser = parse(`${ESC}]0;title${ESC}\\a${ESC}]8;;u\u0007b${ESC}[2Kc${ESC}7d${ESC}(B\u0008e\tf`);
    expect(plain(parser)).toEqual(['abcde\tf']);
  });

  it('bounds a row\'s characters and spans', () => {
    const long = parse('x'.repeat(CI_LOG_LIMITS.rowChars + 500));
    expect(rowText(long.rows[0]!).length).toBe(CI_LOG_LIMITS.rowChars);
    const colourful = parse(Array.from({ length: CI_LOG_LIMITS.spansPerRow + 50 }, (_, at) => `${ESC}[3${at % 2}mx`).join(''));
    expect(colourful.rows[0]!.spans.length).toBe(CI_LOG_LIMITS.spansPerRow);
    expect(rowText(colourful.rows[0]!).length).toBe(CI_LOG_LIMITS.spansPerRow + 50);
  });

  describe('hostile input', () => {
    // Each case is about 1e6 characters; a quadratic scan would take minutes, a linear one well under the budget.
    const BUDGET_MS = 3000;
    const timed = (text: string): { readonly parser: CiLogParser; readonly ms: number } => {
      const started = performance.now();
      const parser = parse(text);
      return { parser, ms: performance.now() - started };
    };

    it('1e6 unterminated CSI introducers', () => {
      const { parser, ms } = timed(`${ESC}[`.repeat(500_000));
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(parser.rows).toHaveLength(1);
    });

    it('an unterminated OSC on a long line', () => {
      const { parser, ms } = timed(`a${ESC}]0;${'t'.repeat(1_000_000)}\nafter`);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(plain(parser)).toEqual(['a', 'after']);
    });

    it('a huge SGR parameter list', () => {
      const { parser, ms } = timed(`${ESC}[${'1;'.repeat(100_000)}mtext`);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(parser.rows[0]!.spans).toEqual([{ text: 'text' }]);
    });

    it('deeply nested sections', () => {
      const starts = Array.from({ length: 20_000 }, (_, at) => `section_start:1:s${at}\r\u001b[0KS${at}`).join('\n');
      const ends = Array.from({ length: 20_000 }, (_, at) => `section_end:2:s${19_999 - at}\r\u001b[0K`).join('\n');
      const { parser, ms } = timed(`${starts}\n${ends}`);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(parser.sections).toHaveLength(CI_LOG_LIMITS.sectionDepth);
      expect(parser.sections.every((section) => section.endRow !== undefined)).toBe(true);
    });

    it('many mismatched section_end markers', () => {
      const { ms } = timed(`section_start:1:a\r\u001b[0KA\n${'section_end:2:b\r'.repeat(60_000)}`);
      expect(ms).toBeLessThan(BUDGET_MS);
    });

    it('a line far longer than the raw bound, then the next line', () => {
      const { parser, ms } = timed(`${'y'.repeat(4 * CI_LOG_LIMITS.rawLineChars)}\nz`);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(plain(parser)).toEqual(['y'.repeat(CI_LOG_LIMITS.rowChars), 'z']);
    });

    it('a million empty lines fed in small chunks', () => {
      const parser = new CiLogParser('gitlab');
      const started = performance.now();
      for (let at = 0; at < 1000; at++) parser.push('\n'.repeat(1000));
      parser.end();
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      expect(parser.rows).toHaveLength(CI_LOG_LIMITS.rows);
    });
  });
});
