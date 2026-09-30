import { describe, it, expect } from 'vitest';
import { substituteVars, substituteCommand, type SubstitutionContext } from '../substitute';

const ctx: SubstitutionContext = {
  workspaceFolder: '/home/u/project',
  userHome: '/home/u',
  env: { FOO: 'bar', EMPTY: '' },
};

describe('substituteVars', () => {
  it('expands ${workspaceFolder}', () => {
    expect(substituteVars('${workspaceFolder}/.damocles/x.py', ctx)).toBe('/home/u/project/.damocles/x.py');
  });

  it('expands ${workspaceFolderBasename}', () => {
    expect(substituteVars('${workspaceFolderBasename}', ctx)).toBe('project');
  });

  it('expands ${userHome}', () => {
    expect(substituteVars('${userHome}/.damocles', ctx)).toBe('/home/u/.damocles');
  });

  it('expands ${env:NAME}', () => {
    expect(substituteVars('x=${env:FOO}', ctx)).toBe('x=bar');
  });

  it('expands bare $NAME', () => {
    expect(substituteVars('$FOO', ctx)).toBe('bar');
  });

  it('resolves a missing env var to empty string (no crash)', () => {
    expect(substituteVars('${env:MISSING}', ctx)).toBe('');
    expect(substituteVars('$MISSING', ctx)).toBe('');
  });

  it('leaves shell positionals like $1 untouched', () => {
    expect(substituteVars('echo $1', ctx)).toBe('echo $1');
  });

  it('substituteCommand preserves the argv form', () => {
    const out = substituteCommand(['uv', 'run', '${workspaceFolder}/h.py'], ctx);
    expect(out).toEqual(['uv', 'run', '/home/u/project/h.py']);
  });

  it('substituteCommand preserves the string form', () => {
    expect(substituteCommand('cat ${userHome}/f', ctx)).toBe('cat /home/u/f');
  });
});
