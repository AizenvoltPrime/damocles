import { describe, it, expect, beforeAll } from 'vitest';
import { CustomAgentService } from '../CustomAgentService';
import { SlashCommandService } from '../SlashCommandService';
import { AGENT_PROFILES, AGENT_PROFILE_MAP, AGENT_PROFILE_CATALOG } from '../team/agent-profiles.generated';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: access private parsing methods on service instances
// ─────────────────────────────────────────────────────────────────────────────

interface AgentParser {
  parseAgentFile(c: string): { description: string; model?: string; tools?: string[] };
  extractFirstLine(c: string): string;
  stripMarkdownFormatting(t: string): string;
}

interface CommandParser {
  parseMarkdownFile(c: string): { description: string; argumentHint?: string };
  extractFirstLine(c: string): string;
  stripMarkdownFormatting(t: string): string;
}

let agentParser: AgentParser;
let commandParser: CommandParser;

beforeAll(() => {
  const agentSvc = new CustomAgentService('/tmp/test-workspace');
  agentParser = agentSvc as unknown as AgentParser;

  const cmdSvc = new SlashCommandService('/tmp/test-workspace');
  commandParser = cmdSvc as unknown as CommandParser;
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent profile build script patterns
// (replicated from scripts/generate-agent-profiles.mjs for unit-testing the
// regex in isolation — integration tests below verify the actual generated output)
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_PATTERN = /^(identity|role|role\s*definition|identity\s*(and|&)\s*(role|memory)|your\s*identity)/i;
const MISSION_PATTERN = /^(core\s*mission|your\s*core\s*mission|mission|brand\s*mission|your\s*core\s*beliefs|your\s*core\s*responsibilities)/i;
const RULES_PATTERN = /^(critical\s*rules|rules|guardrails|non[- ]negotiable\s*rules|rules\s*of\s*engagement|your\s*mandatory\s*process)/i;

function stripEmoji(text: string): string {
  return text
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\u2764\u2600-\u26ff\u2700-\u27bf]+\s*/u, '')
    .replace(/^:[a-z_]+:\s*/i, '')
    .replace(/^[^a-zA-Z]+/, '')
    .trim();
}

function extractSections(content: string): { identity: string; mission: string; rules: string } {
  const sections = content.split(/^#{1,2}\s+/m);
  const result = { identity: '', mission: '', rules: '' };
  const found = new Set<string>();

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

function inferCategory(relPath: string): string {
  const firstDir = relPath.split(/[/\\]/)[0] ?? '';
  return firstDir
    .split('-')
    .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function escapeForTs(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

// Skills loader frontmatter regex (from src/extension/skills/utils.ts)
const SKILL_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const SKILL_DESCRIPTION_RE = /description:\s*(.+)/;

function parseSkillDescription(text: string): string | undefined {
  const match = text.match(SKILL_FRONTMATTER_RE);
  if (match && match[1]) {
    const descMatch = match[1].match(SKILL_DESCRIPTION_RE);
    if (descMatch && descMatch[1]) {
      return descMatch[1].trim();
    }
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CustomAgentService.parseAgentFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('CustomAgentService.parseAgentFile', () => {
  describe('frontmatter parsing', () => {
    it('extracts description from frontmatter', () => {
      const content = '---\ndescription: A helpful agent\n---\nBody text here';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('A helpful agent');
    });

    it('strips single quotes from description', () => {
      const content = "---\ndescription: 'Quoted description'\n---\nBody";
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('Quoted description');
    });

    it('strips double quotes from description', () => {
      const content = '---\ndescription: "Quoted description"\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('Quoted description');
    });

    it('extracts model field', () => {
      const content = '---\ndescription: Agent\nmodel: claude-sonnet-4-5-20250514\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.model).toBe('claude-sonnet-4-5-20250514');
    });

    it('strips quotes from model', () => {
      const content = '---\nmodel: "opus"\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.model).toBe('opus');
    });

    it('extracts tools in bracket array format', () => {
      const content = '---\ndescription: Agent\ntools: [Read, Write, Bash]\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.tools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('extracts tools in bracket array with quotes', () => {
      const content = '---\ntools: ["Read", "Write"]\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.tools).toEqual(['Read', 'Write']);
    });

    it('extracts tools in comma-separated format', () => {
      const content = '---\ndescription: Agent\ntools: Read, Write, Bash\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.tools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('handles tools with extra whitespace', () => {
      const content = '---\ntools: [ Read , Write , Bash ]\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.tools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('empty bracket tools [] produces empty array', () => {
      const content = '---\ntools: []\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.tools).toEqual([]);
    });

    it('returns undefined for model when not present', () => {
      const content = '---\ndescription: Agent\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.model).toBeUndefined();
    });

    it('returns undefined for tools when not present', () => {
      const content = '---\ndescription: Agent\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.tools).toBeUndefined();
    });

    it('falls back to body first line when no frontmatter description', () => {
      const content = '---\nmodel: opus\n---\nFirst body line\nSecond line';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('First body line');
    });

    it('handles empty frontmatter', () => {
      const content = '---\n\n---\nBody text here';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('Body text here');
    });

    it('handles multiple fields in frontmatter', () => {
      const content = '---\ndescription: My Agent\nmodel: opus\ntools: [Read]\nextra: ignored\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('My Agent');
      expect(result.model).toBe('opus');
      expect(result.tools).toEqual(['Read']);
    });
  });

  describe('CRLF line ending support', () => {
    it('parses frontmatter with CRLF endings', () => {
      const content = '---\r\ndescription: CRLF test\r\n---\r\nBody text';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('CRLF test');
    });

    it('extracts model with CRLF', () => {
      const content = '---\r\nmodel: opus\r\ndescription: test\r\n---\r\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.model).toBe('opus');
    });

    it('handles mixed LF and CRLF', () => {
      const content = '---\r\ndescription: Mixed\n---\r\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('Mixed');
    });
  });

  describe('edge cases', () => {
    it('falls back to first line when no frontmatter delimiters', () => {
      const content = 'Just a plain markdown file\nWith some content';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('Just a plain markdown file');
    });

    it('skips heading lines when extracting first line', () => {
      const content = '# Heading\n## Subheading\nActual content here';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('Actual content here');
    });

    it('returns "No description" for empty content', () => {
      const result = agentParser.parseAgentFile('');
      expect(result.description).toBe('No description');
    });

    it('returns "No description" for heading-only content', () => {
      const result = agentParser.parseAgentFile('# Only headings\n## Nothing else');
      expect(result.description).toBe('No description');
    });

    it('truncates long descriptions to 100 chars (body fallback)', () => {
      const longLine = 'A'.repeat(150);
      const content = longLine;
      const result = agentParser.parseAgentFile(content);
      expect(result.description.length).toBe(100);
    });

    it('does NOT truncate frontmatter descriptions', () => {
      const longDesc = 'A'.repeat(150);
      const content = `---\ndescription: ${longDesc}\n---\nBody`;
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe(longDesc);
    });

    it('handles frontmatter without trailing newline after closing ---', () => {
      const content = '---\ndescription: test\n---';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('test');
    });

    it('handles frontmatter with trailing newline and empty body', () => {
      const content = '---\ndescription: test\n---\n';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('test');
    });

    it('handles extra --- in body without confusing frontmatter', () => {
      const content = '---\ndescription: test\n---\nSome text\n---\nMore text';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('test');
    });

    it('multiline YAML values only capture first line', () => {
      // Known limitation: hand-rolled regex YAML parsing doesn't support multiline
      const content = '---\ndescription: >\n  This is multiline\n  YAML content\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('>');
    });

    it('handles description with colon in value', () => {
      const content = '---\ndescription: Key: value pair in desc\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('Key: value pair in desc');
    });

    it('handles description with special regex characters', () => {
      const content = '---\ndescription: Uses $pecial [chars] (and) *more*\n---\nBody';
      const result = agentParser.parseAgentFile(content);
      expect(result.description).toBe('Uses $pecial [chars] (and) *more*');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CustomAgentService.stripMarkdownFormatting
// ═══════════════════════════════════════════════════════════════════════════════

describe('CustomAgentService.stripMarkdownFormatting', () => {
  it('strips bold with double asterisks', () => {
    expect(agentParser.stripMarkdownFormatting('**bold text**')).toBe('bold text');
  });

  it('strips italic with single asterisk', () => {
    expect(agentParser.stripMarkdownFormatting('*italic text*')).toBe('italic text');
  });

  it('strips bold with double underscores', () => {
    expect(agentParser.stripMarkdownFormatting('__bold text__')).toBe('bold text');
  });

  it('strips italic with single underscore', () => {
    expect(agentParser.stripMarkdownFormatting('_italic text_')).toBe('italic text');
  });

  it('strips inline code', () => {
    expect(agentParser.stripMarkdownFormatting('`code here`')).toBe('code here');
  });

  it('strips links preserving text', () => {
    expect(agentParser.stripMarkdownFormatting('[Click here](https://example.com)')).toBe('Click here');
  });

  it('handles nested bold + italic (*** syntax)', () => {
    const result = agentParser.stripMarkdownFormatting('***bold italic***');
    expect(result).toBe('bold italic');
  });

  it('handles multiple formatting in one line', () => {
    const result = agentParser.stripMarkdownFormatting('**bold** and *italic* and `code`');
    expect(result).toBe('bold and italic and code');
  });

  it('preserves text without markdown', () => {
    expect(agentParser.stripMarkdownFormatting('plain text')).toBe('plain text');
  });

  it('leaves unmatched single asterisk alone', () => {
    expect(agentParser.stripMarkdownFormatting('5 * 3 = 15')).toBe('5 * 3 = 15');
  });

  it('preserves snake_case identifiers', () => {
    expect(agentParser.stripMarkdownFormatting('file_name_test')).toBe('file_name_test');
  });

  it('preserves consecutive underscored words', () => {
    expect(agentParser.stripMarkdownFormatting('has_two_parts_here')).toBe('has_two_parts_here');
  });

  it('leaves single underscores without pairs alone', () => {
    expect(agentParser.stripMarkdownFormatting('just_one')).toBe('just_one');
  });

  it('strips underscore emphasis at word boundaries', () => {
    expect(agentParser.stripMarkdownFormatting('_italic_ text')).toBe('italic text');
    expect(agentParser.stripMarkdownFormatting('text _italic_')).toBe('text italic');
    expect(agentParser.stripMarkdownFormatting('_italic_')).toBe('italic');
  });

  it('strips double-underscore bold at word boundaries', () => {
    expect(agentParser.stripMarkdownFormatting('__bold__ text')).toBe('bold text');
    expect(agentParser.stripMarkdownFormatting('text __bold__')).toBe('text bold');
    expect(agentParser.stripMarkdownFormatting('__bold__')).toBe('bold');
  });

  it('strips link with complex URL', () => {
    const result = agentParser.stripMarkdownFormatting('[docs](https://example.com/path?q=1&b=2#hash)');
    expect(result).toBe('docs');
  });

  it('handles empty formatting markers gracefully', () => {
    // ** ** with space — .+? requires at least 1 char so this matches
    expect(agentParser.stripMarkdownFormatting('** **')).toBe(' ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CustomAgentService.extractFirstLine
// ═══════════════════════════════════════════════════════════════════════════════

describe('CustomAgentService.extractFirstLine', () => {
  it('returns first non-heading line', () => {
    expect(agentParser.extractFirstLine('# Heading\nContent here')).toBe('Content here');
  });

  it('skips multiple heading levels', () => {
    expect(agentParser.extractFirstLine('# H1\n## H2\n### H3\nContent')).toBe('Content');
  });

  it('strips markdown from extracted line', () => {
    expect(agentParser.extractFirstLine('**Bold first line**')).toBe('Bold first line');
  });

  it('truncates to 100 characters', () => {
    const long = 'X'.repeat(200);
    expect(agentParser.extractFirstLine(long).length).toBe(100);
  });

  it('returns "No description" for empty input', () => {
    expect(agentParser.extractFirstLine('')).toBe('No description');
  });

  it('returns "No description" for whitespace-only input', () => {
    expect(agentParser.extractFirstLine('   \n  \n  ')).toBe('No description');
  });

  it('returns "No description" for heading-only input', () => {
    expect(agentParser.extractFirstLine('# Title\n## Subtitle')).toBe('No description');
  });

  it('handles CRLF line endings', () => {
    expect(agentParser.extractFirstLine('# Heading\r\nContent\r\n')).toBe('Content');
  });

  it('skips empty lines before content', () => {
    expect(agentParser.extractFirstLine('\n\n\nActual content')).toBe('Actual content');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SlashCommandService.parseMarkdownFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('SlashCommandService.parseMarkdownFile', () => {
  it('extracts description from frontmatter', () => {
    const content = '---\ndescription: Build the project\n---\nFull instructions here';
    const result = commandParser.parseMarkdownFile(content);
    expect(result.description).toBe('Build the project');
  });

  it('extracts argument-hint from frontmatter', () => {
    const content = '---\ndescription: Run command\nargument-hint: <file-path>\n---\nBody';
    const result = commandParser.parseMarkdownFile(content);
    expect(result.argumentHint).toBe('<file-path>');
  });

  it('strips quotes from argument-hint', () => {
    const content = '---\nargument-hint: "<pattern>"\ndescription: Search\n---\nBody';
    const result = commandParser.parseMarkdownFile(content);
    expect(result.argumentHint).toBe('<pattern>');
  });

  it('returns undefined argumentHint when not present', () => {
    const content = '---\ndescription: Simple command\n---\nBody';
    const result = commandParser.parseMarkdownFile(content);
    expect(result.argumentHint).toBeUndefined();
  });

  it('falls back to body first line when no frontmatter', () => {
    const content = 'Just instructions\nMore details here';
    const result = commandParser.parseMarkdownFile(content);
    expect(result.description).toBe('Just instructions');
  });

  it('handles CRLF frontmatter', () => {
    const content = '---\r\ndescription: CRLF command\r\n---\r\nBody';
    const result = commandParser.parseMarkdownFile(content);
    expect(result.description).toBe('CRLF command');
  });

  it('handles frontmatter without trailing newline after closing ---', () => {
    const content = '---\ndescription: test\n---';
    const result = commandParser.parseMarkdownFile(content);
    expect(result.description).toBe('test');
  });

  it('does not have model or tools fields', () => {
    const content = '---\ndescription: test\nmodel: opus\ntools: [Read]\n---\nBody';
    const result = commandParser.parseMarkdownFile(content);
    expect(result.description).toBe('test');
    expect((result as Record<string, unknown>)['model']).toBeUndefined();
    expect((result as Record<string, unknown>)['tools']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Skill description regex (from skills/utils.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Skill description regex', () => {
  it('extracts description from standard frontmatter', () => {
    const text = '---\ndescription: My awesome skill\n---\nBody content';
    expect(parseSkillDescription(text)).toBe('My awesome skill');
  });

  it('handles spaces after opening ---', () => {
    const text = '---   \ndescription: Spaced opener\n---\nBody';
    expect(parseSkillDescription(text)).toBe('Spaced opener');
  });

  it('handles CRLF line endings', () => {
    // The \s* in the skill regex matches \r, so ---\r\n works
    const text = '---\r\ndescription: CRLF skill\r\n---\r\nBody';
    const result = parseSkillDescription(text);
    // \r gets included in captured content, then .trim() strips it
    expect(result).toBe('CRLF skill');
  });

  it('returns undefined when no frontmatter', () => {
    expect(parseSkillDescription('Just plain text')).toBeUndefined();
  });

  it('returns undefined when no description field', () => {
    const text = '---\nother: field\n---\nBody';
    expect(parseSkillDescription(text)).toBeUndefined();
  });

  it('returns undefined for empty frontmatter', () => {
    const text = '---\n\n---\nBody';
    expect(parseSkillDescription(text)).toBeUndefined();
  });

  it('handles description with colon in value', () => {
    const text = '---\ndescription: Key: value in description\n---\nBody';
    expect(parseSkillDescription(text)).toBe('Key: value in description');
  });

  it('takes first description field if duplicated', () => {
    const text = '---\ndescription: First\ndescription: Second\n---\nBody';
    expect(parseSkillDescription(text)).toBe('First');
  });

  it('handles frontmatter without body content', () => {
    // --- followed by description and closing --- with newline
    const text = '---\ndescription: Skill\n---\n';
    expect(parseSkillDescription(text)).toBe('Skill');
  });

  it('frontmatter without trailing newline after closing ---', () => {
    // The skill regex /^---\s*\n([\s\S]*?)\n---/ does NOT require content after ---
    // It only looks for \n--- (no trailing \n needed) — different from service parsers
    const text = '---\ndescription: No trailing\n---';
    expect(parseSkillDescription(text)).toBe('No trailing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Agent profile section extraction patterns
// ═══════════════════════════════════════════════════════════════════════════════

describe('Agent profile extractSections', () => {
  describe('identity header matching', () => {
    it('matches "Identity"', () => {
      const content = '## Identity\nIdentity content here';
      expect(extractSections(content).identity).toBe('Identity content here');
    });

    it('matches "Role"', () => {
      const content = '## Role\nRole content here';
      expect(extractSections(content).identity).toBe('Role content here');
    });

    it('matches "Identity & Role"', () => {
      const content = '## Identity & Role\nContent';
      expect(extractSections(content).identity).toBe('Content');
    });

    it('matches "Identity and Role"', () => {
      const content = '## Identity and Role\nContent';
      expect(extractSections(content).identity).toBe('Content');
    });

    it('matches "Identity & Memory"', () => {
      const content = '## Identity & Memory\nContent';
      expect(extractSections(content).identity).toBe('Content');
    });

    it('matches "Your Identity"', () => {
      const content = '## Your Identity\nContent';
      expect(extractSections(content).identity).toBe('Content');
    });

    it('matches "Role Definition"', () => {
      const content = '## Role Definition\nContent';
      expect(extractSections(content).identity).toBe('Content');
    });

    it('matches with emoji prefix "🧠 Your Identity & Memory"', () => {
      const content = '## 🧠 Your Identity & Memory\nContent';
      expect(extractSections(content).identity).toBe('Content');
    });

    it('matches "Your Identity & Role" (full real header)', () => {
      const content = '## 🧠 Your Identity & Role\nContent';
      expect(extractSections(content).identity).toBe('Content');
    });
  });

  describe('mission header matching', () => {
    it('matches "Core Mission"', () => {
      const content = '## Core Mission\nMission content';
      expect(extractSections(content).mission).toBe('Mission content');
    });

    it('matches "Your Core Mission"', () => {
      const content = '## Your Core Mission\nMission content';
      expect(extractSections(content).mission).toBe('Mission content');
    });

    it('matches "Mission"', () => {
      const content = '## Mission\nMission content';
      expect(extractSections(content).mission).toBe('Mission content');
    });

    it('matches "Brand Mission"', () => {
      const content = '## Brand Mission\nMission content';
      expect(extractSections(content).mission).toBe('Mission content');
    });

    it('matches with emoji prefix "🎯 Core Mission"', () => {
      const content = '## 🎯 Core Mission\nMission content';
      expect(extractSections(content).mission).toBe('Mission content');
    });

    it('matches "🎯 Your Core Mission"', () => {
      const content = '## 🎯 Your Core Mission\nMission content';
      expect(extractSections(content).mission).toBe('Mission content');
    });

    it('matches "🔍 Your Core Beliefs"', () => {
      const content = '## 🔍 Your Core Beliefs\nBeliefs content';
      expect(extractSections(content).mission).toBe('Beliefs content');
    });

    it('matches "📋 Your Core Responsibilities"', () => {
      const content = '## 📋 Your Core Responsibilities\nResponsibilities content';
      expect(extractSections(content).mission).toBe('Responsibilities content');
    });
  });

  describe('rules header matching', () => {
    it('matches "Critical Rules"', () => {
      const content = '## Critical Rules\nRules content';
      expect(extractSections(content).rules).toBe('Rules content');
    });

    it('matches "Rules"', () => {
      const content = '## Rules\nRules content';
      expect(extractSections(content).rules).toBe('Rules content');
    });

    it('matches "Guardrails"', () => {
      const content = '## Guardrails\nGuardrails content';
      expect(extractSections(content).rules).toBe('Guardrails content');
    });

    it('matches "Non-negotiable Rules"', () => {
      const content = '## Non-negotiable Rules\nContent';
      expect(extractSections(content).rules).toBe('Content');
    });

    it('matches "Non negotiable Rules" (space variant)', () => {
      const content = '## Non negotiable Rules\nContent';
      expect(extractSections(content).rules).toBe('Content');
    });

    it('matches "Rules of Engagement"', () => {
      const content = '## Rules of Engagement\nContent';
      expect(extractSections(content).rules).toBe('Content');
    });

    it('matches "🚨 Critical Rules You Must Follow"', () => {
      const content = '## 🚨 Critical Rules You Must Follow\nContent';
      expect(extractSections(content).rules).toBe('Content');
    });

    it('matches "🚨 Critical Rules"', () => {
      const content = '## 🚨 Critical Rules\nContent';
      expect(extractSections(content).rules).toBe('Content');
    });

    it('matches "🚨 Your Mandatory Process"', () => {
      const content = '## 🚨 Your Mandatory Process\nProcess content';
      expect(extractSections(content).rules).toBe('Process content');
    });
  });

  describe('section body extraction', () => {
    it('extracts all three sections from a full profile', () => {
      const content = [
        '# Agent Personality',
        '',
        '## 🧠 Your Identity & Memory',
        '- **Role**: Test role',
        '- **Personality**: Test personality',
        '',
        '## 🎯 Your Core Mission',
        '### Build Things',
        '- Build stuff',
        '',
        '## 🚨 Critical Rules',
        '### Rule Category',
        '- Follow the rules',
      ].join('\n');

      const result = extractSections(content);
      expect(result.identity).toContain('**Role**: Test role');
      expect(result.mission).toContain('Build stuff');
      expect(result.rules).toContain('Follow the rules');
    });

    it('extracts body up to the next ## header', () => {
      const content = [
        '## Identity',
        'Identity line 1',
        'Identity line 2',
        '## Mission',
        'Mission content',
      ].join('\n');

      const result = extractSections(content);
      expect(result.identity).toBe('Identity line 1\nIdentity line 2');
      expect(result.mission).toBe('Mission content');
    });

    it('returns empty strings for missing sections', () => {
      const content = '## Unrelated Section\nSome content';
      const result = extractSections(content);
      expect(result.identity).toBe('');
      expect(result.mission).toBe('');
      expect(result.rules).toBe('');
    });

    it('first match wins — does not override with later duplicates', () => {
      const content = [
        '## Identity',
        'First identity',
        '## Role',
        'Second identity (should be ignored)',
      ].join('\n');

      const result = extractSections(content);
      expect(result.identity).toBe('First identity');
    });

    it('skips sections without a newline (header-only)', () => {
      // A section that has a header but no newline after it
      // This happens when split produces "Identity" with no \n
      const content = '## Identity';
      const result = extractSections(content);
      expect(result.identity).toBe('');
    });

    it('handles content before the first ## header', () => {
      const content = 'Preamble text\n\n## Identity\nContent';
      const result = extractSections(content);
      expect(result.identity).toBe('Content');
    });

    it('handles CRLF in section body', () => {
      const content = '## Identity\r\nLine 1\r\nLine 2\r\n## Mission\r\nMission text';
      const result = extractSections(content);
      expect(result.identity).toBe('Line 1\r\nLine 2');
      expect(result.mission).toBe('Mission text');
    });

    it('extracts sections from h1 headers', () => {
      const content = [
        '# Your Identity & Memory',
        'Identity content',
        '# Your Core Mission',
        'Mission content',
        '# Critical Rules You Must Follow',
        'Rules content',
      ].join('\n');

      const result = extractSections(content);
      expect(result.identity).toBe('Identity content');
      expect(result.mission).toBe('Mission content');
      expect(result.rules).toBe('Rules content');
    });

    it('extracts from mixed h1 and h2 headers', () => {
      const content = [
        '# Agent Title',
        'Preamble',
        '## 🧠 Your Identity & Memory',
        'Identity content',
        '## 🎯 Your Core Mission',
        'Mission content',
      ].join('\n');

      const result = extractSections(content);
      expect(result.identity).toBe('Identity content');
      expect(result.mission).toBe('Mission content');
    });

    it('does not split on h3 subsections', () => {
      const content = [
        '## Identity',
        'Main content',
        '### Subsection',
        'Sub content',
        '## Mission',
        'Mission content',
      ].join('\n');

      const result = extractSections(content);
      expect(result.identity).toBe('Main content\n### Subsection\nSub content');
      expect(result.mission).toBe('Mission content');
    });

    it('extracts sections with mojibake emoji prefixes', () => {
      const content = [
        '## >à Your Identity & Memory',
        'Identity content',
        '## <¯ Your Core Mission',
        'Mission content',
        '## =¨ Critical Rules You Must Follow',
        'Rules content',
      ].join('\n');

      const result = extractSections(content);
      expect(result.identity).toBe('Identity content');
      expect(result.mission).toBe('Mission content');
      expect(result.rules).toBe('Rules content');
    });

    it('extracts sections with emoji shortcode prefixes', () => {
      const content = [
        '## :brain: Your Identity & Memory',
        'Identity content',
        '## :dart: Your Core Mission',
        'Mission content',
        '## :rotating_light: Critical Rules You Must Follow',
        'Rules content',
      ].join('\n');

      const result = extractSections(content);
      expect(result.identity).toBe('Identity content');
      expect(result.mission).toBe('Mission content');
      expect(result.rules).toBe('Rules content');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Agent profile utility functions
// ═══════════════════════════════════════════════════════════════════════════════

describe('stripEmoji', () => {
  it('strips brain emoji from "🧠 Identity"', () => {
    expect(stripEmoji('🧠 Identity')).toBe('Identity');
  });

  it('strips target emoji from "🎯 Core Mission"', () => {
    expect(stripEmoji('🎯 Core Mission')).toBe('Core Mission');
  });

  it('strips warning emoji from "🚨 Critical Rules"', () => {
    expect(stripEmoji('🚨 Critical Rules')).toBe('Critical Rules');
  });

  it('returns text unchanged when no emoji', () => {
    expect(stripEmoji('Plain text')).toBe('Plain text');
  });

  it('strips multiple emoji characters', () => {
    expect(stripEmoji('🎯🧠 Double emoji')).toBe('Double emoji');
  });

  it('handles emoji without trailing space', () => {
    expect(stripEmoji('🎯Text')).toBe('Text');
  });

  it('handles zero-width joiner emoji sequences', () => {
    // ZWJ sequences like 👨‍💻 (man technologist)
    expect(stripEmoji('👨‍💻 Developer')).toBe('Developer');
  });

  it('strips common symbols in the emoji range', () => {
    expect(stripEmoji('⚡ Lightning')).toBe('Lightning');
    expect(stripEmoji('✨ Sparkles')).toBe('Sparkles');
  });

  it('preserves leading whitespace after emoji removal', () => {
    expect(stripEmoji('🎯  Double spaced')).toBe('Double spaced');
  });

  it('strips emoji shortcodes', () => {
    expect(stripEmoji(':brain: Your Identity')).toBe('Your Identity');
    expect(stripEmoji(':dart: Core Mission')).toBe('Core Mission');
    expect(stripEmoji(':rotating_light: Critical Rules')).toBe('Critical Rules');
  });

  it('strips mojibake/garbled emoji characters', () => {
    expect(stripEmoji('>à Your Identity')).toBe('Your Identity');
    expect(stripEmoji('<¯ Your Core Mission')).toBe('Your Core Mission');
    expect(stripEmoji('=¨ Critical Rules')).toBe('Critical Rules');
    expect(stripEmoji('=Ë Technical Deliverables')).toBe('Technical Deliverables');
  });

  it('handles combined emoji + mojibake edge cases', () => {
    expect(stripEmoji('= Advanced Capabilities')).toBe('Advanced Capabilities');
    expect(stripEmoji('¡ Performance')).toBe('Performance');
  });
});

describe('inferCategory', () => {
  it('capitalizes single-word directory', () => {
    expect(inferCategory('academic/file.md')).toBe('Academic');
  });

  it('capitalizes hyphenated directory as separate words', () => {
    expect(inferCategory('game-development/file.md')).toBe('Game Development');
  });

  it('handles nested directories (uses first segment)', () => {
    expect(inferCategory('game-development/unity/file.md')).toBe('Game Development');
  });

  it('handles backslash paths (Windows)', () => {
    expect(inferCategory('paid-media\\file.md')).toBe('Paid Media');
  });

  it('handles triple-hyphenated names', () => {
    expect(inferCategory('spatial-computing/file.md')).toBe('Spatial Computing');
  });

  it('handles single file (no directory)', () => {
    expect(inferCategory('standalone-file.md')).toBe('Standalone File.md');
  });
});

describe('escapeForTs', () => {
  it('escapes backslashes', () => {
    expect(escapeForTs('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes backticks', () => {
    expect(escapeForTs('const x = `hello`')).toBe('const x = \\`hello\\`');
  });

  it('escapes dollar signs', () => {
    expect(escapeForTs('${variable}')).toBe('\\${variable}');
  });

  it('escapes all three in sequence', () => {
    const input = '\\`$';
    expect(escapeForTs(input)).toBe('\\\\\\`\\$');
  });

  it('leaves normal text unchanged', () => {
    expect(escapeForTs('normal text')).toBe('normal text');
  });

  it('handles empty string', () => {
    expect(escapeForTs('')).toBe('');
  });

  it('handles already-escaped backslashes', () => {
    expect(escapeForTs('\\\\')).toBe('\\\\\\\\');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Integration: generated agent profiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('Generated agent profiles (integration)', () => {
  it('contains more than 100 profiles', () => {
    expect(AGENT_PROFILES.length).toBeGreaterThan(100);
  });

  it('has consistent profile/map counts', () => {
    expect(AGENT_PROFILE_MAP.size).toBe(AGENT_PROFILES.length);
  });

  it('catalog string is non-empty and grouped by category', () => {
    expect(AGENT_PROFILE_CATALOG.length).toBeGreaterThan(100);
    expect(AGENT_PROFILE_CATALOG).toContain('**Engineering**');
    expect(AGENT_PROFILE_CATALOG).toContain('**Academic**');
  });

  it('all profiles have required string fields', () => {
    for (const p of AGENT_PROFILES) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(typeof p.category).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.category.length).toBeGreaterThan(0);
    }
  });

  it('all profile IDs are unique', () => {
    const ids = AGENT_PROFILES.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('profiles are sorted by category then name', () => {
    for (let i = 1; i < AGENT_PROFILES.length; i++) {
      const prev = AGENT_PROFILES[i - 1]!;
      const curr = AGENT_PROFILES[i]!;
      const cmp = prev.category.localeCompare(curr.category) || prev.name.localeCompare(curr.name);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  describe('known profile: engineering-backend-architect', () => {
    let profile: (typeof AGENT_PROFILES)[number] | undefined;

    beforeAll(() => {
      profile = AGENT_PROFILE_MAP.get('engineering-backend-architect');
    });

    it('exists in the registry', () => {
      expect(profile).toBeDefined();
    });

    it('has correct metadata', () => {
      expect(profile!.name).toBe('Backend Architect');
      expect(profile!.category).toBe('Engineering');
      expect(profile!.emoji).toBe('🏗️');
    });

    it('extracted identity section', () => {
      expect(profile!.identity.length).toBeGreaterThan(0);
      expect(profile!.identity).toContain('System architecture');
    });

    it('extracted mission section', () => {
      expect(profile!.mission.length).toBeGreaterThan(0);
      expect(profile!.mission).toContain('Data/Schema Engineering');
    });

    it('extracted rules section', () => {
      expect(profile!.rules.length).toBeGreaterThan(0);
      expect(profile!.rules).toContain('Security-First');
    });
  });

  it('most profiles have non-empty identity sections', () => {
    const withIdentity = AGENT_PROFILES.filter(p => p.identity.length > 0);
    expect(withIdentity.length / AGENT_PROFILES.length).toBeGreaterThan(0.8);
  });

  it('most profiles have non-empty mission sections', () => {
    const withMission = AGENT_PROFILES.filter(p => p.mission.length > 0);
    expect(withMission.length / AGENT_PROFILES.length).toBeGreaterThan(0.8);
  });

  it('most profiles have non-empty rules sections', () => {
    const withRules = AGENT_PROFILES.filter(p => p.rules.length > 0);
    expect(withRules.length / AGENT_PROFILES.length).toBeGreaterThan(0.8);
  });

  it('catalog entries reference valid profile IDs', () => {
    const idPattern = /^- ([\w-]+) —/gm;
    let match;
    const catalogIds: string[] = [];
    while ((match = idPattern.exec(AGENT_PROFILE_CATALOG)) !== null) {
      catalogIds.push(match[1]!);
    }
    expect(catalogIds.length).toBe(AGENT_PROFILES.length);
    for (const id of catalogIds) {
      expect(AGENT_PROFILE_MAP.has(id)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Cross-parser consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-parser consistency', () => {
  const standardContent = '---\ndescription: Same file\n---\nBody content here';

  it('agent parser and command parser agree on frontmatter description', () => {
    const agentResult = agentParser.parseAgentFile(standardContent);
    const cmdResult = commandParser.parseMarkdownFile(standardContent);
    expect(agentResult.description).toBe(cmdResult.description);
  });

  it('both parsers agree on body-only fallback', () => {
    const bodyOnly = 'First line of content\nSecond line';
    const agentResult = agentParser.parseAgentFile(bodyOnly);
    const cmdResult = commandParser.parseMarkdownFile(bodyOnly);
    expect(agentResult.description).toBe(cmdResult.description);
  });

  it('both parsers agree on CRLF handling', () => {
    const crlf = '---\r\ndescription: CRLF\r\n---\r\nBody';
    const agentResult = agentParser.parseAgentFile(crlf);
    const cmdResult = commandParser.parseMarkdownFile(crlf);
    expect(agentResult.description).toBe(cmdResult.description);
  });

  it('all parsers agree on frontmatter without trailing newline', () => {
    const noTrailingNewline = '---\ndescription: test\n---';
    const agentResult = agentParser.parseAgentFile(noTrailingNewline);
    const cmdResult = commandParser.parseMarkdownFile(noTrailingNewline);
    const skillResult = parseSkillDescription(noTrailingNewline);

    expect(agentResult.description).toBe('test');
    expect(cmdResult.description).toBe('test');
    expect(skillResult).toBe('test');
  });
});
