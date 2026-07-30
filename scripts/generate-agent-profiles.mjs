import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const PROFILES_DIR = path.resolve('agent-profiles');
const OUTPUT_FILE = path.resolve('src/extension/team/agent-profiles.generated.ts');

const IDENTITY_PATTERN = /^(identity|role|role\s*definition|identity\s*(and|&)\s*(role|memory)|your\s*identity)/i;
const MISSION_PATTERN = /^(core\s*mission|your\s*core\s*mission|mission|brand\s*mission|your\s*core\s*beliefs|your\s*core\s*responsibilities|core\s*competencies|competencies)/i;
const RULES_PATTERN = /^(critical\s*rules|rules|guardrails|non[- ]negotiable\s*rules|rules\s*of\s*engagement|your\s*mandatory\s*process)/i;

function stripEmoji(text) {
  return text
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\u2764\u2600-\u26ff\u2700-\u27bf]+\s*/u, '')
    .replace(/^:[a-z_]+:\s*/i, '')
    .replace(/^[^a-zA-Z]+/, '')
    .trim();
}

function extractSections(content) {
  const sections = content.split(/^#{1,2}\s+/m);
  const result = { identity: '', mission: '', rules: '' };
  const found = new Set();

  for (const section of sections) {
    if (!section.trim()) continue;

    const newlineIdx = section.indexOf('\n');
    if (newlineIdx === -1) continue;

    const rawHeader = section.slice(0, newlineIdx).trim();
    const header = stripEmoji(rawHeader).toLowerCase();
    const body = section.slice(newlineIdx + 1).trim();

    if (!found.has('identity') && IDENTITY_PATTERN.test(header)) {
      result.identity = body;
      found.add('identity');
    } else if (!found.has('mission') && MISSION_PATTERN.test(header)) {
      result.mission = body;
      found.add('mission');
    } else if (!found.has('rules') && RULES_PATTERN.test(header)) {
      result.rules = body;
      found.add('rules');
    }
  }

  return result;
}

function inferCategory(relPath) {
  const firstDir = relPath.split(/[/\\]/)[0];
  return firstDir
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function deriveId(filename) {
  return path.basename(filename, '.md');
}

function collectMdFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

function escapeForTs(str) {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

// The catalog ships in the team system prompt, so descriptions are capped rather than sent whole — the
// full text stays available on the profile itself. The cap is a budget, not a sentence boundary: cut on
// whitespace so a word is never split, and mark the elision so a truncated description cannot be read
// as a complete one.
const CATALOG_DESCRIPTION_LIMIT = 180;

function catalogDescription(description) {
  if (!description) return '';
  if (description.length <= CATALOG_DESCRIPTION_LIMIT) return description;
  const head = description.slice(0, CATALOG_DESCRIPTION_LIMIT);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s,;:—-]+$/, '')}…`;
}

function main() {
  const files = collectMdFiles(PROFILES_DIR);
  console.log(`Found ${files.length} .md files in ${PROFILES_DIR}`);

  const profiles = [];
  const seenIds = new Map();
  let warnings = 0;

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf-8');

    if (!raw.startsWith('---')) {
      continue;
    }

    let parsed;
    try {
      parsed = matter(raw);
    } catch {
      console.warn(`  WARN: Failed to parse frontmatter: ${filePath}`);
      warnings++;
      continue;
    }

    const { data, content } = parsed;
    if (!data.name) {
      continue;
    }

    const relPath = path.relative(PROFILES_DIR, filePath);
    const id = deriveId(path.basename(filePath));

    // Two profiles resolving to one ID means one of them silently vanishes from the catalog. Since IDs
    // are the handle `team_spawn_specialist` resolves, that is a wrong-agent-spawned bug, not a warning.
    if (seenIds.has(id)) {
      console.error(`ERROR: Duplicate profile ID "${id}"`);
      console.error(`  ${seenIds.get(id)}`);
      console.error(`  ${relPath}`);
      console.error('Profile IDs derive from the filename and must be unique across all divisions.');
      process.exit(1);
    }
    seenIds.set(id, relPath);

    const category = inferCategory(relPath);
    const sections = extractSections(content);

    const missingSections = [];
    if (!sections.identity) missingSections.push('Identity');
    if (!sections.mission) missingSections.push('Mission');
    if (!sections.rules) missingSections.push('Rules');
    if (missingSections.length > 0) {
      console.warn(`  WARN: ${relPath} missing sections: ${missingSections.join(', ')}`);
      warnings++;
    }

    profiles.push({
      id,
      name: data.name,
      description: data.description ?? '',
      category,
      emoji: data.emoji ?? '',
      vibe: data.vibe ?? '',
      identity: sections.identity,
      mission: sections.mission,
      rules: sections.rules,
    });
  }

  if (profiles.length === 0) {
    console.error('ERROR: No valid profiles found. Ensure agent-profiles/ contains .md files with YAML frontmatter.');
    process.exit(1);
  }

  profiles.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const catalogLines = ['Available specialist profiles (use the profile ID with the `profile` parameter on `team_spawn_specialist`):\n'];
  const byCategory = new Map();
  for (const p of profiles) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(p);
  }
  for (const [category, items] of byCategory) {
    catalogLines.push(`**${category}** (${items.length})`);
    for (const p of items) {
      const desc = catalogDescription(p.description);
      const vibe = p.vibe ? ` [${p.vibe}]` : '';
      catalogLines.push(`- ${p.id} — ${p.emoji} ${p.name}: ${desc}${vibe}`);
    }
    catalogLines.push('');
  }
  const catalog = catalogLines.join('\n').trim();

  const profileEntries = profiles.map(p => {
    return `  {
    id: \`${escapeForTs(p.id)}\`,
    name: \`${escapeForTs(p.name)}\`,
    description: \`${escapeForTs(p.description)}\`,
    category: \`${escapeForTs(p.category)}\`,
    emoji: \`${escapeForTs(p.emoji)}\`,
    vibe: \`${escapeForTs(p.vibe)}\`,
    identity: \`${escapeForTs(p.identity)}\`,
    mission: \`${escapeForTs(p.mission)}\`,
    rules: \`${escapeForTs(p.rules)}\`,
  }`;
  });

  const output = `// AUTO-GENERATED — do not edit manually.
// Run: npm run generate:profiles

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  category: string;
  emoji: string;
  vibe: string;
  identity: string;
  mission: string;
  rules: string;
}

export const AGENT_PROFILES: readonly AgentProfile[] = [
${profileEntries.join(',\n')},
] as const;

export const AGENT_PROFILE_MAP: ReadonlyMap<string, AgentProfile> = new Map(
  AGENT_PROFILES.map((p: AgentProfile): [string, AgentProfile] => [p.id, p]),
);

export const AGENT_PROFILE_CATALOG: string = \`${escapeForTs(catalog)}\`;
`;

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, output, 'utf-8');

  console.log(`\nGenerated ${OUTPUT_FILE}`);
  console.log(`  Profiles: ${profiles.length}`);
  console.log(`  Categories: ${byCategory.size}`);
  console.log(`  Warnings: ${warnings}`);
}

try {
  main();
} catch (err) {
  console.error('ERROR: Profile generation failed:', err);
  process.exit(1);
}
