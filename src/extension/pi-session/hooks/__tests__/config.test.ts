import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const { tmpHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-hooks-home-')) };
});

vi.mock('../../../paths', () => ({ DAMOCLES_HOME_DIR: tmpHome }));

import { HooksConfigService, parseHooksFile, stripJsonComments } from '../config';

function writeGlobal(content: string): void {
  fs.writeFileSync(path.join(tmpHome, 'hooks.json'), content, 'utf-8');
}

function writeProject(root: string, content: string): void {
  const dir = path.join(root, '.damocles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks.json'), content, 'utf-8');
}

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-hooks-ws-'));
  (vscode.workspace as { isTrusted: boolean }).isTrusted = true;
  // Clean global between tests.
  fs.rmSync(path.join(tmpHome, 'hooks.json'), { force: true });
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('stripJsonComments', () => {
  it('removes // and block comments but preserves string content', () => {
    const input = '{\n  // a line comment\n  "url": "http://x/y", /* block */ "n": 1\n}';
    expect(JSON.parse(stripJsonComments(input))).toEqual({ url: 'http://x/y', n: 1 });
  });
});

describe('parseHooksFile', () => {
  it('returns {} for a missing file', () => {
    expect(parseHooksFile(path.join(workspaceRoot, 'nope.json'))).toEqual({});
  });

  it('returns {} for malformed JSON', () => {
    const p = path.join(workspaceRoot, 'bad.json');
    fs.writeFileSync(p, '{ not json', 'utf-8');
    expect(parseHooksFile(p)).toEqual({});
  });

  it('parses JSONC and drops invalid entries while keeping valid ones', () => {
    const p = path.join(workspaceRoot, 'h.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        hooks: {
          tool_call: [
            { command: 'echo ok' },
            { match: 'Bash' }, // invalid: no command — dropped
          ],
          input: 'not-an-array', // skipped entirely
        },
      }),
      'utf-8',
    );
    const result = parseHooksFile(p);
    expect(result['tool_call']).toHaveLength(1);
    expect(result['tool_call'][0].command).toBe('echo ok');
    expect(result['input']).toBeUndefined();
  });
});

describe('HooksConfigService', () => {
  it('returns global entries when only global is present', () => {
    writeGlobal(JSON.stringify({ hooks: { agent_end: [{ command: 'g' }] } }));
    const svc = new HooksConfigService(workspaceRoot);
    expect(svc.getEntries('agent_end').map((e) => e.command)).toEqual(['g']);
    svc.dispose();
  });

  it('orders global before project for the same key', () => {
    writeGlobal(JSON.stringify({ hooks: { tool_call: [{ command: 'g' }] } }));
    writeProject(workspaceRoot, JSON.stringify({ hooks: { tool_call: [{ command: 'p' }] } }));
    const svc = new HooksConfigService(workspaceRoot);
    expect(svc.getEntries('tool_call').map((e) => e.command)).toEqual(['g', 'p']);
    svc.dispose();
  });

  it('ignores the project file when the workspace is untrusted', () => {
    writeProject(workspaceRoot, JSON.stringify({ hooks: { tool_call: [{ command: 'p' }] } }));
    (vscode.workspace as { isTrusted: boolean }).isTrusted = false;
    const svc = new HooksConfigService(workspaceRoot);
    expect(svc.getEntries('tool_call')).toEqual([]);
    expect(svc.hasEntries('tool_call')).toBe(false);
    svc.dispose();
  });

  it('hasEntries reflects presence after trust gating', () => {
    writeGlobal(JSON.stringify({ hooks: { input: [{ command: 'g' }] } }));
    const svc = new HooksConfigService(workspaceRoot);
    expect(svc.hasEntries('input')).toBe(true);
    expect(svc.hasEntries('tool_result')).toBe(false);
    svc.dispose();
  });

  it('dispose() is safe to call', () => {
    const svc = new HooksConfigService(workspaceRoot);
    expect(() => svc.dispose()).not.toThrow();
  });
});
