import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { designFilesWriteBlock, designWriteBlock, type DesignScope } from '../design-write-rule';
import { designFolderOf } from '../design-paths';
import { BROWSER_PI_TOOL_NAMES, DESIGN_BROWSER_TOOL_NAMES, designBrowserAllows } from '../../pi-session/tools/browser-tools';

const windows = process.platform === 'win32';
const PROJECT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'design-rule-project-')));
const FOLDER = designFolderOf('contacts-abcd1234');
const scope: DesignScope = { folder: FOLDER, cwd: PROJECT };

const write = (filePath: string): string | undefined => designWriteBlock('Write', { file_path: filePath, content: 'x' }, scope);
const edit = (filePath: string): string | undefined => designWriteBlock('Edit', { file_path: filePath, old_string: 'a', new_string: 'b' }, scope);

const canLink = (() => {
  const probe = path.join(PROJECT, 'link-probe');
  try {
    fs.symlinkSync(PROJECT, probe, 'junction');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  fs.rmSync(FOLDER, { recursive: true, force: true });
  fs.mkdirSync(path.join(FOLDER, 'screens'), { recursive: true });
});
afterAll(() => {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.rmSync(FOLDER, { recursive: true, force: true });
});

describe('a design chat writes only its design folder (PD-4)', () => {
  it('allows design.md, screens and variants', () => {
    expect(write(path.join(FOLDER, 'design.md'))).toBeUndefined();
    expect(write(path.join(FOLDER, 'screens', 'S1-contacts.html'))).toBeUndefined();
    expect(edit(path.join(FOLDER, 'variants', 'S1-a.html'))).toBeUndefined();
  });

  it('blocks a project file, a relative path and a path that climbs out', () => {
    expect(write(path.join(PROJECT, 'src', 'app.ts'))).toMatch(/only files in its design folder/);
    expect(write('screens/S1.html')).toMatch(/only files in its design folder/);
    expect(write(path.join(FOLDER, '..', 'other-12345678', 'design.md'))).toMatch(/outside it/);
    expect(write(path.join(path.dirname(FOLDER), '.state', 'contacts-abcd1234', 'link.json'))).toMatch(/outside it/);
    expect(designWriteBlock('Write', { content: 'x' }, scope)).toMatch(/names no file/);
  });

  it('blocks every file core owns, and every other file the designer does not write (D65)', () => {
    for (const owned of ['manifest.json', 'decisions.md', 'inventory.json', 'tokens.css', 'assets/x.png', 'references/R1.png', 'feedback/F1.json', 'screens/S1.journey.json', 'screens/S1.journey.spec.ts', 'notes.txt', 'screens/a/b.html', 'screens/x.css', 'foo/bar.js']) {
      expect(write(path.join(FOLDER, ...owned.split('/')))).toMatch(/writes only design\.md, screens\/<name>\.html and files under variants\//);
    }
    expect(designWriteBlock('GenerateImage', { file_path: path.join(FOLDER, 'hero.png'), prompt: 'x' }, scope)).toMatch(/writes only design\.md/);
  });

  it('allows the designer files in any ASCII case, on every platform', () => {
    for (const designer of ['Design.MD', 'SCREENS/S1.HTML', 'Variants/A/b.png']) expect(write(path.join(FOLDER, ...designer.split('/')))).toBeUndefined();
    expect(designWriteBlock('GenerateImage', { file_path: path.join(FOLDER, 'variants', 'a', 'b.png'), prompt: 'x' }, scope)).toBeUndefined();
  });

  it('refuses a spelling a file system opens as another name: a trailing dot or space, a non-ASCII fold, a device name', () => {
    // NTFS strips a trailing dot or space; case-insensitive APFS reads `ſ` as `s`.
    for (const alias of ['tokens.css.', 'tokens.css ', 'design.md.', 'tokenſ.css', 'deſign.md', 'screens/S1.journey.jſon', 'variants/CON', 'screens/nul.html', 'variants/a/lpt1.png']) {
      expect(write(path.join(FOLDER, ...alias.split('/')))).toMatch(/writes only design\.md|outside it/);
    }
  });

  it.runIf(windows)('reads the folder and core-owned names case-blind, and a \\\\?\\ spelling as the path it names', () => {
    expect(write(path.join(FOLDER.toUpperCase(), 'design.md'))).toBeUndefined();
    expect(write(path.join(FOLDER, 'MANIFEST.JSON'))).toMatch(/writes only design\.md/);
    expect(write(`\\\\?\\${path.join(FOLDER, 'design.md')}`)).toBeUndefined();
    expect(write(`\\\\?\\${path.join(PROJECT, 'a.ts')}`)).toMatch(/only files in its design folder/);
  });

  it.runIf(canLink)('blocks a junction or link in the folder that leads into the project', () => {
    fs.symlinkSync(PROJECT, path.join(FOLDER, 'screens', 'jn'), 'junction');
    expect(write(path.join(FOLDER, 'screens', 'jn', 'evil.html'))).toMatch(/reaches outside it through a link/);
  });

  it('blocks a hard link to a project file', () => {
    const victim = path.join(PROJECT, 'victim.html');
    fs.writeFileSync(victim, 'x');
    const linked = path.join(FOLDER, 'screens', 'S1-hard.html');
    fs.linkSync(victim, linked);
    expect(write(linked)).toMatch(/outside it/);
  });

  const realHome = fs.realpathSync.native(os.homedir());
  it.runIf(realHome !== os.homedir())('accepts the folder through another spelling of the home folder, such as its 8.3 name', () => {
    expect(write(path.join(realHome, path.relative(os.homedir(), FOLDER), 'design.md'))).toBeUndefined();
  });

  it('runs only shell commands proven read-only, in every mode', () => {
    expect(designWriteBlock('Bash', { command: 'ls -la' }, scope)).toBeUndefined();
    expect(designWriteBlock('Bash', { command: 'echo x > a.txt' }, scope)).toMatch(/proven read-only/);
    expect(designWriteBlock('PowerShell', { command: 'Set-Content a.txt x' }, scope)).toMatch(/proven read-only/);
    expect(designWriteBlock('PowerShell', { command: 'Get-ChildItem' }, scope)).toBeUndefined();
  });

  it('lets the browser only look (PD-25)', () => {
    for (const name of DESIGN_BROWSER_TOOL_NAMES) expect(designWriteBlock(name, {}, scope)).toBeUndefined();
    for (const name of ['BrowserClick', 'BrowserType', 'BrowserEvaluate', 'BrowserSelect', 'BrowserFill', 'BrowserDrag', 'BrowserAct', 'BrowserUpload', 'BrowserIntercept', 'BrowserRequestInput']) {
      expect(designBrowserAllows(name)).toBe(false);
      expect(designWriteBlock(name, {}, scope)).toMatch(/only look at pages/);
    }
    expect(designWriteBlock('Read', { file_path: path.join(PROJECT, 'a.ts') }, scope)).toBeUndefined();
    const excluded = BROWSER_PI_TOOL_NAMES.filter((name) => !DESIGN_BROWSER_TOOL_NAMES.has(name)).sort();
    expect(excluded).toEqual(['BrowserAct', 'BrowserClick', 'BrowserDrag', 'BrowserEvaluate', 'BrowserFill', 'BrowserIntercept', 'BrowserRequestInput', 'BrowserSelect', 'BrowserType', 'BrowserUpload']);
    for (const name of DESIGN_BROWSER_TOOL_NAMES) expect(BROWSER_PI_TOOL_NAMES).toContain(name);
  });

  it('refuses every other spelling of a core-owned file: a stream suffix, and any case on every platform', () => {
    expect(write(path.join(FOLDER, 'inventory.json::$DATA'))).toMatch(/no ":"|writes only design\.md/);
    expect(write(path.join(FOLDER, 'tokens.css:x'))).toMatch(/no ":"|writes only design\.md/);
    expect(write(path.join(FOLDER, 'design.md:x'))).toMatch(/no ":"|writes only design\.md/);
    expect(write(path.join(FOLDER, 'assets::$INDEX_ALLOCATION', 'x.png'))).toMatch(/no ":"|writes only design\.md/);
    expect(write(path.join(FOLDER, 'Inventory.JSON'))).toMatch(/writes only design\.md/);
    expect(write(path.join(FOLDER, 'screens', 'S1.Journey.Spec.TS'))).toMatch(/writes only design\.md/);
  });

  it.runIf(canLink)('refuses a link in the folder whose target is a core-owned file of the folder', () => {
    fs.mkdirSync(path.join(FOLDER, 'variants'), { recursive: true });
    fs.symlinkSync(FOLDER, path.join(FOLDER, 'variants', 'up'), 'junction');
    expect(write(path.join(FOLDER, 'variants', 'up', 'manifest.json'))).toMatch(/writes only design\.md/);
    expect(write(path.join(FOLDER, 'variants', 'up', 'design.md'))).toBeUndefined();
  });

  it('runs nothing and writes nothing for a chat whose design role cannot be read, and lets it read', () => {
    const unreadable: DesignScope = { unreadable: true };
    for (const [tool, input] of [
      ['Write', { file_path: path.join(FOLDER, 'design.md'), content: 'x' }],
      ['Edit', { file_path: path.join(PROJECT, 'a.ts'), old_string: 'a', new_string: 'b' }],
      ['GenerateImage', { file_path: path.join(FOLDER, 'variants', 'a.png'), prompt: 'x' }],
      ['Bash', { command: 'ls -la' }],
      ['PowerShell', { command: 'Get-ChildItem' }],
      ['FinishDesign', {}],
      ['StartDesign', {}],
      ['BrowserClick', { ref: 'e1' }],
      ['mcp__figma__post_comment', {}],
    ] as const) {
      expect(designWriteBlock(tool, input, unreadable)).toMatch(/design role cannot be read/);
    }
    expect(designWriteBlock('mcp__figma__get_file', {}, unreadable, true)).toBeUndefined();
    expect(designWriteBlock('Read', { file_path: path.join(PROJECT, 'a.ts') }, unreadable)).toBeUndefined();
    expect(designWriteBlock('Grep', { pattern: 'x' }, unreadable)).toBeUndefined();
    for (const name of DESIGN_BROWSER_TOOL_NAMES) expect(designWriteBlock(name, {}, unreadable)).toBeUndefined();
  });

  it('keeps every chat\'s write tools to the designer files of the designs folder, resolving a path as the tools do (D65)', () => {
    const designs = path.dirname(FOLDER);
    expect(designFilesWriteBlock({ file_path: path.join(FOLDER, 'design.md') }, PROJECT)).toBeUndefined();
    expect(designFilesWriteBlock({ file_path: path.join(PROJECT, 'src', 'a.ts') }, PROJECT)).toBeUndefined();
    expect(designFilesWriteBlock({ file_path: path.join('.state', 'contacts-abcd1234', 'link.json') }, designs)).toMatch(/is in the designs folder/);
    expect(designFilesWriteBlock({ file_path: 'manifest.json' }, FOLDER)).toMatch(/StartDesign, Inventory, ExtractTokens/);
    expect(designFilesWriteBlock({ file_path: `~/${path.relative(os.homedir(), path.join(FOLDER, 'tokens.css')).split(path.sep).join('/')}` }, PROJECT)).toMatch(/is in the designs folder/);
    expect(designFilesWriteBlock({ file_path: path.join(FOLDER, 'tokenſ.css') }, PROJECT)).toMatch(/is in the designs folder/);
  });

  it.runIf(canLink)('judges every chat\'s write through a link by each of its paths that lies in the designs folder', () => {
    const designs = path.dirname(FOLDER);
    const state = path.join(designs, '.state', 'contacts-abcd1234');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(path.join(FOLDER, 'variants'), { recursive: true });
    const intoDesign = path.join(PROJECT, 'jn');
    fs.symlinkSync(FOLDER, intoDesign, 'junction');
    fs.symlinkSync(state, path.join(FOLDER, 'variants', 'st'), 'junction');
    fs.symlinkSync(PROJECT, path.join(FOLDER, 'variants', 'proj'), 'junction');
    try {
      expect(designFilesWriteBlock({ file_path: path.join(intoDesign, 'manifest.json') }, PROJECT)).toMatch(/is in the designs folder/);
      expect(designFilesWriteBlock({ file_path: path.join(intoDesign, 'design.md') }, PROJECT)).toBeUndefined();
      expect(designFilesWriteBlock({ file_path: path.join(FOLDER, 'variants', 'st', 'link.json') }, PROJECT)).toMatch(/is in the designs folder/);
      expect(designFilesWriteBlock({ file_path: path.join(FOLDER, 'variants', 'proj', 'a.ts') }, PROJECT)).toBeUndefined();
    } finally {
      fs.unlinkSync(intoDesign);
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('refuses a designer file name that is a hard link, since it shares a file another name may own', () => {
    const owned = path.join(FOLDER, 'manifest.json');
    fs.writeFileSync(owned, '{}');
    fs.mkdirSync(path.join(FOLDER, 'variants'), { recursive: true });
    fs.linkSync(owned, path.join(FOLDER, 'variants', 'm.json'));
    expect(designFilesWriteBlock({ file_path: path.join(FOLDER, 'variants', 'm.json') }, PROJECT)).toMatch(/is in the designs folder/);
  });

  it('blocks Bash when its shell is one the read-only check cannot read', () => {
    expect(designWriteBlock('Bash', { command: 'ls' }, { ...scope, shellPath: '/usr/bin/fish' })).toMatch(/cannot read/);
    expect(designWriteBlock('Bash', { command: 'ls' }, { ...scope, shellPath: '/bin/bash' })).toBeUndefined();
  });
});
