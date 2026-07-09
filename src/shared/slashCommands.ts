import type { BuiltinSlashCommandInfo } from './types/commands';

export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommandInfo[] = [
  { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
  { name: 'compact', description: 'Compact conversation', argumentHint: '[instructions]', source: 'builtin' },
  { name: 'rewind', description: 'Rewind conversation/code', source: 'builtin' },
  { name: 'init', description: 'Initialize CLAUDE.md', source: 'builtin' },
  { name: 'remember', description: 'Save a session memory (prefix with "project:" or "global:" for broader scope)', argumentHint: '<text>', source: 'builtin' },
  { name: 'note', description: 'Save a persistent note to your knowledge base', argumentHint: '<text>', source: 'builtin' },
  { name: 'memories', description: 'Browse and manage memories', source: 'builtin' },
  { name: 'context', description: 'Display current context', source: 'builtin' },
  { name: 'usage', description: 'Show Claude / GPT subscription usage', source: 'builtin' },
  { name: 'btw', description: 'Ask a side question using conversation context', argumentHint: '<question>', source: 'builtin' },
];
