// Writes src/core/design/skills.generated.ts from design-skills/*.md (PD-32), so no package reads a resource at runtime.
//   node scripts/generate-design-skills.ts   (npm run generate:design-skills)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isEntryPoint } from './entry-point.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_FILE = path.join(ROOT, 'src', 'core', 'design', 'skills.generated.ts');
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_HINT_CHARS = 400;
const KEYS = new Set(['name', 'title', 'description', 'validationHints']);
const HINT_KEYS = new Set(['rule', 'severity', 'text']);

interface ValidationHint {
  readonly rule: string;
  readonly severity: 'error' | 'warning';
  readonly text: string;
}

interface Skill {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly validationHints: readonly ValidationHint[];
  readonly body: string;
}

export interface RenderedDesignSkills {
  readonly text: string;
  readonly count: number;
}

/** The rule ids design-check.ts implements for skill hints. */
export function skillRuleIds(root = ROOT): readonly string[] {
  return JSON.parse(fs.readFileSync(path.join(root, 'src', 'core', 'design', 'skill-rules.json'), 'utf8')) as readonly string[];
}

function fail(file: string, message: string): never {
  throw new Error(`design-skills/${file}: ${message}`);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function parseSkill(file: string, raw: string, rules: readonly string[]): Skill {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const frontmatter = match?.[1];
  const content = match?.[2];
  if (frontmatter === undefined || content === undefined) fail(file, 'must start with --- frontmatter ---');
  const data: unknown = parseYaml(frontmatter, { maxAliasCount: 0 });
  if (!isObject(data) || Array.isArray(data)) fail(file, 'the frontmatter must be a mapping');
  for (const key of Object.keys(data)) if (!KEYS.has(key)) fail(file, `unknown frontmatter key ${key}`);
  const { name, title, description } = data;
  if (typeof name !== 'string' || !NAME.test(name)) fail(file, 'name must be lower-case words joined by hyphens');
  if (typeof title !== 'string' || title.trim() === '') fail(file, 'title is required');
  if (typeof description !== 'string' || description.trim() === '') fail(file, 'description is required');
  const hints: unknown = data.validationHints ?? [];
  if (!Array.isArray(hints)) fail(file, 'validationHints must be a list');
  const hintList: readonly unknown[] = hints;
  const validationHints = hintList.map((hint, index): ValidationHint => {
    if (!isObject(hint)) fail(file, `validationHints[${index}] must be {rule, severity, text}`);
    for (const key of Object.keys(hint)) if (!HINT_KEYS.has(key)) fail(file, `validationHints[${index}] has an unknown key ${key}`);
    const { rule, text } = hint;
    if (typeof rule !== 'string' || !rules.includes(rule)) fail(file, `validationHints[${index}].rule ${JSON.stringify(rule)} is not a rule design-check.ts implements (${rules.join(', ')})`);
    const severity = hint.severity ?? 'warning';
    if (severity !== 'error' && severity !== 'warning') fail(file, `validationHints[${index}].severity must be error or warning`);
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_HINT_CHARS) fail(file, `validationHints[${index}].text must be 1 to ${MAX_HINT_CHARS} characters`);
    return { rule, severity, text: text.trim() };
  });
  const body = content.trim();
  if (body === '') fail(file, 'the body is empty');
  return { name, title: title.trim(), description: description.trim(), validationHints, body };
}

/** The generated module's text from `<root>/design-skills`. Throws on a skill that must not ship. */
export function renderDesignSkills(root = ROOT): RenderedDesignSkills {
  const dir = path.join(root, 'design-skills');
  const rules = skillRuleIds(root);
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.md')).sort();
  const seen = new Set<string>();
  const skills = files.map((file) => {
    // A Windows checkout with core.autocrlf holds the sources with CRLF; the output must not depend on it.
    const skill = parseSkill(file, fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n'), rules);
    if (seen.has(skill.name)) fail(file, `duplicate skill name ${skill.name}`);
    seen.add(skill.name);
    return skill;
  });
  if (skills.length === 0) throw new Error('design-skills/ holds no skill');
  // A /*! legal comment, which esbuild keeps in the bundles; a // header would be stripped.
  const notice = fs.readFileSync(path.join(dir, 'NOTICE'), 'utf8').replace(/\r\n/g, '\n').trim().split('\n').map((line) => (line === '' ? ' *' : ` * ${line}`)).join('\n');
  const entries = skills.map((skill) => `  {
    name: ${JSON.stringify(skill.name)},
    title: ${JSON.stringify(skill.title)},
    description: ${JSON.stringify(skill.description)},
    validationHints: [${skill.validationHints.map((hint) => `\n      { rule: ${JSON.stringify(hint.rule)}, severity: ${JSON.stringify(hint.severity)}, text: ${JSON.stringify(hint.text)} },`).join('')}${skill.validationHints.length > 0 ? '\n    ' : ''}],
    body: ${JSON.stringify(skill.body)},
  },`).join('\n');
  const text = `// AUTO-GENERATED from design-skills/*.md; do not edit. Run: npm run generate:design-skills

/*!
${notice}
 */

import type { DesignSkill } from './skills';

export const DESIGN_SKILLS: readonly DesignSkill[] = [
${entries}
];
`;
  return { text, count: skills.length };
}

if (isEntryPoint(import.meta.url)) {
  try {
    const { text, count } = renderDesignSkills();
    fs.writeFileSync(OUTPUT_FILE, text, 'utf8');
    console.log(`Generated ${OUTPUT_FILE} with ${count} design skills`);
  } catch (err) {
    console.error('ERROR: design skill generation failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
