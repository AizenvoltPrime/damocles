import { describe, expect, it } from 'vitest';
import { describeJourneyTarget, journeyNeedsScrollFeature, MAX_JOURNEY_STEPS, parseJourneySteps, parseJourneyUntested } from '../../../shared/design-journey';
import type { JourneyFile, JourneyStep } from '../../../shared/types/design';
import { journeyFilesOf, journeyOnBranch, journeyStanding, parseJourneyFile, prepareJourneyArguments, screenContentHash } from '../journey';
import contacts from '../../../../e2e/fixtures/design-app/static/contacts.preview-journey.json' with { type: 'json' };

const STEPS = contacts.steps as JourneyStep[];
const click: JourneyStep = { action: 'click', target: { role: 'button', name: 'Add contact' } };
const shown: JourneyStep = { action: 'assert', target: { role: 'dialog', name: 'New contact' }, expect: { visible: true } };

const problemsOf = (raw: unknown): string[] => {
  const parsed = parseJourneySteps(raw);
  return 'problems' in parsed ? parsed.problems : [];
};

describe('a journey\'s steps (PD-13, PD-45)', () => {
  it('takes the 11-step contacts journey as it is', () => {
    expect(parseJourneySteps(STEPS)).toEqual({ steps: STEPS });
  });

  it('takes 16 steps, asserts counted, and refuses a 17-step call before anything runs (acceptance)', () => {
    const sixteen = Array.from({ length: MAX_JOURNEY_STEPS / 2 }, () => [click, shown]).flat();
    expect(parseJourneySteps(sixteen)).toEqual({ steps: sixteen });
    expect(problemsOf([...sixteen, shown])).toEqual([expect.stringMatching(/^A journey has at most 16 steps, asserts counted; this one has 17\./)]);
  });

  it('refuses an action that no assert follows, the last step included', () => {
    expect(problemsOf([click, click, shown])).toEqual(['step 1: every action must be followed by an assert of its outcome.']);
    expect(problemsOf([shown, click])).toEqual(['step 2: every action must be followed by an assert of its outcome.']);
    expect(problemsOf([shown, shown])).toEqual([]);
  });

  it('takes only accessible targets, never a CSS or data-ds selector', () => {
    expect(problemsOf([{ action: 'click', target: { selector: '#save' } }, shown])).toEqual(['step 1: target must be exactly one of {role, name}, {label}, {placeholder} or {text}, with an optional exact; never a CSS selector.']);
    expect(problemsOf([{ action: 'click', target: { role: 'button', name: 'Save', label: 'Save' } }, shown])).toHaveLength(1);
    expect(problemsOf([{ action: 'click', target: { role: 'save-button', name: 'Save' } }, shown])).toEqual(['step 1: "save-button" is not an ARIA role.']);
  });

  it('bounds names, values and text, and keeps control characters out of targets', () => {
    expect(problemsOf([{ action: 'click', target: { text: 'x'.repeat(201) } }, shown])).toEqual(['step 1: the text is longer than 200 characters.']);
    expect(problemsOf([{ action: 'click', target: { label: 'Na\nme' } }, shown])).toEqual(['step 1: the label holds a control character.']);
    expect(problemsOf([{ action: 'fill', target: { label: 'Notes' }, value: 'x'.repeat(1001) }, shown])).toEqual(['step 1: value is longer than 1000 characters.']);
    expect(problemsOf([{ action: 'fill', target: { label: 'Notes' }, value: 'two\nlines' }, shown])).toEqual([]);
    expect(problemsOf([{ action: 'fill', target: { label: 'Notes' }, value: '' }, shown])).toEqual([]);
    expect(problemsOf([{ action: 'select', target: { label: 'Group' }, value: '' }, shown])).toEqual(['step 1: value must be text that is not empty.']);
  });

  it('takes each action\'s own fields only, and exactly one expectation on an assert', () => {
    expect(problemsOf([{ action: 'press', target: { label: 'Name' }, key: 'F5' }, shown])).toEqual(['step 1: key must be one of Enter, Escape, Tab, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight.']);
    expect(problemsOf([{ action: 'click', target: { label: 'Name' }, value: 'x' }, shown])).toEqual(['step 1: click takes only a target.']);
    expect(problemsOf([{ action: 'assert', target: { label: 'Name' }, expect: { visible: true, valueEquals: 'x' } }])).toEqual(['step 1: expect must be exactly one of {visible}, {textContains} or {valueEquals}.']);
    expect(problemsOf([{ action: 'assert', target: { label: 'Name' } }])).toHaveLength(1);
    expect(problemsOf([{ action: 'hover', target: { label: 'Name' } }])).toContain('step 1: action must be fill, select, click, press, scroll or assert.');
  });

  it('takes exact on any target, absent meaning exact, and only as true or false (acceptance)', () => {
    const loose: JourneyStep = { action: 'assert', target: { text: 'save', exact: false }, expect: { visible: true } };
    expect(parseJourneySteps([loose])).toEqual({ steps: [loose] });
    expect(parseJourneySteps([{ action: 'click', target: { role: 'button', name: 'Folding the sections', exact: false } }, shown])).toEqual({ steps: [{ action: 'click', target: { role: 'button', name: 'Folding the sections', exact: false } }, shown] });
    expect(problemsOf([{ action: 'assert', target: { label: 'Name', exact: 'no' }, expect: { visible: true } }])).toEqual(['step 1: target.exact must be true or false.']);
    expect(parseJourneySteps([{ action: 'assert', target: { label: 'Name', exact: true }, expect: { visible: true } }])).toEqual({ steps: [{ action: 'assert', target: { label: 'Name' }, expect: { visible: true } }] });
    expect(describeJourneyTarget(loose.target)).toBe('text ~"save"');
  });

  it('takes a scroll to a target, to the end, or both, and nothing else on it (acceptance)', () => {
    const more: JourneyStep = { action: 'assert', target: { text: 'Item 21' }, expect: { visible: true } };
    expect(parseJourneySteps([{ action: 'scroll', to: 'end' }, more])).toEqual({ steps: [{ action: 'scroll', to: 'end' }, more] });
    expect(parseJourneySteps([{ action: 'scroll', target: { role: 'list', name: 'Results' }, to: 'end' }, more])).toEqual({ steps: [{ action: 'scroll', target: { role: 'list', name: 'Results' }, to: 'end' }, more] });
    expect(problemsOf([{ action: 'scroll' }, more])).toEqual(['step 1: scroll needs a target to scroll into view, to: "end", or both.']);
    expect(problemsOf([{ action: 'scroll', to: 'top' }, more])).toEqual(['step 1: to must be "end".']);
    expect(problemsOf([{ action: 'scroll', to: 'end', value: 'x' }, more])).toEqual(['step 1: scroll takes a target, to: "end", or both.']);
    expect(problemsOf([{ action: 'scroll', to: 'end' }])).toEqual(['step 1: every action must be followed by an assert of its outcome.']);
  });

  it('lets a render\'s steps stand without asserts, and names an app update for scroll and any explicit exact', () => {
    expect(parseJourneySteps([click], { asserts: false })).toEqual({ steps: [click] });
    expect(journeyNeedsScrollFeature(STEPS)).toBe(false);
    expect(journeyNeedsScrollFeature([{ action: 'scroll', to: 'end' }])).toBe(true);
    expect(journeyNeedsScrollFeature([{ action: 'assert', target: { text: 'save', exact: false }, expect: { visible: true } }])).toBe(true);
    expect(journeyNeedsScrollFeature([{ action: 'assert', target: { text: 'save', exact: true }, expect: { visible: true } }])).toBe(true);
  });

  it('turns a malformed argument into one sentence naming the step and field, never a validator dump (acceptance)', () => {
    expect(() => prepareJourneyArguments({ screen: 'screens/S1-contacts.html', steps: [{ action: 'click', target: { css: '#x' } }, shown], untested: [] })).toThrow('PreviewJourney ran nothing: step 1: target must be exactly one of {role, name}, {label}, {placeholder} or {text}, with an optional exact; never a CSS selector.');
    expect(() => prepareJourneyArguments({ screen: 'screens/S1-contacts.html', steps: [{ action: 'hover' }, { action: 'click' }], untested: [] })).toThrow(/^PreviewJourney ran nothing: step 1: [^\n]+ \(\d+ more problems? after this one\.\)$/);
    expect(() => prepareJourneyArguments({ screen: 'screens/S1-contacts.html', steps: STEPS })).toThrow('PreviewJourney ran nothing: untested must be a list.');
    expect(prepareJourneyArguments({ screen: 'screens/S1-contacts.html', steps: STEPS, untested: [] })).toEqual({ screen: 'screens/S1-contacts.html', steps: STEPS, untested: [] });
  });

  it('bounds the untested remainder', () => {
    expect(parseJourneyUntested(['Saving a contact'])).toEqual({ untested: ['Saving a contact'] });
    expect(parseJourneyUntested([])).toEqual({ untested: [] });
    expect(parseJourneyUntested(Array.from({ length: 17 }, () => 'x'))).toEqual({ problems: ['untested lists at most 16 items.'] });
    expect(parseJourneyUntested(['x'.repeat(301)])).toEqual({ problems: ['untested 1 is longer than 300 characters.'] });
  });

  it('describes a target for the model', () => {
    expect(STEPS.map((step) => describeJourneyTarget(step.target)).slice(0, 3)).toEqual(['placeholder "Search contacts"', 'list "Contacts"', 'button "Add contact"']);
  });
});

describe('journey files', () => {
  it('are named for the screen file\'s stem, and only a plain stem has one', () => {
    expect(journeyFilesOf('screens/S1-contacts.html')).toEqual({ journeyFile: 'screens/S1-contacts.journey.json', specFile: 'screens/S1-contacts.journey.spec.ts' });
    expect(journeyFilesOf('screens/S1 contacts.html')).toBeUndefined();
    expect(journeyFilesOf('variants/a/S1.html')).toBeUndefined();
  });

  const file = (overrides: Partial<JourneyFile> = {}): JourneyFile => ({
    schemaVersion: 1,
    screen: 'S1',
    file: 'screens/S1-contacts.html',
    viewports: [{ breakpoint: 'base', width: 390 }, { breakpoint: 'xl', width: 1280 }],
    state: 'default',
    contentHash: screenContentHash(Buffer.from('<html></html>')),
    renderHash: 'render-1',
    steps: STEPS,
    results: [390, 1280].map((width) => ({ width, passed: true, steps: STEPS.map(() => ({ ok: true })) })),
    untested: ['Saving a contact'],
    passed: true,
    ranAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('parse only when every part fits the format', () => {
    expect(parseJourneyFile(file())).toEqual(file());
    expect(parseJourneyFile({ ...file(), steps: [...STEPS, ...STEPS] })).toBeUndefined();
    expect(parseJourneyFile({ ...file(), results: [file().results[0]] })).toBeUndefined();
    expect(parseJourneyFile({ ...file(), results: file().results.map((result) => ({ ...result, steps: [{ ok: false, failure: 'teleported' }] })) })).toBeUndefined();
  });

  it('vouch for the screen only at its current render inputs and at every journey width (PD-21, D86)', () => {
    const hash = 'render-1';
    expect(journeyStanding(file(), hash, [390, 1280])).toEqual({ passes: true });
    expect(journeyStanding(undefined, hash, [390, 1280])).toEqual({ passes: false, reason: 'missing' });
    expect(journeyStanding(file(), 'render-2', [390, 1280])).toEqual({ passes: false, reason: 'stale' });
    const { renderHash: _dropped, ...withoutRenderHash } = file();
    expect(parseJourneyFile(withoutRenderHash)).toEqual(withoutRenderHash);
    expect(journeyStanding(withoutRenderHash, hash, [390, 1280])).toEqual({ passes: false, reason: 'stale' });
    expect(journeyStanding(file(), hash, [390, 768, 1280])).toEqual({ passes: false, reason: 'widths' });
    const failedAtBase = file({ passed: false, results: [{ width: 390, passed: false, steps: [{ ok: false, failure: 'hidden', hiddenAt: 390 }] }, file().results[1]!] });
    expect(journeyStanding(failedAtBase, hash, [390, 1280])).toEqual({ passes: false, reason: 'failed' });
    expect(journeyStanding(failedAtBase, hash, [1280])).toEqual({ passes: true });
  });
});

describe('a replay\'s journey', () => {
  const result = (toolCallId: string, details: unknown, toolName = 'PreviewJourney') => ({ type: 'message', message: { role: 'toolResult', toolName, toolCallId, content: [], details } });
  const details = { relPath: 'screens/S1-contacts.html', state: 'default', steps: STEPS };

  it('is read from the branch\'s PreviewJourney result of that call, never from elsewhere', () => {
    expect(journeyOnBranch([result('call-1', details)], 'call-1')).toEqual({ relPath: 'screens/S1-contacts.html', state: 'default', steps: STEPS });
    expect(journeyOnBranch([result('call-1', details)], 'call-2')).toBeUndefined();
    expect(journeyOnBranch([result('call-1', details, 'DesignCheck')], 'call-1')).toBeUndefined();
  });

  it('refuses a result whose screen or steps are outside the format', () => {
    expect(journeyOnBranch([result('call-1', { ...details, relPath: '../outside.html' })], 'call-1')).toBeUndefined();
    expect(journeyOnBranch([result('call-1', { ...details, steps: [{ action: 'click', target: { selector: 'a' } }] })], 'call-1')).toBeUndefined();
    expect(journeyOnBranch([result('call-1', { ...details, state: '"]' })], 'call-1')).toBeUndefined();
  });
});
