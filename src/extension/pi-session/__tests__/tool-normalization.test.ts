import { describe, it, expect } from 'vitest';
import { mapPiToolName, normalizeToolInput, denormalizeToolInput, normalizeToolDetails, toolCategory } from '../tool-normalization';

describe('mapPiToolName', () => {
  it('maps pi built-ins + extension tools to Damocles display names; identity for unknown', () => {
    expect(mapPiToolName('read')).toBe('Read');
    expect(mapPiToolName('grep')).toBe('Grep');
    expect(mapPiToolName('find')).toBe('Glob');
    expect(mapPiToolName('ls')).toBe('Ls');
    expect(mapPiToolName('bash')).toBe('Bash');
    expect(mapPiToolName('write')).toBe('Write');
    expect(mapPiToolName('edit')).toBe('Edit');
    expect(mapPiToolName('Edit')).toBe('Edit');
    expect(mapPiToolName('WebSearch')).toBe('WebSearch');
    expect(mapPiToolName('WebFetch')).toBe('WebFetch');
    expect(mapPiToolName('CodeSearch')).toBe('CodeSearch');
  });
});

describe('normalizeToolInput', () => {
  it('rewrites read/write path → file_path and grep ignoreCase → -i', () => {
    expect(normalizeToolInput('read', { path: '/a.ts' })).toEqual({ file_path: '/a.ts' });
    expect(normalizeToolInput('write', { path: '/a.ts', content: 'x' })).toEqual({ file_path: '/a.ts', content: 'x' });
    expect(normalizeToolInput('grep', { pattern: 'x', ignoreCase: true })).toEqual({ pattern: 'x', '-i': true });
  });

  it('leaves find/ls and already-CC-shaped input untouched', () => {
    expect(normalizeToolInput('find', { pattern: '*.ts', path: '/src' })).toEqual({ pattern: '*.ts', path: '/src' });
    expect(normalizeToolInput('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' })).toEqual({
      file_path: '/a',
      old_string: 'a',
      new_string: 'b',
    });
  });
});

describe('denormalizeToolInput', () => {
  it('reverses read/write file_path → path and grep -i → ignoreCase', () => {
    expect(denormalizeToolInput('read', { file_path: '/a.ts' })).toEqual({ path: '/a.ts' });
    expect(denormalizeToolInput('write', { file_path: '/a.ts', content: 'x' })).toEqual({ path: '/a.ts', content: 'x' });
    expect(denormalizeToolInput('grep', { pattern: 'x', '-i': true })).toEqual({ pattern: 'x', ignoreCase: true });
  });

  it('is the inverse of normalizeToolInput', () => {
    const piInput = { path: '/a.ts', limit: 5 };
    expect(denormalizeToolInput('read', normalizeToolInput('read', piInput))).toEqual(piInput);
  });

  it('leaves find/ls and Edit-shaped input untouched', () => {
    expect(denormalizeToolInput('find', { pattern: '*.ts', path: '/src' })).toEqual({ pattern: '*.ts', path: '/src' });
    expect(denormalizeToolInput('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' })).toEqual({
      file_path: '/a',
      old_string: 'a',
      new_string: 'b',
    });
  });
});

describe('normalizeToolDetails', () => {
  it('maps pi edit firstChangedLine → editLineNumber so the Edit card opens the file at the edit', () => {
    expect(normalizeToolDetails({ diff: 'd', patch: 'p', firstChangedLine: 42 })).toEqual({
      diff: 'd',
      patch: 'p',
      firstChangedLine: 42,
      editLineNumber: 42,
    });
  });

  it('passes details through untouched when firstChangedLine is absent or editLineNumber already set', () => {
    expect(normalizeToolDetails({ lines: 10 })).toEqual({ lines: 10 });
    expect(normalizeToolDetails({ firstChangedLine: 5, editLineNumber: 9 })).toEqual({ firstChangedLine: 5, editLineNumber: 9 });
  });
});

describe('toolCategory', () => {
  it('classifies read/write/shell and known extension read tools', () => {
    expect(toolCategory('Read')).toBe('read');
    expect(toolCategory('Grep')).toBe('read');
    expect(toolCategory('WebSearch')).toBe('read');
    expect(toolCategory('WebFetch')).toBe('read');
    expect(toolCategory('CodeSearch')).toBe('read');
    expect(toolCategory('Edit')).toBe('write');
    expect(toolCategory('Write')).toBe('write');
    expect(toolCategory('Bash')).toBe('shell');
    expect(toolCategory('PowerShell')).toBe('shell');
    expect(toolCategory('SomethingUnknown')).toBe('other');
  });
});
