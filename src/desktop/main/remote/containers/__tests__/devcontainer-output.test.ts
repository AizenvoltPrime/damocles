import { describe, expect, it } from 'vitest';
import { MAX_BUILD_LOG_LINES } from '../../../../preload/overlay-channels';
import { BuildLogBuffer, displayLines, logEntryLines, parseReadConfiguration, parseUpResult } from '../devcontainer-output';

const ID = '28f4e6f33d7eb0c2fa0a1a525fdb39d5ef72c206dbca3f397ed48e8b10aa3a24';
const entry = (fields: Record<string, unknown>): string => JSON.stringify({ timestamp: 1, ...fields });

describe('the build log lines', () => {
  it('keeps raw output and info text, and leaves out the debug and trace lines the CLI logs for every docker call', () => {
    expect(logEntryLines(entry({ type: 'raw', level: 3, text: '\u001b[1mRunning the initializeCommand from devcontainer.json...\u001b[0m\r\n\r\n' }))).toEqual(['Running the initializeCommand from devcontainer.json...']);
    expect(logEntryLines(entry({ type: 'start', level: 3, text: 'Run: docker run --sig-proxy=false' }))).toEqual(['Run: docker run --sig-proxy=false']);
    expect(logEntryLines(entry({ type: 'text', level: 3, text: '@devcontainers/cli 0.90.0.' }))).toEqual(['@devcontainers/cli 0.90.0.']);
    expect(logEntryLines(entry({ type: 'start', level: 2, text: 'Run: docker buildx version' }))).toEqual([]);
    expect(logEntryLines(entry({ type: 'text', level: 1, text: 'workspace root: /x' }))).toEqual([]);
    expect(logEntryLines(entry({ type: 'stop', level: 3, text: 'Run: x', startTimestamp: 0 }))).toEqual([]);
    expect(logEntryLines(entry({ type: 'progress', name: 'pull' }))).toEqual([]);
  });

  it('drops terminal escapes, OSC titles and control characters, and splits carriage returns into lines', () => {
    expect(displayLines('\u001b[?25l\u001b[2J\u001b[m\u001b[Hinit-ran\r\n\u001b]0;C:\\cmd.exe\u0007\u001b[?25h')).toEqual(['init-ran']);
    expect(displayLines('#5 10%\r#5 50%\r#5 done\n')).toEqual(['#5 10%', '#5 50%', '#5 done']);
    expect(displayLines('a\u202Eb\u0000c\u2028d')).toEqual(['abcd']);
    expect(logEntryLines('Error: unknown argument --nope')).toEqual(['Error: unknown argument --nope']);
    // plain text that parses as JSON but is no object is shown as text
    expect(logEntryLines('42')).toEqual(['42']);
    expect(logEntryLines('"x"')).toEqual(['"x"']);
    expect(logEntryLines('[1,2]')).toEqual(['[1,2]']);
    expect(logEntryLines('null')).toEqual(['null']);
  });

  it('joins lines split across chunks, keeps the newest lines and counts every one', () => {
    const log = new BuildLogBuffer();
    const line = entry({ type: 'raw', level: 3, text: 'step one\n' });
    expect(log.push(line.slice(0, 10))).toBe(false);
    expect(log.push(`${line.slice(10)}\n`)).toBe(true);
    expect(log.snapshot()).toEqual({ lines: ['step one'], total: 1 });
    for (let n = 0; n < MAX_BUILD_LOG_LINES + 5; n++) log.push(`${entry({ type: 'raw', level: 3, text: `#${n}\n` })}\n`);
    const { lines, total } = log.snapshot();
    expect(total).toBe(MAX_BUILD_LOG_LINES + 6);
    expect(lines).toHaveLength(MAX_BUILD_LOG_LINES);
    expect(lines.at(-1)).toBe(`#${MAX_BUILD_LOG_LINES + 4}`);
    expect(log.push(entry({ type: 'raw', level: 3, text: 'tail' }))).toBe(false);
    expect(log.end()).toBe(true);
    expect(log.snapshot().lines.at(-1)).toBe('tail');
  });
});

describe("devcontainer up's result", () => {
  it('takes the last stdout line and checks the container id, user and workspace folder', () => {
    const stdout = `noise\n${JSON.stringify({ outcome: 'success', containerId: ID, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app', ociAuthDiagnostics: {} })}\n`;
    expect(parseUpResult(stdout, 0)).toEqual({ ok: true, up: { containerId: ID, remoteUser: 'node', remoteWorkspaceFolder: '/workspaces/app' } });
  });

  it("refuses an id, user or folder that could reach a command line as something else", () => {
    const up = (fields: Record<string, unknown>): string => JSON.stringify({ outcome: 'success', containerId: ID, remoteUser: 'node', remoteWorkspaceFolder: '/w', ...fields });
    for (const bad of [{ containerId: '--privileged' }, { containerId: 'ABC' }, { remoteUser: '-uroot' }, { remoteUser: 'a b' }, { remoteWorkspaceFolder: 'relative' }, { remoteWorkspaceFolder: '/w/../etc' }, { remoteWorkspaceFolder: '/w\nx' }]) {
      expect(parseUpResult(up(bad), 0).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("shows the CLI's own message and description for an error, cleaned and bounded", () => {
    const stdout = JSON.stringify({ outcome: 'error', message: 'Command failed: docker build', description: '\u001b[31mAn error occurred building the image.\u001b[0m' });
    expect(parseUpResult(stdout, 1)).toEqual({ ok: false, message: 'Command failed: docker build: An error occurred building the image.' });
    expect(parseUpResult(JSON.stringify({ outcome: 'error', message: 'x'.repeat(2000) }), 1)).toEqual({ ok: false, message: 'x'.repeat(500) });
    expect(parseUpResult('', 1)).toEqual({ ok: false, message: 'devcontainer up exited with 1 and printed no result' });
  });
});

describe("devcontainer read-configuration's result", () => {
  it('hands the result object on, and refuses an error or a failed exit', () => {
    const resolved = { configuration: { image: 'node' }, mergedConfiguration: { privileged: false } };
    expect(parseReadConfiguration(`${JSON.stringify(resolved)}\n`, 0)).toEqual({ ok: true, resolved });
    expect(parseReadConfiguration(JSON.stringify({ outcome: 'error', message: 'Dev container config (/x) not found.' }), 1)).toEqual({ ok: false, message: 'Dev container config (/x) not found.' });
    expect(parseReadConfiguration(JSON.stringify(resolved), 1)).toEqual({ ok: false, message: 'devcontainer read-configuration exited with 1' });
  });
});
