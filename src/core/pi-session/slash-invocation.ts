import { readFileSync } from 'fs';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { SlashInvocation } from '../chat-session';

/**
 * The front half of pi's `prompt()` (agent-session.js): an extension command first, else `_expandSkillCommand`, then
 * `expandPromptTemplate` (prompt-templates.js). pi exports neither expander, so both are ported here; a parity test runs
 * pi's own `expandPromptTemplate` over the same inputs. pi's input handlers run between the two steps and are not modelled.
 */

type SlashSession = Pick<AgentSession, 'extensionRunner' | 'resourceLoader'>;

/** Whether `prompt(text)` runs a registered extension command, which commits no user entry. Mirrors the
 *  parse in pi's `_tryExecuteExtensionCommand`, which `prompt()` reaches with template expansion on. */
export function isExtensionCommand(session: Pick<AgentSession, 'extensionRunner'>, text: string): boolean {
  if (!text.startsWith('/')) return false;
  const space = text.indexOf(' ');
  return session.extensionRunner.getCommand(text.slice(1, space === -1 ? undefined : space)) !== undefined;
}

export function resolveSlashInvocation(session: SlashSession, text: string, stripFrontmatter: (content: string) => string): SlashInvocation {
  if (!text.startsWith('/')) return { kind: 'text' };
  if (isExtensionCommand(session, text)) return { kind: 'command' };
  const expanded = expandPromptTemplate(expandSkillCommand(session, text, stripFrontmatter), session.resourceLoader.getPrompts().prompts);
  return expanded === text ? { kind: 'text' } : { kind: 'expanded', text: expanded };
}

function expandSkillCommand(session: SlashSession, text: string, stripFrontmatter: (content: string) => string): string {
  if (!text.startsWith('/skill:')) return text;
  const space = text.indexOf(' ');
  const name = space === -1 ? text.slice(7) : text.slice(7, space);
  const args = space === -1 ? '' : text.slice(space + 1).trim();
  const skill = session.resourceLoader.getSkills().skills.find((candidate) => candidate.name === name);
  if (!skill) return text;
  try {
    const body = stripFrontmatter(readFileSync(skill.filePath, 'utf-8')).trim();
    const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
  } catch {
    return text;
  }
}

export function expandPromptTemplate(text: string, templates: readonly { name: string; content: string }[]): string {
  if (!text.startsWith('/')) return text;
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return text;
  const template = templates.find((candidate) => candidate.name === match[1]);
  return template ? substituteArgs(template.content, parseCommandArgs(match[2] ?? '')) : text;
}

function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

function substituteArgs(content: string, args: readonly string[]): string {
  const allArgs = args.join(' ');
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget: string | undefined, defaultValue: string, sliceStart: string | undefined, sliceLength: string | undefined, simple: string) => {
      if (defaultTarget) {
        const value = defaultTarget === '@' || defaultTarget === 'ARGUMENTS' ? allArgs : args[parseInt(defaultTarget, 10) - 1];
        return value ? value : defaultValue;
      }
      if (sliceStart) {
        const start = Math.max(0, parseInt(sliceStart, 10) - 1);
        return sliceLength ? args.slice(start, start + parseInt(sliceLength, 10)).join(' ') : args.slice(start).join(' ');
      }
      if (simple === 'ARGUMENTS' || simple === '@') return allArgs;
      return args[parseInt(simple, 10) - 1] ?? '';
    },
  );
}
