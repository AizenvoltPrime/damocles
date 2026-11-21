import type { CustomMessageEntryDraft } from '@earendil-works/pi-coding-agent';
import { EMITTED_TAG_NAMES, tagNeutralizer } from '../memory/injection/render';
import type { ProjectionReader } from './agent-start';

// The Agent tool's description lists the subagent types as of the session's build and never changes after it, since a tool
// definition change invalidates the whole prompt cache. A later change reaches the model as an appended hidden note instead.

export const AGENT_CHANGE_CUSTOM_TYPE = 'damocles-agent-change';

const AGENT_CHANGE_TAG = 'damocles_agent_types';

const neutralize = tagNeutralizer([AGENT_CHANGE_TAG, ...EMITTED_TAG_NAMES]);

/** Stored on each note; the only record of which subagent types the model was told about. */
export interface AgentChangeDetailsV1 {
  v: 1;
  /** Every spawnable type as of this note, sorted. */
  types: string[];
  added: string[];
  removed: string[];
}

/** The spawnable subagent types a chat's Agent tool was described with, and the ones its registry holds now. */
export interface AgentTypesNow {
  described: readonly string[];
  live: readonly { name: string; description: string }[];
}

interface AgentChangeNote extends Pick<CustomMessageEntryDraft, 'customType' | 'display' | 'details'> {
  content: string;
}

function isAgentChangeDetails(v: unknown): v is AgentChangeDetailsV1 {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  const names = (list: unknown): boolean => Array.isArray(list) && list.every((name) => typeof name === 'string');
  return d['v'] === 1 && names(d['types']) && names(d['added']) && names(d['removed']);
}

/** The types the latest note in `messages` listed, read from its details only; undefined when none did. */
export function notedAgentTypes(messages: readonly unknown[]): readonly string[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; customType?: unknown; details?: unknown } | null | undefined;
    if (m?.role !== 'custom' || m.customType !== AGENT_CHANGE_CUSTOM_TYPE) continue;
    if (isAgentChangeDetails(m.details)) return m.details.types;
  }
  return undefined;
}

/** One line of repository text, which cannot open or close the note's tag. */
function oneLine(text: string): string {
  return neutralize(text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
}

/** The note telling the model how `live` differs from `known`, or undefined when it does not. */
export function agentChangeNote(known: readonly string[], live: AgentTypesNow['live']): AgentChangeNote | undefined {
  const sorted = [...live].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const types = sorted.map((agent) => agent.name);
  const knownSet = new Set(known);
  const liveSet = new Set(types);
  const addedAgents = sorted.filter((agent) => !knownSet.has(agent.name));
  const added = addedAgents.map((agent) => agent.name);
  const removed = [...knownSet].filter((name) => !liveSet.has(name)).sort();
  if (added.length === 0 && removed.length === 0) return undefined;
  const lines = ['The subagent types the Agent tool accepts changed since its description or the last note like this one.'];
  if (addedAgents.length > 0) {
    lines.push('Added:');
    for (const agent of addedAgents) lines.push(`- ${oneLine(agent.name)}: ${oneLine(agent.description)}`);
  }
  if (removed.length > 0) lines.push(`Removed, so the Agent tool refuses them: ${removed.map(oneLine).join(', ')}`);
  lines.push(`subagent_type now takes one of: ${types.map(oneLine).join(', ')}`);
  const details: AgentChangeDetailsV1 = { v: 1, types, added, removed };
  return { customType: AGENT_CHANGE_CUSTOM_TYPE, content: `<${AGENT_CHANGE_TAG}>\n${lines.join('\n')}\n</${AGENT_CHANGE_TAG}>`, display: false, details };
}

/** The note for a prompt about to start: the model's last word on the types is the latest note it reads, else the tool description. */
export function agentChangeNoteAtPromptStart(agentTypes: AgentTypesNow, sessionManager: Pick<ProjectionReader, 'buildSessionProjection'>): AgentChangeNote | undefined {
  const known = notedAgentTypes(sessionManager.buildSessionProjection().messages) ?? agentTypes.described;
  return agentChangeNote(known, agentTypes.live);
}
