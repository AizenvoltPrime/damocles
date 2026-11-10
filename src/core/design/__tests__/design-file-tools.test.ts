import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { createVsCodeFileConfinement } from '../../../vscode/platform/file-confinement';
import { AutoCheckpointProducer, folderIdFor, getFolderRepoDir } from '../../pi-session/checkpoints';
import { designFolderOf, designStateDirOf } from '../design-paths';
import type { DesignRole } from '../design-entries';
import { readManifest, updateManifest } from '../design-files';
import { createDesignChatTools, type DesignChatToolDeps } from '../tools/design-chat-tools';
import { createDesignFileTools } from '../tools/design-file-tools';
import { designRuleSetById } from '../rule-set';
import type { DesignPreviewOpening } from '../session-design';
import { clearDesigns } from './design-harness';
import { LocalizedError } from '../../../shared/localized-text';

vi.mock('../../logger', () => ({ log: vi.fn() }));

// Runs once after the next screen listing, which lets a test change the folder between a tool's checks and its write lane.
const listing = vi.hoisted(() => ({ after: undefined as (() => void) | undefined }));
vi.mock('../design-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../design-files')>();
  return {
    ...actual,
    listScreenFiles: async (folder: string) => {
      const screens = await actual.listScreenFiles(folder);
      const after = listing.after;
      listing.after = undefined;
      after?.();
      return screens;
    },
  };
});

const DESIGN = 'files-abcd1234';
const FOLDER = designFolderOf(DESIGN);
const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
type Tool = { name: string; executionMode?: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: { type: string; text: string }[]; details: unknown }> };

const role = (ruleSet: 'full' | 'reduced' = 'full'): DesignRole => ({ designId: DESIGN, folder: FOLDER, parentSessionId: 'parent-1', ruleSet, title: 'Files' });

function deps(options: { ruleSet?: 'full' | 'reduced'; cwd?: string; opening?: DesignPreviewOpening; webTools?: boolean } = {}) {
  const changed: { designId: string; paths: readonly string[] }[] = [];
  const opened: string[] = [];
  const render = { changed: (designId: string, paths: readonly string[]) => changed.push({ designId, paths }) } as unknown as DesignPreviewHost;
  const publish = vi.fn();
  const d = {
    role: () => role(options.ruleSet),
    enabled: () => true,
    cwd: options.cwd ?? FOLDER,
    confinement: createVsCodeFileConfinement(),
    branch: () => [],
    publish,
    render: () => render,
    openPreview: async (_designId: string, relPath: string) => {
      opened.push(relPath);
      return options.opening ?? { opened: true as const };
    },
    webToolsEnabled: () => options.webTools ?? true,
    webHostFilter: async () => () => false,
  } as unknown as DesignChatToolDeps;
  return { d, changed, opened, publish };
}

const fileTools = (d: DesignChatToolDeps, ruleSet: 'full' | 'reduced' = 'full'): Tool[] => createDesignFileTools(pi, d, designRuleSetById(ruleSet)) as unknown as Tool[];
const tool = (d: DesignChatToolDeps, name: string, ruleSet: 'full' | 'reduced' = 'full'): Tool => fileTools(d, ruleSet).find((candidate) => candidate.name === name)!;
const remove = (d: DesignChatToolDeps, file: string) => tool(d, 'RemoveDesignFile').execute('remove-1', { file });
const at = (...segments: string[]): string => path.join(FOLDER, ...segments);

async function designWithProbe(): Promise<void> {
  fs.mkdirSync(at('screens'), { recursive: true });
  fs.writeFileSync(at('design.md'), '# Files\n');
  fs.writeFileSync(at('tokens.css'), ':root { --space-1: 0.25rem; }\n');
  for (const name of ['S0-probe', 'S1-contacts']) {
    fs.writeFileSync(at('screens', `${name}.html`), `<html data-ds-screen="${name}"></html>`);
    fs.writeFileSync(at('screens', `${name}.journey.json`), '{}');
    fs.writeFileSync(at('screens', `${name}.journey.spec.ts`), '// spec');
  }
  await updateManifest(FOLDER, DESIGN, (current) => ({
    ...current,
    status: 'finished',
    screens: ['S0-probe', 'S1-contacts'].map((id) => ({ id, file: `screens/${id}.html`, contentHash: 'h', check: { errors: 0, warnings: [] } })),
  }));
  const checks = path.join(designStateDirOf(DESIGN), 'checks');
  fs.mkdirSync(checks, { recursive: true });
  for (const name of ['S0-probe', 'S1-contacts']) fs.writeFileSync(path.join(checks, `${name}.json`), '{"schemaVersion":1}');
}

beforeEach(clearDesigns);
afterEach(() => fs.rmSync(getFolderRepoDir(folderIdFor(FOLDER)), { recursive: true, force: true }));

describe('RemoveDesignFile (D100)', () => {
  it('is in both rule sets, and runs its batch in order', () => {
    const { d } = deps();
    for (const ruleSet of ['full', 'reduced'] as const) expect(tool(d, 'RemoveDesignFile', ruleSet).executionMode).toBe('sequential');
  });

  it('removes a screen with its journey files, manifest entry and check record, turns a finished design draft, publishes and reloads the previews (acceptance)', async () => {
    await designWithProbe();
    const { d, changed, publish } = deps();
    const result = await remove(d, 'screens/S0-probe.html');
    expect(result.details).toEqual({ file: 'screens/S0-probe.html', removed: ['screens/S0-probe.html', 'screens/S0-probe.journey.json', 'screens/S0-probe.journey.spec.ts'] });
    expect(result.content[0]!.text).toBe('Removed screens/S0-probe.html with screens/S0-probe.journey.json and screens/S0-probe.journey.spec.ts, its manifest entry and its check record.');
    for (const gone of ['S0-probe.html', 'S0-probe.journey.json', 'S0-probe.journey.spec.ts']) expect(fs.existsSync(at('screens', gone))).toBe(false);
    expect(fs.existsSync(at('screens', 'S1-contacts.journey.json'))).toBe(true);
    const manifest = await readManifest(FOLDER, DESIGN);
    expect(manifest.screens.map((screen) => screen.file)).toEqual(['screens/S1-contacts.html']);
    expect(manifest.status).toBe('draft');
    expect(fs.existsSync(path.join(designStateDirOf(DESIGN), 'checks', 'S0-probe.json'))).toBe(false);
    expect(fs.existsSync(path.join(designStateDirOf(DESIGN), 'checks', 'S1-contacts.json'))).toBe(true);
    expect(publish).toHaveBeenCalled();
    expect(changed).toEqual([{ designId: DESIGN, paths: ['screens/S0-probe.html', 'screens/S0-probe.journey.json', 'screens/S0-probe.journey.spec.ts'] }]);
  });

  it('removes a screen\'s records before the screen, so a removal that failed on the way is completed by a second call', async () => {
    await designWithProbe();
    // A folder where a journey file belongs cannot be unlinked, which stands for a file another program holds open.
    fs.rmSync(at('screens', 'S0-probe.journey.spec.ts'));
    fs.mkdirSync(at('screens', 'S0-probe.journey.spec.ts'));
    const { d } = deps();
    await expect(remove(d, 'screens/S0-probe.html')).rejects.toThrow();
    expect(fs.existsSync(at('screens', 'S0-probe.html'))).toBe(true);
    expect(fs.existsSync(at('screens', 'S0-probe.journey.json'))).toBe(false);
    fs.rmdirSync(at('screens', 'S0-probe.journey.spec.ts'));
    expect((await remove(d, 'screens/S0-probe.html')).details).toEqual({ file: 'screens/S0-probe.html', removed: ['screens/S0-probe.html'] });
    expect((await readManifest(FOLDER, DESIGN)).screens.map((screen) => screen.file)).toEqual(['screens/S1-contacts.html']);
  });

  it('names only what it removed when the page went between its check and its removal', async () => {
    await designWithProbe();
    listing.after = () => fs.rmSync(at('screens', 'S0-probe.html'));
    const { d, changed } = deps();
    const result = await remove(d, 'screens/S0-probe.html');
    expect(result.details).toEqual({ file: 'screens/S0-probe.html', removed: ['screens/S0-probe.journey.json', 'screens/S0-probe.journey.spec.ts'] });
    expect(result.content[0]!.text).toBe('screens/S0-probe.html was already gone; removed screens/S0-probe.journey.json and screens/S0-probe.journey.spec.ts, its manifest entry and its check record.');
    expect(changed).toEqual([{ designId: DESIGN, paths: ['screens/S0-probe.journey.json', 'screens/S0-probe.journey.spec.ts'] }]);
    expect((await readManifest(FOLDER, DESIGN)).screens.map((screen) => screen.file)).toEqual(['screens/S1-contacts.html']);
  });

  it('removes a shared file and a variant alone, leaving the manifest', async () => {
    await designWithProbe();
    fs.mkdirSync(at('shared'));
    fs.writeFileSync(at('shared', 'app.js'), '');
    fs.mkdirSync(at('variants', 'accent'), { recursive: true });
    fs.writeFileSync(at('variants', 'accent', 'b.html'), '<html></html>');
    const { d } = deps();
    expect((await remove(d, 'shared/app.js')).details).toEqual({ file: 'shared/app.js', removed: ['shared/app.js'] });
    expect((await remove(d, 'variants/accent/b.html')).details).toEqual({ file: 'variants/accent/b.html', removed: ['variants/accent/b.html'] });
    expect((await readManifest(FOLDER, DESIGN)).screens).toHaveLength(2);
  });

  it('refuses design.md, tokens.css and every file core writes or the designer does not, removing nothing (acceptance)', async () => {
    await designWithProbe();
    fs.mkdirSync(at('assets'));
    fs.writeFileSync(at('assets', 'logo.png'), 'png');
    const { d } = deps();
    for (const [file, reason] of [
      ['design.md', /design\.md is the design's own description/],
      ['tokens.css', /not a screen, variant or shared file/],
      ['manifest.json', /not a screen, variant or shared file/],
      ['assets/logo.png', /not a screen, variant or shared file/],
      ['screens/S0-probe.journey.json', /not a screen, variant or shared file/],
      ['screens/../tokens.css', /not a screen, variant or shared file/],
      ['../other-12345678/design.md', /not a screen, variant or shared file/],
      [at('screens', 'S0-probe.html'), /not a screen, variant or shared file/],
      ['screens/S9-missing.html', /does not exist/],
      ['shared/a/b.css', /not a screen, variant or shared file/],
    ] as const) {
      await expect(remove(d, file), file).rejects.toThrow(reason);
    }
    for (const kept of ['design.md', 'tokens.css', 'manifest.json', path.join('assets', 'logo.png'), path.join('screens', 'S0-probe.html')]) expect(fs.existsSync(at(kept))).toBe(true);
  });

  it('refuses a variant reached through a link, and a link itself', async () => {
    await designWithProbe();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'design-files-outside-'));
    fs.writeFileSync(path.join(outside, 'b.html'), 'keep');
    fs.mkdirSync(at('variants'), { recursive: true });
    try {
      fs.symlinkSync(outside, at('variants', 'jn'), 'junction');
    } catch (err) {
      // junctions are Windows only; elsewhere a directory symlink is the same link
      if ((err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EINVAL') throw err;
      fs.symlinkSync(outside, at('variants', 'jn'), 'dir');
    }
    fs.mkdirSync(at('variants', 'real'));
    fs.symlinkSync(at('variants', 'real'), at('variants', 'inner'), process.platform === 'win32' ? 'junction' : 'dir');
    const { d } = deps();
    await expect(remove(d, 'variants/jn/b.html')).rejects.toThrow(/reaches outside this design's files through a link/);
    await expect(remove(d, 'variants/jn')).rejects.toThrow(/reaches outside this design's files through a link/);
    await expect(remove(d, 'variants/inner')).rejects.toThrow(/link or not a regular file/);
    expect(fs.readFileSync(path.join(outside, 'b.html'), 'utf8')).toBe('keep');
    expect(fs.existsSync(at('variants', 'inner'))).toBe(true);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('is brought back by a rewind of the turn that removed it: the screen, its journey files and its manifest entry (acceptance)', { timeout: 60_000 }, async () => {
    await designWithProbe();
    const producer = new AutoCheckpointProducer({ sessionId: 'design-1', sessionFile: path.join(os.tmpdir(), 'design-files-design-1.jsonl'), cwd: FOLDER, capturesTracked: false, maxFileSizeBytes: () => 25 * 1024 * 1024, createTurnId: () => 'turn', now: () => new Date() });
    const started = await producer.turnStart({ userEntryId: 'u1', prompt: 'remove the probe' });
    if (!started.ok) throw new Error(started.message);
    await remove(deps().d, 'screens/S0-probe.html');
    const finalized = await producer.finalizeRun();
    if (!finalized.ok || finalized.record?.kind !== 'checkpoint') throw new Error('no checkpoint');
    const restored = await producer.restore(finalized.record);
    producer.dispose();
    if (!restored.ok) throw new Error('restore failed');
    for (const back of ['S0-probe.html', 'S0-probe.journey.json', 'S0-probe.journey.spec.ts']) expect(fs.existsSync(at('screens', back)), back).toBe(true);
    expect((await readManifest(FOLDER, DESIGN)).screens.map((screen) => screen.file)).toEqual(['screens/S0-probe.html', 'screens/S1-contacts.html']);
  });
});

describe('OpenPreview (D100)', () => {
  it('is FULL\'s only and runs its batch in order', () => {
    const { d } = deps();
    expect(fileTools(d, 'reduced').map((candidate) => candidate.name)).toEqual(['RemoveDesignFile']);
    expect(tool(d, 'OpenPreview').executionMode).toBe('sequential');
  });

  it('opens a variant page\'s preview tab in the chat, through the session (acceptance)', async () => {
    fs.mkdirSync(at('variants', 'accent'), { recursive: true });
    fs.writeFileSync(at('variants', 'accent', 'b.html'), '<html></html>');
    const { d, opened } = deps();
    const result = await tool(d, 'OpenPreview').execute('open-1', { file: 'variants/accent/b.html' });
    expect(opened).toEqual(['variants/accent/b.html']);
    expect(result.details).toEqual({ file: 'variants/accent/b.html' });
  });

  it('refuses what is no page of the design, a page that is missing, and passes on why the chat could not open it', async () => {
    fs.mkdirSync(at('screens'), { recursive: true });
    fs.writeFileSync(at('screens', 'S1.html'), '<html></html>');
    const { d, opened } = deps();
    for (const [file, reason] of [['tokens.css', /not a page of this design/], ['../x/screens/S1.html', /not a page of this design/], ['screens/S2.html', /not a readable page/]] as const) {
      await expect(tool(d, 'OpenPreview').execute('open-2', { file }), file).rejects.toThrow(reason);
    }
    expect(opened).toEqual([]);
    const away = deps({ opening: { refused: { message: 'Open the design chat to preview {0}.', args: ['screens/S1.html'] } } });
    await expect(tool(away.d, 'OpenPreview').execute('open-3', { file: 'screens/S1.html' })).rejects.toThrow('The preview of screens/S1.html did not open: Open the design chat to preview screens/S1.html.');
  });
});

describe('OpenPreview spellings (D100)', () => {
  it('opens a page only as the folder spells it and names that spelling for any other, so one page never has two tabs', async () => {
    fs.mkdirSync(at('screens'), { recursive: true });
    fs.writeFileSync(at('screens', 'S1.html'), '<html></html>');
    fs.mkdirSync(at('variants', 'Accent'), { recursive: true });
    fs.writeFileSync(at('variants', 'Accent', 'B.html'), '<html></html>');
    const { d, opened } = deps();
    for (const [file, spelled] of [
      ['SCREENS/S1.HTML', 'screens/S1.html'],
      ['screens/s1.html', 'screens/S1.html'],
      ['variants/accent/b.html', 'variants/Accent/B.html'],
      ['VARIANTS/Accent/B.html', 'variants/Accent/B.html'],
    ] as const) {
      await expect(tool(d, 'OpenPreview').execute('open-4', { file }), file).rejects.toThrow(`${file} is not spelled as this design spells it; open ${spelled}.`);
    }
    expect(opened).toEqual([]);
    await tool(d, 'OpenPreview').execute('open-5', { file: 'screens/S1.html' });
    await tool(d, 'OpenPreview').execute('open-6', { file: 'variants/Accent/B.html' });
    expect(opened).toEqual(['screens/S1.html', 'variants/Accent/B.html']);
  });
});

describe('core\'s writes reload the open previews (D100)', () => {
  it('ExtractTokens reloads them with tokens.css, and ImportAsset with the asset it wrote (acceptance)', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'design-files-project-'));
    fs.writeFileSync(path.join(project, 'app.css'), ':root { --space-1: 0.25rem; }\n');
    fs.writeFileSync(path.join(project, 'logo.png'), 'png');
    fs.mkdirSync(FOLDER, { recursive: true });
    const { d, changed } = deps({ cwd: project });
    const chat = createDesignChatTools(pi, d, designRuleSetById('full')) as unknown as Tool[];
    await chat.find((candidate) => candidate.name === 'ExtractTokens')!.execute('tokens-1', { files: ['app.css'] });
    await chat.find((candidate) => candidate.name === 'ImportAsset')!.execute('asset-1', { path: 'logo.png' });
    expect(changed).toEqual([{ designId: DESIGN, paths: ['tokens.css'] }, { designId: DESIGN, paths: ['assets/logo.png'] }]);
    const reduced = deps({ cwd: project, ruleSet: 'reduced' });
    await (createDesignChatTools(pi, reduced.d, designRuleSetById('reduced')) as unknown as Tool[]).find((candidate) => candidate.name === 'ImportAsset')!.execute('asset-2', { path: 'logo.png' });
    expect(reduced.changed).toEqual([]);
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('ImportAsset fetches no URL while Web search is off, since the chat has no WebFetch then', async () => {
    fs.mkdirSync(FOLDER, { recursive: true });
    const { d, changed } = deps({ webTools: false });
    const importAsset = (createDesignChatTools(pi, d, designRuleSetById('full')) as unknown as Tool[]).find((candidate) => candidate.name === 'ImportAsset')!;
    const refused = importAsset.execute('asset-4', { url: 'https://example.com/a.png' });
    await expect(refused).rejects.toBeInstanceOf(LocalizedError);
    await expect(refused).rejects.toThrow('ImportAsset downloads a URL only while Web search is on, since this chat could not fetch it otherwise. Turn on Web search in Settings, or import the file from a path.');
    expect(changed).toEqual([]);
  });

  it('ImportAsset takes exactly one source', async () => {
    fs.mkdirSync(FOLDER, { recursive: true });
    const { d } = deps();
    const importAsset = (createDesignChatTools(pi, d, designRuleSetById('full')) as unknown as Tool[]).find((candidate) => candidate.name === 'ImportAsset')!;
    for (const params of [{}, { path: 'a.png', url: 'https://example.com/a.png' }]) {
      await expect(importAsset.execute('asset-3', params)).rejects.toThrow('ImportAsset takes exactly one of path, file and url.');
    }
  });
});
