import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { PromptTemplate } from '@earendil-works/pi-coding-agent';

const H = vi.hoisted(() => ({ home: '' }));

// User asset dirs resolve through `os.homedir()`; a temp home keeps the developer's own `~/.claude` out.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { installFakePlatform } from '../../../__mocks__/fake-platform';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader } from '../pi-loader';
import { resolveSlashInvocation } from '../slash-invocation';
import { discoverCommands, toPromptTemplate } from '../../assets';

const PI_PROMPT_TEMPLATES = path.resolve(__dirname, '../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js');
const stripFrontmatter = (content: string): string => content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
const folderLinkType = process.platform === 'win32' ? 'junction' : 'dir';

describe('commands handed to a real pi loader', () => {
  const made: string[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    H.home = '';
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('holds a command behind a linked namespace folder as gs:pickup, expands it, and follows a rename-over of its target', async () => {
    const fake = installFakePlatform();
    H.home = tempDir('asset-parity-home-');
    const workspace = tempDir('asset-parity-ws-');
    const agentDir = tempDir('asset-parity-agent-');
    const clone = tempDir('asset-parity-clone-');
    const target = path.join(clone, 'commands', 'pickup.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '---\ndescription: pick up an issue\nargument-hint: <issue>\n---\nPick up issue $1.\n');
    fs.mkdirSync(path.join(H.home, '.claude', 'commands'), { recursive: true });
    fs.symlinkSync(path.join(clone, 'commands'), path.join(H.home, '.claude', 'commands', 'gs'), folderLinkType);

    const folder = await PiRuntime.get(agentDir).folder(workspace);
    const loader = folder.services.resourceLoader;
    const session = { extensionRunner: { getCommand: () => undefined }, resourceLoader: loader } as unknown as Parameters<typeof resolveSlashInvocation>[0];

    expect(loader.getPrompts().prompts.find((prompt) => prompt.name === 'gs:pickup')).toMatchObject({
      description: 'pick up an issue',
      argumentHint: '<issue>',
      filePath: path.join(H.home, '.claude', 'commands', 'gs', 'pickup.md'),
      sourceInfo: { source: 'claude', scope: 'user' },
    });
    expect(resolveSlashInvocation(session, '/gs:pickup 42', stripFrontmatter)).toEqual({ kind: 'expanded', text: 'Pick up issue 42.' });

    // git writes a file beside the target and renames it over, which only the watch on the target's folder sees
    fs.writeFileSync(`${target}.tmp`, '---\ndescription: pick up an issue\n---\nTake issue $1.\n');
    fs.renameSync(`${target}.tmp`, target);
    await vi.waitFor(() => fake.fileWatchers.watcher(path.dirname(target), '*.md'));
    fake.fileWatchers.watcher(path.dirname(target), '*.md').fireChange(target);

    await vi.waitFor(() => expect(resolveSlashInvocation(session, '/gs:pickup 42', stripFrontmatter)).toEqual({ kind: 'expanded', text: 'Take issue 42.' }), { timeout: 5_000 });
  }, 60_000);

  it('builds a top-level command exactly as pi\'s own loadPromptTemplates does', async () => {
    const pi = await initPiLoader();
    if (!pi) throw new Error('pi failed to load');
    const real = (await import(pathToFileURL(PI_PROMPT_TEMPLATES).href)) as {
      loadPromptTemplates: (options: { cwd: string; agentDir: string; promptPaths: string[]; includeDefaults: boolean }) => { templates: PromptTemplate[] };
    };
    H.home = tempDir('asset-parity-home-');
    const commands = path.join(H.home, '.claude', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    fs.writeFileSync(path.join(commands, 'described.md'), '---\ndescription: from frontmatter\nargument-hint: <a> <b>\n---\nBody $1.\n');
    fs.writeFileSync(path.join(commands, 'firstline.md'), `\n${'x'.repeat(80)}\nmore\n`);
    fs.writeFileSync(path.join(commands, 'short.md'), 'Short line.\n');
    fs.writeFileSync(path.join(commands, 'hint.md'), '---\nargument-hint: 3\n---\nNumbered hint.\n');

    const { commands: found } = await discoverCommands({ workspacePath: null, homeDir: H.home, trusted: true, parseFrontmatter: pi.parseFrontmatter, log: () => undefined });
    const ours = found.map((command) => toPromptTemplate(command, pi.createSyntheticSourceInfo));
    const theirs = real.loadPromptTemplates({ cwd: H.home, agentDir: H.home, promptPaths: [commands], includeDefaults: false }).templates;

    const shape = (template: PromptTemplate) => ({ name: template.name, description: template.description, argumentHint: template.argumentHint, content: template.content, filePath: template.filePath });
    expect(ours.map(shape).sort((a, b) => a.name.localeCompare(b.name))).toEqual(theirs.map(shape).sort((a, b) => a.name.localeCompare(b.name)));
  });
});
