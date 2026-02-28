import type { ContextUsageData } from '@shared/types/session';

const CONTEXT_USAGE_MARKER = '## Context Usage';

export function isContextUsageOutput(text: string): boolean {
  return text.includes(CONTEXT_USAGE_MARKER);
}

function parseTokenValue(raw: string): number {
  const trimmed = raw.trim().replace(/,/g, '');
  if (trimmed.endsWith('k')) {
    return Math.round(parseFloat(trimmed.slice(0, -1)) * 1000);
  }
  return parseInt(trimmed, 10) || 0;
}

const CATEGORY_MAP: Record<string, keyof ContextUsageData['breakdown']> = {
  'System prompt': 'systemPrompt',
  'System tools': 'systemTools',
  'MCP tools': 'mcpTools',
  'MCP Tools': 'mcpTools',
  'Custom agents': 'customAgents',
  'Memory files': 'memoryFiles',
  'Skills': 'skills',
  'Messages': 'messages',
  'Compact buffer': 'compactBuffer',
  'Autocompact buffer': 'compactBuffer',
  'Free space': 'freeSpace',
};

function parseTableRows(section: string): string[][] {
  const rows: string[][] = [];
  let pastSeparator = false;
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---')) {
      pastSeparator = true;
      continue;
    }
    if (!pastSeparator) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

function extractSection(text: string, heading: string): string | null {
  const pattern = new RegExp(`### ${heading}\\s*\\n([\\s\\S]*?)(?=###|$)`);
  return text.match(pattern)?.[1] ?? null;
}

export function parseContextUsageMarkdown(markdown: string): ContextUsageData | null {
  const modelMatch = markdown.match(/\*\*Model:\*\*\s*(.+?)(?:\s{2,}|\n)/);
  const tokensMatch = markdown.match(/\*\*Tokens:\*\*\s*(.+?)\s*\/\s*(.+?)\s*\((\d+)%\)/);

  if (!modelMatch?.[1] || !tokensMatch?.[1] || !tokensMatch[2] || !tokensMatch[3]) return null;

  const model = modelMatch[1].trim();
  const totalTokens = parseTokenValue(tokensMatch[1]);
  const maxTokens = parseTokenValue(tokensMatch[2]);
  const usagePercentage = parseInt(tokensMatch[3], 10);

  const breakdown: ContextUsageData['breakdown'] = {
    systemPrompt: 0,
    systemTools: 0,
    mcpTools: 0,
    customAgents: 0,
    memoryFiles: 0,
    skills: 0,
    messages: 0,
    compactBuffer: 0,
    freeSpace: 0,
  };

  const categorySection = extractSection(markdown, 'Estimated usage by category');
  if (categorySection) {
    for (const row of parseTableRows(categorySection)) {
      const name = row[0];
      const tokens = row[1];
      if (!name || !tokens) continue;
      const key = CATEGORY_MAP[name];
      if (key) {
        breakdown[key] = parseTokenValue(tokens);
      }
    }
  }

  const details: ContextUsageData['details'] = {
    mcpTools: [],
    memoryFiles: [],
    skills: [],
    customAgents: [],
  };

  const mcpSection = extractSection(markdown, 'MCP Tools');
  if (mcpSection) {
    for (const row of parseTableRows(mcpSection)) {
      const [col0, col1, col2] = row;
      if (!col0 || !col1 || !col2) continue;
      details.mcpTools.push({ name: col0, server: col1, tokens: parseTokenValue(col2) });
    }
  }

  const agentSection = extractSection(markdown, 'Custom Agents');
  if (agentSection) {
    for (const row of parseTableRows(agentSection)) {
      const [col0, col1, col2] = row;
      if (!col0 || !col1 || !col2) continue;
      details.customAgents.push({ type: col0, source: col1, tokens: parseTokenValue(col2) });
    }
  }

  const memorySection = extractSection(markdown, 'Memory Files');
  if (memorySection) {
    for (const row of parseTableRows(memorySection)) {
      const [col0, col1, col2] = row;
      if (!col0 || !col1 || !col2) continue;
      details.memoryFiles.push({ type: col0, path: col1, tokens: parseTokenValue(col2) });
    }
  }

  const skillsSection = extractSection(markdown, 'Skills');
  if (skillsSection) {
    for (const row of parseTableRows(skillsSection)) {
      const [col0, col1, col2] = row;
      if (!col0 || !col1 || !col2) continue;
      details.skills.push({ name: col0, source: col1, tokens: parseTokenValue(col2) });
    }
  }

  return { model, totalTokens, maxTokens, usagePercentage, breakdown, details };
}
