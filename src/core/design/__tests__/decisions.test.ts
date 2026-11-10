import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDecisionConflicts, DECISION_CONFLICTS_SYSTEM_PROMPT, DESIGN_CONFLICT_CHECK_TIMEOUT_MS } from '../decision-conflicts';
import {
  DecisionConflictError,
  DecisionRefusedError,
  decisionDraft,
  recheckUncheckedDecisions,
  recordChosenDecision,
  recordDesignDecision,
  recordQuestionDecisions,
  type RecordDecisionInput,
} from '../decisions';
import { decisionsMarkdown, fidelityOf, readManifest, writeDecisions } from '../design-files';
import { currentDecisions, decisionsOnBranch, MAX_DECISION_REFS, replacedBy, type DesignDecisionRecord } from '../design-entries';
import { writeMarkupFiles } from '../markup';
import { cleanJudge, decisionEntry, entry, flaggingJudge, judgeOf, memoryLedger, noModelJudge, record, signal } from './decision-kit';

const user = (text: string) => entry({ type: 'message', message: { role: 'user', content: text } });
const brief = (briefId: string) => entry({ type: 'custom_message', customType: 'damocles-design-brief', content: 'x', display: true, details: { briefId, text: 'x', reopened: false } });

const FIDELITY = { question: 'Static mockup or interactive prototype?', header: 'Fidelity', options: [{ label: 'Static mockup' }, { label: 'Interactive prototype' }] };
const DENSITY = { question: 'How dense is the table?', header: 'Density', options: [{ label: 'Comfortable' }, { label: 'Compact' }] };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function tempFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-decisions-'));
  folders.push(folder);
  return folder;
}
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const choose = (entries: Record<string, unknown>[], input: RecordDecisionInput, judge = cleanJudge()) => recordChosenDecision(memoryLedger(tempFolder(), entries), judge, input, signal());

describe('decisions recorded from answers', () => {
  it('records one decision per answered question, numbered from the branch root, and a re-answer replaces it', async () => {
    const ledger = memoryLedger(tempFolder());
    const made = await recordQuestionDecisions(ledger, cleanJudge(), [FIDELITY, DENSITY], { [FIDELITY.question]: 'Interactive prototype' }, signal());
    expect(made.records).toEqual([{ v: 1, id: 'D1', title: 'Fidelity', chosen: 'Interactive prototype', rejected: ['Static mockup'], source: { kind: 'question', ref: FIDELITY.question }, files: [], conflictCheck: 'checked' }]);
    const next = await recordQuestionDecisions(ledger, cleanJudge(), [DENSITY, FIDELITY], { [DENSITY.question]: 'Compact', [FIDELITY.question]: 'Static mockup' }, signal());
    expect(next.records.map((d) => [d.id, d.title, d.replaces])).toEqual([['D2', 'Density', undefined], ['D3', 'Fidelity', ['D1']]]);
    expect(currentDecisions(decisionsOnBranch(ledger.entries)).map((d) => d.id)).toEqual(['D2', 'D3']);
    expect(ledger.changes).toBe(3);
  });

  it('keeps a question\'s reference row on the decision its answer records, whose question source a re-answer still replaces', async () => {
    const CAROUSEL = { question: 'What replaces the carousel?', header: 'Carousel', options: [{ label: 'A static strip' }, { label: 'A grid' }], reference: 'R1#Carousel' };
    const ledger = memoryLedger(tempFolder());
    const made = await recordQuestionDecisions(ledger, cleanJudge(), [CAROUSEL, DENSITY], { [CAROUSEL.question]: 'A static strip', [DENSITY.question]: 'Compact' }, signal());
    expect(made.records.map((d) => [d.id, d.source, d.reference])).toEqual([['D1', { kind: 'question', ref: CAROUSEL.question }, 'R1#Carousel'], ['D2', { kind: 'question', ref: DENSITY.question }, undefined]]);
    const again = await recordQuestionDecisions(ledger, cleanJudge(), [CAROUSEL], { [CAROUSEL.question]: 'A grid' }, signal());
    expect(again.records[0]).toMatchObject({ id: 'D3', reference: 'R1#Carousel', replaces: ['D1'] });
    expect(decisionsOnBranch(ledger.entries).find((d) => d.id === 'D3')?.reference).toBe('R1#Carousel');
    expect(currentDecisions(decisionsOnBranch(ledger.entries)).map((d) => d.id)).toEqual(['D2', 'D3']);
  });

  it('records no decision for a free-text "Other" answer, and tells the designer to record the user\'s words (acceptance)', async () => {
    const ledger = memoryLedger(tempFolder());
    const made = await recordQuestionDecisions(ledger, cleanJudge(), [DENSITY], { [DENSITY.question]: 'Something between the two, like Linear' }, signal());
    expect(made.records).toEqual([]);
    expect(decisionsOnBranch(ledger.entries)).toEqual([]);
    expect(made.notes.join('\n')).toMatch(/No decision was recorded for "Density": the answer chose no option\. If the user decided something in it, record it with RecordDecision/);
  });

  it('stores the flags of an answer that contradicts a current decision, with the refining call that resolves them (acceptance)', async () => {
    const ledger = memoryLedger(tempFolder(), [decisionEntry(record('D8', 'Page shell', 'No wallpaper, white cards'))]);
    const judge = flaggingJudge([{ id: 'D8', kind: 'contradicts', reason: 'white cards vs no white surfaces' }]);
    const made = await recordQuestionDecisions(ledger, judge, [{ question: 'Which surfaces?', header: 'Surfaces', options: [{ label: 'Warm, no white' }, { label: 'White' }] }], { 'Which surfaces?': 'Warm, no white' }, signal());
    expect(made.records[0]).toMatchObject({ id: 'D9', conflicts: [{ id: 'D8', kind: 'contradicts', reason: 'white cards vs no white surfaces' }], conflictCheck: 'checked' });
    expect(made.notes.join('\n')).toContain('RecordDecision, source {kind: "question", ref: "D9"}, replaces: ["D9", "D8"]');
    // the refining decision replaces the flagged answer, so no current decision carries the flag
    const refined = await recordChosenDecision(ledger, cleanJudge(), { title: 'Surfaces', chosen: 'Warm, wallpaper with glass', source: { kind: 'question', ref: 'D9' }, replaces: ['D9', 'D8'] }, signal());
    expect(refined.record.id).toBe('D10');
    expect(currentDecisions(decisionsOnBranch(ledger.entries)).map((d) => d.id)).toEqual(['D10']);
  });

  it('records an answer unchecked when the check cannot run or the run was stopped', async () => {
    const ledger = memoryLedger(tempFolder(), [decisionEntry(record('D1', 'Accent colour', 'graphite'))]);
    const made = await recordQuestionDecisions(ledger, noModelJudge(), [DENSITY], { [DENSITY.question]: 'Compact' }, signal());
    expect(made.records[0]).toMatchObject({ id: 'D2', conflictCheck: 'unchecked', uncheckedReason: 'noModel' });
    expect(made.notes.join('\n')).toMatch(/The conflict check could not run for D2 \(no background model\)/);
    const stopped = new AbortController();
    stopped.abort();
    const later = await recordQuestionDecisions(ledger, cleanJudge(), [FIDELITY], { [FIDELITY.question]: 'Static mockup' }, stopped.signal);
    expect(later.records[0]).toMatchObject({ id: 'D3', conflictCheck: 'unchecked', uncheckedReason: 'stopped' });
    expect(later.notes.join('\n')).toMatch(/The conflict check could not run for D3 \(the check was stopped\)/);
  });
});

describe('which decision an answer replaces (G1-M3)', () => {
  const ACCENT = { question: 'Which accent colour?', header: 'Colour', options: [{ label: 'Taupe' }, { label: 'Graphite' }] };
  const TEXT = { question: 'Which text colour?', header: 'Colour', options: [{ label: 'Ink' }, { label: 'Slate' }] };

  it('replaces only the answer to the same question, whitespace collapsed and case-blind', async () => {
    const ledger = memoryLedger(tempFolder());
    await recordQuestionDecisions(ledger, cleanJudge(), [ACCENT], { [ACCENT.question]: 'Graphite' }, signal());
    const again = { ...ACCENT, question: '  which  ACCENT colour? ' };
    const made = await recordQuestionDecisions(ledger, cleanJudge(), [again], { [again.question]: 'Taupe' }, signal());
    expect(made.records.map((d) => [d.id, d.replaces])).toEqual([['D2', ['D1']]]);
    expect(currentDecisions(decisionsOnBranch(ledger.entries)).map((d) => d.id)).toEqual(['D2']);
  });

  it('keeps an unrelated question of the same header current, checks against it, and stores a contradiction as a flag that blocks the finish', async () => {
    const ledger = memoryLedger(tempFolder());
    await recordQuestionDecisions(ledger, cleanJudge(), [ACCENT], { [ACCENT.question]: 'Taupe' }, signal());
    const judge = flaggingJudge([{ id: 'D1', kind: 'contradicts', reason: 'taupe accent vs ink text' }]);
    const made = await recordQuestionDecisions(ledger, judge, [TEXT], { [TEXT.question]: 'Ink' }, signal());
    expect(made.records[0]).toMatchObject({ id: 'D2', conflicts: [{ id: 'D1', kind: 'contradicts' }] });
    expect(made.records[0]!.replaces).toBeUndefined();
    expect(judge.requests[0]!.userMessage).toContain('"id":"D1","title":"Colour"');
    expect(currentDecisions(decisionsOnBranch(ledger.entries)).map((d) => d.id)).toEqual(['D1', 'D2']);
  });

  it('records an answer whose title a RecordDecision holds, with no title refusal', async () => {
    const ledger = memoryLedger(tempFolder(), [decisionEntry(record('D1', 'Colour', 'Sand', { kind: 'chat', source: { kind: 'chat', ref: 'sand' } }))]);
    const made = await recordQuestionDecisions(ledger, cleanJudge(), [ACCENT], { [ACCENT.question]: 'Taupe' }, signal());
    expect(made.records.map((d) => d.id)).toEqual(['D2']);
    expect(made.notes).toEqual([]);
  });
});

describe('the bounds of a stored answer (G1-L2)', () => {
  it('stores at most MAX_DECISION_REFS flags, so the entry stays readable', async () => {
    const current = Array.from({ length: 70 }, (_, i) => decisionEntry(record(`D${i + 1}`, `Topic ${i + 1}`, 'x')));
    const ledger = memoryLedger(tempFolder(), current);
    const judge = judgeOf(() => ({ kind: 'answered', value: { flags: Array.from({ length: 70 }, (_, i) => ({ id: `D${i + 1}`, kind: 'contradicts', reason: 'r' })) } }));
    const made = await recordQuestionDecisions(ledger, judge, [DENSITY], { [DENSITY.question]: 'Compact' }, signal());
    expect(made.records[0]!.conflicts).toHaveLength(MAX_DECISION_REFS);
    expect(decisionsOnBranch(ledger.entries).at(-1)).toMatchObject({ id: 'D71', conflicts: expect.any(Array) });
    expect(decisionsOnBranch(ledger.entries).at(-1)!.conflicts).toHaveLength(MAX_DECISION_REFS);
  });
});

describe('a question that fails to record (G3-L9)', () => {
  it('keeps the records of the questions before and after it, with a note for it', async () => {
    const ledger = memoryLedger(tempFolder());
    let calls = 0;
    const judge = judgeOf(() => {
      if (++calls === 1) throw new Error('the sub-call broke');
      return { kind: 'answered', value: { flags: [] } };
    });
    const LAYOUT = { question: 'Which layout?', header: 'Layout', options: [{ label: 'Table' }, { label: 'Cards' }] };
    const made = await recordQuestionDecisions(ledger, judge, [FIDELITY, DENSITY, LAYOUT], { [FIDELITY.question]: 'Static mockup', [DENSITY.question]: 'Compact', [LAYOUT.question]: 'Table' }, signal());
    expect(made.records.map((d) => [d.id, d.title])).toEqual([['D1', 'Fidelity'], ['D2', 'Layout']]);
    expect(made.notes).toEqual(['The answer to "Density" was not recorded. the sub-call broke. Record what the user chose with RecordDecision.']);
    expect(decisionsOnBranch(ledger.entries).map((d) => d.title)).toEqual(['Fidelity', 'Layout']);
  });
});

describe('RecordDecision (D99)', () => {
  it('refuses "Accent" while "Accent colour" stands unless it names it, then records it as replacing D18 (acceptance)', async () => {
    const entries = [user('Actually taupe, not graphite'), decisionEntry(record('D18', 'Accent colour', 'graphite', { kind: 'chat', source: { kind: 'chat', ref: 'graphite' } }))];
    const judge = flaggingJudge([{ id: 'D18', kind: 'contradicts', reason: 'graphite vs taupe' }]);
    const input: RecordDecisionInput = { title: 'Accent', chosen: 'taupe', source: { kind: 'chat', ref: 'taupe, not graphite' } };
    const ledger = memoryLedger(tempFolder(), entries);
    const refused = recordChosenDecision(ledger, judge, input, signal());
    await expect(refused).rejects.toThrow(DecisionConflictError);
    await expect(recordChosenDecision(ledger, judge, input, signal())).rejects.toThrow('Not recorded: Accent conflicts with current decisions. D18 Accent colour (contradicts: graphite vs taupe). Call RecordDecision again with replaces: ["D18"] if this decision replaces it (restate anything that still holds), or stillHolds: ["D18"] if both stand.');
    expect(decisionsOnBranch(entries).map((d) => d.id)).toEqual(['D18']);
    const recorded = await recordChosenDecision(ledger, judge, { ...input, replaces: ['D18'] }, signal());
    expect(recorded.record).toMatchObject({ id: 'D19', title: 'Accent', chosen: 'taupe', replaces: ['D18'], conflictCheck: 'checked' });
    expect(replacedBy(decisionsOnBranch(entries)).get('D18')).toBe('D19');
    expect(currentDecisions(decisionsOnBranch(entries)).map((d) => d.id)).toEqual(['D19']);
  });

  it('refuses warm neutrals against slate neutrals with white cards the same way (acceptance)', async () => {
    const entries = [user('warm neutrals everywhere'), decisionEntry(record('D8', 'Page shell', 'Slate neutrals, white cards'))];
    const judge = flaggingJudge([{ id: 'D8', kind: 'contradicts', reason: 'warm vs slate neutrals' }]);
    await expect(choose(entries, { title: 'Palette', chosen: 'Warm neutrals', source: { kind: 'chat', ref: 'warm neutrals' } }, judge)).rejects.toThrow(/Not recorded: Palette conflicts with current decisions\. D8 Page shell \(contradicts: warm vs slate neutrals\)/);
    await expect(choose(entries, { title: 'Palette', chosen: 'Warm neutrals', source: { kind: 'chat', ref: 'warm neutrals' }, stillHolds: ['D8'] }, judge)).resolves.toMatchObject({ record: { id: 'D9', stillHolds: ['D8'] } });
  });

  it('leaves one current decision when a refinement of a question decision replaces it (acceptance: D36 refining D35)', async () => {
    const entries = [decisionEntry(record('D35', 'Paging', 'Infinite scroll'))];
    const judge = flaggingJudge([{ id: 'D35', kind: 'restates', reason: 'infinite scroll again' }]);
    await expect(choose(entries, { title: 'Loading more', chosen: 'Infinite scroll with a sentinel', source: { kind: 'question', ref: 'D35' } }, judge)).rejects.toThrow(/AskUserQuestion records each answer itself/);
    await expect(choose(entries, { title: 'Loading more', chosen: 'Infinite scroll', source: { kind: 'brief', ref: 'b-1' } }, judge)).rejects.toThrow(/No brief with id b-1/);
    const refined = await choose(entries, { title: 'Loading more', chosen: 'Infinite scroll with a sentinel', source: { kind: 'question', ref: 'D35' }, replaces: ['D35'] }, judge);
    expect(refined.record.id).toBe('D36');
    expect(currentDecisions(decisionsOnBranch(entries)).map((d) => d.id)).toEqual(['D36']);
  });

  it('checks names and titles before the model: a named id must be current, and a current title must be named', async () => {
    const entries = [user('use cards'), decisionEntry(record('D1', 'Layout', 'Table')), decisionEntry(record('D2', 'Layout v2', 'Cards', { replaces: ['D1'] }))];
    const judge = cleanJudge();
    await expect(choose(entries, { title: 'Grid', chosen: 'x', source: { kind: 'chat', ref: 'use cards' }, replaces: ['D1'] }, judge)).rejects.toThrow(/replaces names D1, which is not a current decision\. The current decisions: D2 Layout v2\./);
    await expect(choose(entries, { title: 'Grid', chosen: 'x', source: { kind: 'chat', ref: 'use cards' }, stillHolds: ['D7'] }, judge)).rejects.toThrow(/stillHolds names D7/);
    await expect(choose(entries, { title: 'layout V2', chosen: 'x', source: { kind: 'chat', ref: 'use cards' } }, judge)).rejects.toThrow('D2 Layout v2 already has this title. Call RecordDecision again with replaces: ["D2"]');
    await expect(choose(entries, { title: 'Grid', chosen: 'x', source: { kind: 'chat', ref: 'use cards' }, replaces: ['D2'], stillHolds: ['D2'] }, judge)).rejects.toThrow(/cannot be in both/);
    expect(judge.requests).toEqual([]);
  });

  it('records the decision unchecked with the decisions to review when no background model can run (acceptance)', async () => {
    const entries = [user('compact rows'), decisionEntry(record('D1', 'Fidelity', 'Static mockup'))];
    const recorded = await choose(entries, { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'compact rows' } }, noModelJudge());
    expect(recorded.record).toMatchObject({ id: 'D2', conflictCheck: 'unchecked', uncheckedReason: 'noModel' });
    expect(recorded.review.map((d) => d.id)).toEqual(['D1']);
  });

  it('gives a decision appended during the check its own id, and checks the call against it before it records (acceptance)', async () => {
    const ledger = memoryLedger(tempFolder(), [user('compact rows'), decisionEntry(record('D1', 'Fidelity', 'Static mockup'))]);
    let landed = false;
    const judge = judgeOf(async () => {
      if (!landed) {
        landed = true;
        // a subagent's answer lands while the check runs outside the lane
        await recordDesignDecision(ledger, async () => ({ v: 1, title: 'Accent', chosen: 'taupe', rejected: [], source: { kind: 'question', ref: 'Accent?' }, files: [] }));
      }
      return { kind: 'answered', value: { flags: [] } };
    });
    const recorded = await recordChosenDecision(ledger, judge, { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'compact rows' } }, signal());
    expect(decisionsOnBranch(ledger.entries).map((d) => [d.id, d.title])).toEqual([['D1', 'Fidelity'], ['D2', 'Accent'], ['D3', 'Density']]);
    expect(recorded.record).toMatchObject({ id: 'D3', conflictCheck: 'checked' });
    // the second run checks only the decision that landed
    expect(judge.requests).toHaveLength(2);
    expect(judge.requests[1]!.userMessage).toContain('"id":"D2","title":"Accent"');
    expect(judge.requests[1]!.userMessage).not.toContain('"id":"D1"');
  });

  it('runs the check again for a decision that landed meanwhile and refuses on its flag', async () => {
    const ledger = memoryLedger(tempFolder(), [user('graphite accent'), decisionEntry(record('D1', 'Fidelity', 'Static mockup'))]);
    let landed = false;
    const judge = judgeOf(async (request) => {
      if (!landed) {
        landed = true;
        await recordDesignDecision(ledger, async () => ({ v: 1, title: 'Accent colour', chosen: 'taupe', rejected: [], source: { kind: 'question', ref: 'Accent?' }, files: [] }));
        return { kind: 'answered', value: { flags: [] } };
      }
      return { kind: 'answered', value: { flags: request.userMessage.includes('"id":"D2"') ? [{ id: 'D2', kind: 'contradicts', reason: 'graphite vs taupe' }] : [] } };
    });
    await expect(recordChosenDecision(ledger, judge, { title: 'Accent', chosen: 'graphite', source: { kind: 'chat', ref: 'graphite accent' } }, signal())).rejects.toThrow(/D2 Accent colour \(contradicts: graphite vs taupe\)/);
    expect(decisionsOnBranch(ledger.entries).map((d) => d.id)).toEqual(['D1', 'D2']);
  });
});

describe('the decision sources', () => {
  it('records a RecordDecision only with a real source (acceptance)', async () => {
    const branch = [user('Let us make the table compact, please'), brief('b-1')];
    const folder = tempFolder();
    const fromChat = await decisionDraft(branch, { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'make the table compact' } }, folder);
    expect(fromChat.source).toEqual({ kind: 'chat', ref: 'make the table compact' });
    expect((await decisionDraft(branch, { title: 'Layout', chosen: 'Cards on mobile', source: { kind: 'brief', ref: 'b-1' } }, folder)).title).toBe('Layout');
    await expect(decisionDraft(branch, { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'the user said so' } }, folder)).rejects.toThrow(DecisionRefusedError);
    await expect(decisionDraft(branch, { title: 'Layout', chosen: 'x', source: { kind: 'brief', ref: 'B1' } }, folder)).rejects.toThrow('No brief with id B1 reached this chat. The briefs that did: b-1.');
    await expect(decisionDraft([], { title: 'Layout', chosen: 'x', source: { kind: 'brief', ref: 'B1' } }, folder)).rejects.toThrow('No brief with id B1 reached this chat. No brief reached it.');
    await expect(decisionDraft(branch, { title: 'x'.repeat(4001), chosen: 'y', source: { kind: 'brief', ref: 'b-1' } }, folder)).rejects.toThrow(/at most 4000/);
  });

  it('records a markup source only for a change pin of core\'s own feedback/F<n>.json (acceptance)', async () => {
    const folder = tempFolder();
    const markup = { screen: 'S1', file: 'screens/S1.html', viewport: { breakpoint: 'xl', width: 1280 }, zoom: 1, pixelRatio: 2, state: 'default', marks: [
      { type: 'pin', n: 1, kind: 'change', text: 'Taller rows', at: [40, 200], anchor: { element: 'ui/Table', facts: [] } },
      { type: 'pin', n: 2, kind: 'note', text: 'Nice header', at: [40, 20], anchor: null },
    ] } as const;
    await writeMarkupFiles(folder, 'F1', PNG_1x1, markup);
    const draft = await decisionDraft([], { title: 'Row height', chosen: 'Taller', source: { kind: 'markup', ref: 'F1#pin1' } }, folder);
    expect(draft.source).toEqual({ kind: 'markup', ref: 'F1#pin1' });
    await expect(decisionDraft([], { title: 'Header', chosen: 'Keep', source: { kind: 'markup', ref: 'F1#pin2' } }, folder)).rejects.toThrow(/Pin 2 of F1 is a note/);
    await expect(decisionDraft([], { title: 'x', chosen: 'y', source: { kind: 'markup', ref: 'F1#pin3' } }, folder)).rejects.toThrow(/F1 has no pin 3/);
    await expect(decisionDraft([], { title: 'x', chosen: 'y', source: { kind: 'markup', ref: 'F2#pin1' } }, folder)).rejects.toThrow(/No markup F2/);
    for (const ref of ['F1', 'F1#1', 'f1#pin1', 'F0#pin1', 'F1#pin1 ', '../F1#pin1']) {
      await expect(decisionDraft([], { title: 'x', chosen: 'y', source: { kind: 'markup', ref } }, folder)).rejects.toThrow(/is not one/);
    }
    fs.writeFileSync(path.join(folder, 'feedback', 'F3.json'), '{"marks": "nope"}');
    await expect(decisionDraft([], { title: 'x', chosen: 'y', source: { kind: 'markup', ref: 'F3#pin1' } }, folder)).rejects.toThrow(/cannot be read/);
  });

  it('records a tweak source only when chosen is the latest value kept for that tweak (acceptance)', async () => {
    const folder = tempFolder();
    const kept = (tweakId: string, value: string) => entry({ type: 'custom', customType: 'damocles-design-tweak-kept', data: { userEntryId: 'u1', toolCallId: 't1', tweakId, label: 'Corner radius', property: '--radius', value } });
    const branch = [kept('radius', '--radius-sm'), kept('radius', '--radius-lg')];
    expect((await decisionDraft(branch, { title: 'Corner radius', chosen: '--radius-lg', source: { kind: 'tweak', ref: 'radius' } }, folder)).source).toEqual({ kind: 'tweak', ref: 'radius' });
    await expect(decisionDraft(branch, { title: 'Corner radius', chosen: '--radius-sm', source: { kind: 'tweak', ref: 'radius' } }, folder)).rejects.toThrow(/kept --radius-lg/);
    await expect(decisionDraft(branch, { title: 'Accent', chosen: '--accent-blue', source: { kind: 'tweak', ref: 'accent' } }, folder)).rejects.toThrow(/No tweak "accent" was kept/);
    await expect(decisionDraft([], { title: 'Corner radius', chosen: '--radius-lg', source: { kind: 'tweak', ref: 'radius' } }, folder)).rejects.toThrow(DecisionRefusedError);
  });

  it('records a reference source only for a mapping row of an existing reference (acceptance)', async () => {
    const folder = tempFolder();
    fs.mkdirSync(path.join(folder, 'references'));
    fs.writeFileSync(path.join(folder, 'references', 'R1.json'), JSON.stringify({ schemaVersion: 1, image: 'references/R1.png', userEntryId: 'u1', sha256: 'x', mapping: [{ element: 'Hero card', mapsTo: null, status: 'needsDecision' }] }));
    fs.writeFileSync(path.join(folder, 'references', 'R2.json'), JSON.stringify({ schemaVersion: 1, image: 'references/R2.png', userEntryId: 'u2', sha256: 'y' }));
    expect((await decisionDraft([], { title: 'Hero', chosen: 'A new hero card', source: { kind: 'reference', ref: 'R1#Hero card' } }, folder)).source).toEqual({ kind: 'reference', ref: 'R1#Hero card' });
    await expect(decisionDraft([], { title: 'x', chosen: 'y', source: { kind: 'reference', ref: 'R1#Footer' } }, folder)).rejects.toThrow(/R1 has no mapping row "Footer"/);
    await expect(decisionDraft([], { title: 'x', chosen: 'y', source: { kind: 'reference', ref: 'R2#Hero card' } }, folder)).rejects.toThrow(/R2 has no mapping row/);
    await expect(decisionDraft([], { title: 'x', chosen: 'y', source: { kind: 'reference', ref: 'R3#Hero card' } }, folder)).rejects.toThrow(/No reference R3/);
    for (const ref of ['R1', 'R1#', 'r1#Hero card', '../R1#Hero card', 'R0#Hero card']) {
      await expect(decisionDraft([], { title: 'x', chosen: 'y', source: { kind: 'reference', ref } }, folder)).rejects.toThrow(/is not one/);
    }
  });
});

describe('decisions.md', () => {
  it('lists the current decisions first, then the replaced ones as history, and sets the manifest\'s fidelity (acceptance)', async () => {
    const folder = tempFolder();
    const decisions = [
      record('D1', 'Fidelity', 'Interactive prototype'),
      record('D2', 'Accent colour', 'graphite'),
      record('D3', 'Accent', 'taupe', { replaces: ['D2'], stillHolds: ['D1'] }),
      record('D4', 'Density', 'Compact', { conflictCheck: 'unchecked', uncheckedReason: 'noModel' }),
    ];
    await writeDecisions(folder, 'contacts-abcd1234', decisions);
    const markdown = fs.readFileSync(path.join(folder, 'decisions.md'), 'utf8');
    expect(markdown).toBe(decisionsMarkdown(decisions));
    expect(markdown.startsWith('<!-- Generated by Damocles')).toBe(true);
    const current = markdown.indexOf('# Current decisions');
    const history = markdown.indexOf('# History');
    expect(current).toBeLessThan(markdown.indexOf('## D1 · Fidelity'));
    expect(markdown.indexOf('## D4 · Density')).toBeLessThan(history);
    expect(markdown.indexOf('## D2 · Accent colour')).toBeGreaterThan(history);
    expect(markdown).toContain('- Replaces: D2\n- Holds alongside: D1');
    expect(markdown).toContain('- Replaced by: D3');
    expect(markdown).toContain('- Not checked for conflicts with other decisions');
    expect(markdown).not.toContain('- Reference:');
    expect(decisionsMarkdown([record('D1', 'Carousel', 'A static strip', { reference: 'R1#Carousel' })])).toContain('- Source: question (Carousel?)\n- Reference: R1#Carousel\n- Files: none');
    expect((await readManifest(folder, 'contacts-abcd1234')).fidelity).toBe('interactive');
    expect(fidelityOf([record('D1', 'Fidelity', 'Static mockup'), record('D2', 'Fidelity', 'Interactive prototype', { replaces: ['D1'] })])).toBe('interactive');
    expect(fidelityOf([])).toBeNull();
  });
});

describe('an answer whose option labels hold commas', () => {
  const LAYOUT = { question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Cards, then a table' }, { label: 'Table' }, { label: 'Cards' }] };
  const PARTS = { question: 'Which parts?', header: 'Parts', multiSelect: true, options: [{ label: 'Search, with filters' }, { label: 'Search' }, { label: 'Export' }] };
  const rejected = async (question: typeof LAYOUT | typeof PARTS, answer: string) => (await recordQuestionDecisions(memoryLedger(tempFolder()), cleanJudge(), [question], { [question.question]: answer }, signal())).records[0]?.rejected;

  it('takes a single-select answer that is one whole label as that label', async () => {
    expect(await rejected(LAYOUT, 'Cards, then a table')).toEqual(['Table', 'Cards']);
    expect(await rejected(LAYOUT, 'Cards')).toEqual(['Cards, then a table', 'Table']);
  });

  it('reads a multi-select answer as its labels joined with ", ", and typed text after them chooses no label', async () => {
    expect(await rejected(PARTS, 'Export, Search, with filters')).toEqual(['Search']);
    expect(await rejected(PARTS, 'Search, Export, and print')).toEqual(['Search, with filters']);
    expect(await rejected(PARTS, 'Something else')).toBeUndefined();
  });
});

describe('the Fidelity decision', () => {
  const fidelity = (chosen: string): DesignDecisionRecord => ({ v: 1, id: 'D1', title: 'Fidelity', chosen, rejected: [], source: { kind: 'question', ref: 'q' }, files: [] });

  it('sets the fidelity only from an answer that is one of the option labels, case-blind', () => {
    expect(fidelityOf([fidelity('Interactive prototype')])).toBe('interactive');
    expect(fidelityOf([fidelity('static MOCKUP')])).toBe('static');
    expect(fidelityOf([fidelity('Static mockups, not an interactive prototype')])).toBeNull();
    expect(fidelityOf([fidelity('Interactive')])).toBeNull();
  });
});

describe('decisions made in one batch (F3)', () => {
  it('number after the ones already on the branch, since each lands as an entry before its result', async () => {
    const ledger = memoryLedger(tempFolder(), [user('use compact rows and cards on mobile')]);
    const first = await recordChosenDecision(ledger, cleanJudge(), { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'compact rows' } }, signal());
    const second = await recordChosenDecision(ledger, cleanJudge(), { title: 'Mobile', chosen: 'Cards', source: { kind: 'chat', ref: 'cards on mobile' } }, signal());
    expect([first.record.id, second.record.id]).toEqual(['D1', 'D2']);
    const answered = await recordQuestionDecisions(ledger, cleanJudge(), [DENSITY], { [DENSITY.question]: 'Comfortable' }, signal());
    // an answer replaces only an earlier answer to the same question; the RecordDecision of the same title stays, checked against it
    expect(answered.records.map((d) => [d.id, d.replaces])).toEqual([['D3', undefined]]);
  });

  it('keeps the decision when decisions.md cannot be written, and reports the failure', async () => {
    // a design folder path that is a file, so no write below it can land
    const folder = path.join(tempFolder(), 'not-a-folder');
    fs.writeFileSync(folder, 'x');
    const ledger = memoryLedger(folder, [user('compact rows')]);
    const recorded = await recordChosenDecision(ledger, cleanJudge(), { title: 'Density', chosen: 'Compact', source: { kind: 'chat', ref: 'compact rows' } }, signal());
    expect(recorded.record.id).toBe('D1');
    expect(decisionsOnBranch(ledger.entries).map((d) => d.id)).toEqual(['D1']);
    expect(ledger.failures).toHaveLength(1);
  });
});

describe('the decision conflict check sub-call', () => {
  const current = [record('D18', 'Accent colour', 'graphite'), record('D2', 'Density', 'Compact')];

  it('returns the flags on current decisions it was given, cut to 200 characters, and drops any other id', async () => {
    const judge = judgeOf(() => ({ kind: 'answered', value: { flags: [{ id: 'D18', kind: 'contradicts', reason: `graphite vs taupe ${'x'.repeat(300)}` }, { id: 'D99', kind: 'restates', reason: 'not given' }] } }));
    const outcome = await checkDecisionConflicts(judge, { title: 'Accent', chosen: 'taupe', rejected: [] }, current, signal());
    expect(outcome).toMatchObject({ kind: 'checked', flags: [{ id: 'D18', kind: 'contradicts' }] });
    expect(outcome.kind === 'checked' && outcome.flags[0]!.reason.length).toBe(200);
    const request = judge.requests[0]!;
    expect([request.purpose, request.timeoutMs]).toEqual(['design-decision-conflicts', DESIGN_CONFLICT_CHECK_TIMEOUT_MS]);
    // the decisions are data in the user message, never in the system prompt
    expect(request.systemPrompt).toBe(DECISION_CONFLICTS_SYSTEM_PROMPT);
    expect(request.userMessage).toContain('"id":"D18","title":"Accent colour","chosen":"graphite"');
  });

  it('flags nothing for an empty answer, and makes no call with no current decision', async () => {
    const judge = cleanJudge();
    expect(await checkDecisionConflicts(judge, { title: 'Accent', chosen: 'taupe', rejected: [] }, current, signal())).toEqual({ kind: 'checked', flags: [] });
    expect(await checkDecisionConflicts(judge, { title: 'Accent', chosen: 'taupe', rejected: [] }, [], signal())).toEqual({ kind: 'checked', flags: [] });
    expect(judge.requests).toHaveLength(1);
  });

  it('cannot run with no model, an unreachable or refusing model, or an answer that is not the list', async () => {
    const candidate = { title: 'Accent', chosen: 'taupe', rejected: [] };
    expect(await checkDecisionConflicts(noModelJudge(), candidate, current, signal())).toEqual({ kind: 'unchecked', reason: 'noModel' });
    expect(await checkDecisionConflicts(judgeOf(() => ({ kind: 'unreachable', cause: 'credential' })), candidate, current, signal())).toEqual({ kind: 'unchecked', reason: 'unreachable' });
    expect(await checkDecisionConflicts(judgeOf(() => ({ kind: 'rejected' })), candidate, current, signal())).toEqual({ kind: 'unchecked', reason: 'rejected' });
    expect(await checkDecisionConflicts(judgeOf(() => ({ kind: 'answered', value: { flags: 'none' } })), candidate, current, signal())).toEqual({ kind: 'unchecked', reason: 'unanswered' });
  });
});

describe('FinishDesign\'s check of unchecked decisions', () => {
  const unchecked = (id: string, title: string, chosen: string, kind: 'question' | 'chat' = 'chat') => decisionEntry(record(id, title, chosen, { kind, ...(kind === 'chat' ? { source: { kind: 'chat', ref: chosen } } : {}), conflictCheck: 'unchecked', uncheckedReason: 'noModel' }));

  it('marks a clean decision checked, which clears the warning (acceptance)', async () => {
    const ledger = memoryLedger(tempFolder(), [decisionEntry(record('D1', 'Fidelity', 'Static mockup')), unchecked('D2', 'Density', 'Compact')]);
    expect(await recheckUncheckedDecisions(ledger, cleanJudge(), signal())).toEqual({ unchecked: [] });
    expect(decisionsOnBranch(ledger.entries).find((d) => d.id === 'D2')).toMatchObject({ conflictCheck: 'checked' });
    expect(decisionsOnBranch(ledger.entries).find((d) => d.id === 'D2')!.uncheckedReason).toBeUndefined();
  });

  it('refuses on a contradiction, storing a question decision\'s flag and naming the call that resolves each (acceptance)', async () => {
    const ledger = memoryLedger(tempFolder(), [decisionEntry(record('D8', 'Page shell', 'White cards')), unchecked('D23', 'Accent', 'taupe'), unchecked('D24', 'Surfaces', 'No white', 'question')]);
    const judge = judgeOf((request) => ({ kind: 'answered', value: { flags: request.userMessage.startsWith('The new decision:\n{"id":"D24"') ? [{ id: 'D8', kind: 'contradicts', reason: 'white cards vs no white' }] : [] } }));
    const recheck = await recheckUncheckedDecisions(ledger, judge, signal());
    expect(recheck.refusal).toMatch(/^FinishDesign refused: the conflict check found current decisions that conflict\./);
    expect(recheck.refusal).toContain('- D24 Surfaces conflicts with D8 Page shell (contradicts: white cards vs no white). Record what the user decided with RecordDecision, source {kind: "question", ref: "D24"}');
    const all = decisionsOnBranch(ledger.entries);
    expect(all.find((d) => d.id === 'D24')).toMatchObject({ conflictCheck: 'checked', conflicts: [{ id: 'D8', kind: 'contradicts' }] });
    expect(all.find((d) => d.id === 'D23')).toMatchObject({ conflictCheck: 'checked' });
  });

  it('refuses for a RecordDecision decision without recording a check, and names the unchecked ones it still cannot check', async () => {
    const ledger = memoryLedger(tempFolder(), [decisionEntry(record('D8', 'Page shell', 'White cards')), unchecked('D23', 'Surfaces', 'No white')]);
    const flagged = await recheckUncheckedDecisions(ledger, flaggingJudge([{ id: 'D8', kind: 'contradicts', reason: 'white vs no white' }]), signal());
    expect(flagged.refusal).toContain('Record it again with RecordDecision, replaces: ["D23", "D8"] if it replaces that decision (restate anything that still holds), or replaces: ["D23"] and stillHolds: ["D8"] if both stand.');
    expect(decisionsOnBranch(ledger.entries).find((d) => d.id === 'D23')).toMatchObject({ conflictCheck: 'unchecked' });
    expect(await recheckUncheckedDecisions(ledger, noModelJudge(), signal())).toEqual({ unchecked: [{ id: 'D23', reason: 'noModel' }] });
  });
});
