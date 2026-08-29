import { describe, expect, it } from 'vitest';
import { TEAM_TOOL_LABELS, TEAM_TOOL_PRESENTATION } from '../team-tool-labels';

/**
 * The presentation table's own behaviour. It imports nothing but its subject: `src/shared` is compiled
 * into the webview bundle, so a test here that reached for extension code would drag the extension host
 * into the webview typecheck. The registration seam is tested from the extension side instead, in
 * `pi-session/tools/__tests__/team-tool-registration.test.ts`.
 */

describe('TEAM_TOOL_LABELS', () => {
  it('reads as human text rather than as the raw tool name', () => {
    for (const [name, label] of Object.entries(TEAM_TOOL_LABELS)) {
      expect(label.trim(), `label for ${name}`).not.toBe('');
      expect(label, `label for ${name}`).not.toBe(name);
      expect(label, `label for ${name}`).not.toContain('_');
    }
  });

  it('gives the labels the cards are read by', () => {
    expect(TEAM_TOOL_LABELS['team_write_scratchpad']).toBe('Write scratchpad');
    expect(TEAM_TOOL_LABELS['team_send_message']).toBe('Send message');
    expect(TEAM_TOOL_LABELS['create_team']).toBe('Create team');
  });
});

/**
 * The card summaries. Every key any team tool takes is fed to every tool, so a summary that reached for
 * a key it does not own would show it; the card is one line, so the invariants are one line and no JSON.
 */
const EVERY_INPUT_KEY: Record<string, unknown> = {
  title: 'Ship the parser',
  brief: 'the authoritative spec',
  agents: [{ name: 'lead', role: 'lead' }, { name: 'coder', role: 'specialist' }],
  team_id: 'team-7',
  to: 'lead',
  content: 'the parser is done',
  section: 'mission-brief',
  name: 'coder',
  kind: 'implementor',
  task: 'rewrite the tokenizer',
  feedback: 'the tokenizer drops escapes',
  resolution: 'the brief wins',
  detail: 'the task contradicts the brief',
  command: 'npm test',
  result: 'pass',
  since: 1,
};

describe('TEAM_TOOL_PRESENTATION card summaries', () => {
  const names = Object.keys(TEAM_TOOL_PRESENTATION);

  it.each(names)('%s summarises its input as one line of text, never as JSON', (name) => {
    const summary = TEAM_TOOL_PRESENTATION[name]!.summarizeInput(EVERY_INPUT_KEY);

    expect(summary).not.toContain('{');
    expect(summary).not.toContain('\n');
    expect(summary).not.toContain(name);
    expect(summary.length).toBeLessThanOrEqual(80);
  });

  it.each(names)('%s summarises its result as one line of text', (name) => {
    const result = `Recorded (verification v2).\n\nLedger:\n${'- an entry\n'.repeat(40)}`;
    const summary = TEAM_TOOL_PRESENTATION[name]!.summarizeResult(result, EVERY_INPUT_KEY);

    expect(summary.trim()).not.toBe('');
    expect(summary).not.toContain('\n');
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('summarises the status report rather than printing its JSON', () => {
    const status = JSON.stringify({
      teamId: 'team-7',
      phase: 'working',
      agents: [{ name: 'lead', status: 'running' }, { name: 'coder', status: 'completed' }],
    }, null, 2);

    for (const name of ['get_team_status', 'team_get_status']) {
      expect(TEAM_TOOL_PRESENTATION[name]!.summarizeResult(status, {}), `result summary for ${name}`)
        .toBe('working: 1 of 2 agents running');
    }
  });

  it('names the recipient rather than echoing the message id', () => {
    const sendMessage = TEAM_TOOL_PRESENTATION['team_send_message']!;
    const input = { to: 'lead', content: 'the parser is done' };

    expect(sendMessage.summarizeInput(input)).toBe('To lead: the parser is done');
    expect(sendMessage.summarizeResult('Message sent (id: c16959e3-3eb8-434d-9c4b-289eee27f1e6)', input)).toBe('Sent to lead');
  });

  it('names the scratchpad section rather than the raw arguments object', () => {
    const readScratchpad = TEAM_TOOL_PRESENTATION['team_read_scratchpad']!;

    expect(readScratchpad.summarizeInput({ section: 'mission-brief' })).toBe('mission-brief');
    expect(readScratchpad.summarizeInput({})).toBe('All sections');
    expect(readScratchpad.summarizeResult(JSON.stringify({ section: 'mission-brief', content: 'ship the parser', author: 'lead', version: 3 }), {}))
      .toBe('mission-brief v3: ship the parser');
  });

  it('counts the messages read and who sent them', () => {
    const readMessages = TEAM_TOOL_PRESENTATION['team_read_messages']!;
    const result = JSON.stringify([{ from: 'lead', content: 'go' }, { from: 'lead', content: 'again' }, { from: 'coder', content: 'done' }]);

    expect(readMessages.summarizeResult(result, {})).toBe('3 messages from lead, coder');
    expect(readMessages.summarizeResult('No new messages.', {})).toBe('No new messages.');
  });

  it('renders no IN row for a tool that takes no meaningful input', () => {
    for (const name of ['team_read_messages', 'team_get_status', 'team_standby', 'team_report_complete']) {
      expect(TEAM_TOOL_PRESENTATION[name]!.summarizeInput(EVERY_INPUT_KEY), `input summary for ${name}`).toBe('');
    }
  });

  it('clips a long input rather than letting it grow the card', () => {
    const summary = TEAM_TOOL_PRESENTATION['team_send_message']!.summarizeInput({ to: 'lead', content: 'x'.repeat(500) });

    // The cap is the whole width the card can hold, ellipsis included, so this number and the `<= 80`
    // the one-line invariant asserts above describe the same limit.
    expect(summary.length).toBe(80);
    expect(summary.endsWith('...')).toBe(true);
  });
});

/**
 * Every summarised value is text Damocles did not author, and it lands in a card row next to the
 * panel's own chrome. HTML escaping does not touch either of the two spoofs guarded here.
 */
describe('TEAM_TOOL_PRESENTATION untrusted text', () => {
  it('drops the bidi override that would reverse the reading order of the row', () => {
    const spoof = 'coder\u202Egnitirw ton ma I';
    const summary = TEAM_TOOL_PRESENTATION['team_cancel_specialist']!.summarizeInput({ name: spoof });

    expect(summary).not.toContain('\u202E');
    expect(summary).toBe('codergnitirw ton ma I');
  });

  it('drops every bidi mark, embedding and isolate, not just the override', () => {
    const marks = '\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    const summary = TEAM_TOOL_PRESENTATION['team_cancel_specialist']!.summarizeInput({ name: `a${marks}b` });

    expect(summary).toBe('ab');
  });

  it('ends the row at U+2028, which a renderer breaks on exactly like a newline', () => {
    const forged = 'coder\u2028Approved by the lead';
    const summary = TEAM_TOOL_PRESENTATION['team_cancel_specialist']!.summarizeInput({ name: forged });

    expect(summary).toBe('coder');
  });

  it('ends the row at a carriage return and at U+2029', () => {
    const cancel = TEAM_TOOL_PRESENTATION['team_cancel_specialist']!;

    expect(cancel.summarizeInput({ name: 'coder\rApproved by the lead' })).toBe('coder');
    expect(cancel.summarizeInput({ name: 'coder\u2029Approved by the lead' })).toBe('coder');
  });

  it('strips a result summary too, not only an input', () => {
    const result = JSON.stringify([{ from: 'coder\u202Ereversed', content: 'done' }]);
    const summary = TEAM_TOOL_PRESENTATION['team_read_messages']!.summarizeResult(result, {});

    expect(summary).not.toContain('\u202E');
    expect(summary).toBe('1 message from coderreversed');
  });

  it('leaves ordinary non-latin text alone', () => {
    // The strip removes formatting characters, never letters, so a legitimate name must survive whole.
    const summary = TEAM_TOOL_PRESENTATION['team_cancel_specialist']!.summarizeInput({ name: 'مطور Δοκιμή' });

    expect(summary).toBe('مطور Δοκιμή');
  });
});
