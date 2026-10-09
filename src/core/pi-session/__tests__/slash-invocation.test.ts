import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { expandPromptTemplate, resolveSlashInvocation } from '../slash-invocation';

const PI_PROMPT_TEMPLATES = path.resolve(__dirname, '../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js');
const stripFrontmatter = (content: string): string => content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

const TEMPLATES = [
  { name: 'review', content: 'Review $1 with $2, all: $@.' },
  { name: 'fix', content: 'Fix ${1:-everything} then ${@:2} or ${@:2:1}; args ${ARGUMENTS:-none} $ARGUMENTS $9.' },
  { name: 'plain', content: 'No arguments here.' },
];

function session(options: { commands?: string[]; skills?: { name: string; filePath: string; baseDir: string }[] } = {}) {
  return {
    extensionRunner: { getCommand: (name: string) => (options.commands?.includes(name) ? { name } : undefined) },
    resourceLoader: { getPrompts: () => ({ prompts: TEMPLATES }), getSkills: () => ({ skills: options.skills ?? [] }) },
  } as unknown as Parameters<typeof resolveSlashInvocation>[0];
}

let dir: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('expandPromptTemplate', () => {
  it('expands exactly as pi does', async () => {
    const pi = (await import(pathToFileURL(PI_PROMPT_TEMPLATES).href)) as { expandPromptTemplate: (text: string, templates: unknown[]) => string };
    const inputs = [
      '/review', '/review a.ts', '/review "a b.ts" \'c d\' e', '/review a\nb', '/fix', '/fix one two three', '/fix  "" x',
      '/plain extra', '/unknown x', 'review a', ' /review a', '/', '/review\ta\u00a0b', '/fix 😀 "q😀"',
    ];
    for (const text of inputs) expect(expandPromptTemplate(text, TEMPLATES), text).toBe(pi.expandPromptTemplate(text, TEMPLATES));
  });
});

describe('resolveSlashInvocation', () => {
  it('names an extension command before any expansion, as pi checks it first', () => {
    expect(resolveSlashInvocation(session({ commands: ['review'] }), '/review a.ts', stripFrontmatter)).toEqual({ kind: 'command' });
  });

  it('expands a prompt template and leaves text pi would not change as text', () => {
    expect(resolveSlashInvocation(session(), '/review a.ts b', stripFrontmatter)).toEqual({ kind: 'expanded', text: 'Review a.ts with b, all: a.ts b.' });
    expect(resolveSlashInvocation(session(), '/unknown a', stripFrontmatter)).toEqual({ kind: 'text' });
    expect(resolveSlashInvocation(session(), 'plain words', stripFrontmatter)).toEqual({ kind: 'text' });
  });

  it('expands a skill command into pi\'s skill block, with its arguments after it', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-skill-'));
    const filePath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(filePath, '---\nname: tidy\n---\nTidy the code.\n');
    const skills = [{ name: 'tidy', filePath, baseDir: dir }];
    expect(resolveSlashInvocation(session({ skills }), '/skill:tidy src/a.ts', stripFrontmatter)).toEqual({
      kind: 'expanded',
      text: `<skill name="tidy" location="${filePath}">\nReferences are relative to ${dir}.\n\nTidy the code.\n</skill>\n\nsrc/a.ts`,
    });
    expect(resolveSlashInvocation(session({ skills }), '/skill:other', stripFrontmatter)).toEqual({ kind: 'text' });
  });
});
