/**
 * The single presentation table for the nineteen team tools: three main coordination tools the primary
 * agent calls, and sixteen `team_*` tools each team agent calls. It holds the human label plus how a
 * tool card summarises that tool's input and its result.
 *
 * The summaries are for the card only. The tool results themselves are the model's contract and are
 * never reshaped here, and the expanded overlay keeps showing the raw input and the raw result.
 *
 * Imported by both the webview bundle and the extension host, so this file imports nothing.
 */

/** Card summaries are clipped here so a long message or a whole ledger cannot grow the card. */
const INPUT_MAX = 80;
const RESULT_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Bidirectional formatting characters: the LRM/RLM marks, the embedding/override pair and the isolates.
 * An unpaired override reverses the visual order of everything after it, so a model-chosen agent name
 * can render as text it does not contain. They are zero-width, so they are dropped rather than replaced.
 * The class is a copy of `stripBidiControls` in `pi-session/untrusted-text.ts` because this file is
 * bundled into the webview, which cannot import from the extension host; keep the two identical.
 */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Every character a renderer treats as a line break. A card row is one line, so the text stops here. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * Every value summarised below is text Damocles did not author: agent names, message content, feedback,
 * scratchpad bodies and raw tool results. This is the one place it is made fit for a card row, so a new
 * summary cannot reach past it. HTML escaping does not defend against either of these.
 */
function asText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const flattened = value.replace(BIDI_CONTROLS, '');
  const breakAt = flattened.search(LINE_BREAK);
  return breakAt === -1 ? flattened : flattened.slice(0, breakAt);
}

/** Clipped to `max` characters, ellipsis included, so the cap is the width the card can hold. */
function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 3) + '...' : trimmed;
}

/** One clipped line: a card row is a single line, so anything past the first would be dropped anyway. */
function line(value: unknown, max: number): string {
  return clip(asText(value), max);
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Several team tools return JSON inside their result string; a non-JSON result falls back to raw. The
 * shape check comes first so an ordinary sentence answer takes the fallback as a branch rather than by
 * building an exception on the render thread.
 */
function parseJson(result: string): unknown {
  const trimmed = result.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** The head of the raw result, for the tools whose return text already reads as human sentences. */
function rawResult(result: string): string {
  return line(result, RESULT_MAX);
}

/** `label: detail`, dropping either side when it is missing, capped as one card row. */
function labelled(label: string, detail: string): string {
  if (!label) return clip(detail, INPUT_MAX);
  if (!detail) return clip(label, INPUT_MAX);
  return clip(`${label}: ${detail}`, INPUT_MAX);
}

/** `name (kind)` for the two dispatch tools, which take the same input shape. */
function specialistLabel(input: Record<string, unknown>): string {
  const name = line(input['name'], INPUT_MAX);
  const kind = line(input['kind'], INPUT_MAX);
  if (!name) return '';
  return kind ? `${name} (${kind})` : name;
}

function teamStatusResult(result: string): string {
  const parsed = parseJson(result);
  if (!isRecord(parsed)) return rawResult(result);
  const agents = Array.isArray(parsed['agents']) ? parsed['agents'] : [];
  const running = agents.filter((a) => isRecord(a) && a['status'] === 'running').length;
  const phase = asText(parsed['phase']);
  return `${phase ? `${phase}: ` : ''}${running} of ${count(agents.length, 'agent')} running`;
}

function readMessagesResult(result: string): string {
  const parsed = parseJson(result);
  if (!Array.isArray(parsed)) return rawResult(result);
  const senders = [...new Set(parsed.map((m) => (isRecord(m) ? asText(m['from']) : '')).filter(Boolean))];
  const total = count(parsed.length, 'message');
  return senders.length > 0 ? clip(`${total} from ${senders.join(', ')}`, RESULT_MAX) : total;
}

function readScratchpadResult(result: string): string {
  const parsed = parseJson(result);
  if (Array.isArray(parsed)) {
    const sections = parsed.map((e) => (isRecord(e) ? asText(e['section']) : '')).filter(Boolean);
    if (sections.length === 0) return rawResult(result);
    return clip(`${count(sections.length, 'section')}: ${sections.join(', ')}`, RESULT_MAX);
  }
  if (!isRecord(parsed)) return rawResult(result);
  const section = asText(parsed['section']);
  const version = typeof parsed['version'] === 'number' ? ` v${parsed['version']}` : '';
  return clip(`${section}${version}: ${line(parsed['content'], RESULT_MAX)}`, RESULT_MAX);
}

export interface TeamToolPresentation {
  /** The human label on the card; the expanded overlay still shows the raw snake_case name. */
  label: string;
  /** The card's IN line. An empty summary renders no IN row at all. */
  summarizeInput: (input: Record<string, unknown>) => string;
  /** The card's OUT line. The raw result reaches the overlay untouched. */
  summarizeResult: (result: string, input: Record<string, unknown>) => string;
}

export const TEAM_TOOL_PRESENTATION: Readonly<Record<string, TeamToolPresentation>> = {
  create_team: {
    label: 'Create team',
    summarizeInput: (input) => {
      const title = line(input['title'], INPUT_MAX);
      const agents = Array.isArray(input['agents']) ? input['agents'].length : 0;
      if (agents === 0) return title;
      return title ? clip(`${title} (${count(agents, 'agent')})`, INPUT_MAX) : count(agents, 'agent');
    },
    summarizeResult: rawResult,
  },
  get_team_status: {
    label: 'Get team status',
    summarizeInput: (input) => line(input['team_id'], INPUT_MAX),
    summarizeResult: teamStatusResult,
  },
  cancel_team: {
    label: 'Cancel team',
    summarizeInput: (input) => line(input['team_id'], INPUT_MAX),
    summarizeResult: rawResult,
  },

  team_send_message: {
    label: 'Send message',
    summarizeInput: (input) => {
      const to = line(input['to'], INPUT_MAX);
      return labelled(to ? `To ${to}` : '', line(input['content'], INPUT_MAX));
    },
    summarizeResult: (result, input) => {
      const to = line(input['to'], INPUT_MAX);
      return to ? `Sent to ${to}` : rawResult(result);
    },
  },
  team_read_messages: {
    label: 'Read messages',
    summarizeInput: () => '',
    summarizeResult: readMessagesResult,
  },
  team_read_scratchpad: {
    label: 'Read scratchpad',
    summarizeInput: (input) => line(input['section'], INPUT_MAX) || 'All sections',
    summarizeResult: readScratchpadResult,
  },
  team_write_scratchpad: {
    label: 'Write scratchpad',
    summarizeInput: (input) => labelled(line(input['section'], INPUT_MAX), line(input['content'], INPUT_MAX)),
    summarizeResult: rawResult,
  },
  team_get_status: {
    label: 'Team status',
    summarizeInput: () => '',
    summarizeResult: teamStatusResult,
  },
  team_spawn_specialist: {
    label: 'Spawn specialist',
    summarizeInput: (input) => labelled(specialistLabel(input), line(input['task'], INPUT_MAX)),
    summarizeResult: (result, input) => {
      const name = line(input['name'], INPUT_MAX);
      return name ? `Spawned ${name}` : rawResult(result);
    },
  },
  team_redispatch_specialist: {
    label: 'Redispatch specialist',
    summarizeInput: (input) => labelled(specialistLabel(input), line(input['task'], INPUT_MAX)),
    summarizeResult: (result, input) => {
      const name = line(input['name'], INPUT_MAX);
      return name ? `Re-dispatched ${name}` : rawResult(result);
    },
  },
  team_cancel_specialist: {
    label: 'Cancel specialist',
    summarizeInput: (input) => line(input['name'], INPUT_MAX),
    summarizeResult: rawResult,
  },
  team_request_revision: {
    label: 'Request revision',
    summarizeInput: (input) => labelled(line(input['name'], INPUT_MAX), line(input['feedback'], INPUT_MAX)),
    summarizeResult: rawResult,
  },
  team_approve_specialist: {
    label: 'Approve specialist',
    summarizeInput: (input) => line(input['name'], INPUT_MAX),
    summarizeResult: rawResult,
  },
  team_standby: {
    label: 'Standby',
    summarizeInput: () => '',
    summarizeResult: () => 'Waiting for peer content',
  },
  team_report_complete: {
    label: 'Report complete',
    summarizeInput: () => '',
    summarizeResult: () => 'Awaiting the lead\'s review',
  },
  team_flag_brief_conflict: {
    label: 'Flag brief conflict',
    summarizeInput: (input) => line(input['detail'], INPUT_MAX),
    summarizeResult: () => 'Conflict flagged, the lead was notified',
  },
  team_resolve_brief_conflict: {
    label: 'Resolve brief conflict',
    summarizeInput: (input) => labelled(line(input['name'], INPUT_MAX), line(input['resolution'], INPUT_MAX)),
    summarizeResult: rawResult,
  },
  team_record_verification: {
    label: 'Record verification',
    summarizeInput: (input) => {
      const command = line(input['command'], INPUT_MAX);
      const outcome = line(input['result'], INPUT_MAX);
      if (!command) return outcome;
      return outcome ? `${command} → ${outcome}` : command;
    },
    summarizeResult: rawResult,
  },
  team_synthesize_result: {
    label: 'Synthesize result',
    summarizeInput: (input) => line(input['result'], INPUT_MAX),
    summarizeResult: rawResult,
  },
};

/** snake_case pi tool name to the human label shown on a tool card; the overlay still shows the raw name. */
export const TEAM_TOOL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TEAM_TOOL_PRESENTATION).map(([name, presentation]) => [name, presentation.label]),
);
