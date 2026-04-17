import type { BuiltinSlashCommandInfo } from './types/commands';

export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommandInfo[] = [
  { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
  { name: 'compact', description: 'Compact conversation', argumentHint: '[instructions]', source: 'builtin' },
  { name: 'rewind', description: 'Rewind conversation/code', source: 'builtin' },
  { name: 'review', description: 'Request code review', source: 'builtin' },
  { name: 'security-review', description: 'Security review of changes', source: 'builtin' },
  { name: 'init', description: 'Initialize CLAUDE.md', source: 'builtin' },
  { name: 'remember', description: 'Save a session memory (prefix with "project:" or "global:" for broader scope)', argumentHint: '<text>', source: 'builtin' },
  { name: 'note', description: 'Save a persistent note to your knowledge base', argumentHint: '<text>', source: 'builtin' },
  { name: 'memories', description: 'Browse and manage memories', source: 'builtin' },
  { name: 'context', description: 'Display current context', source: 'builtin' },
  { name: 'simplify', description: 'Review changed code for reuse, quality, and efficiency', source: 'builtin' },
  { name: 'batch', description: 'Execute a large-scale change in parallel across isolated worktree agents', argumentHint: '<instruction>', source: 'builtin' },
  { name: 'loop', description: 'Schedule a recurring prompt', argumentHint: '<interval> <prompt>', source: 'builtin' },
  { name: 'btw', description: 'Ask a side question using conversation context', argumentHint: '<question>', source: 'builtin' },
  { name: 'login', description: 'Sign in to Claude via the bundled CLI', source: 'builtin' },
  { name: 'logout', description: 'Sign out of Claude and delete stored credentials', source: 'builtin' },
];

export const SDK_SKILL_NAMES: ReadonlySet<string> = new Set(['simplify', 'loop']);

export const SDK_DIRECT_COMMANDS: ReadonlySet<string> = new Set(['batch']);
