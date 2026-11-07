import { describe, expect, it } from 'vitest';
import type { JourneyStep } from '../../../shared/types/design';
import { runJourney, type JourneyCdpMethod } from '../design/design-journey';
import { contactsPage, FakeJourneyPage } from './fake-journey-page';
import contacts from '../../../../e2e/fixtures/design-app/static/contacts.preview-journey.json' with { type: 'json' };

const STEPS = contacts.steps as JourneyStep[];
const fast = (width: number, extra: { signal?: AbortSignal; highlight?: { pauseMs: number } } = {}) => ({ width, signal: extra.signal ?? new AbortController().signal, stepTimeoutMs: 30, pollMs: 1, ...(extra.highlight ? { highlight: extra.highlight } : {}) });
const ALLOWED: ReadonlySet<JourneyCdpMethod> = new Set(['DOM.getDocument', 'DOM.describeNode', 'DOM.resolveNode', 'DOM.scrollIntoViewIfNeeded', 'DOM.getContentQuads', 'DOM.focus', 'Accessibility.queryAXTree', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.releaseObjectGroup', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);

describe('runJourney (PD-45)', () => {
  it('passes the 11-step contacts journey through the accessibility tree and trusted input', async () => {
    for (const width of [390, 1280]) {
      const page = contactsPage(width);
      const result = await runJourney(page, STEPS, fast(width));
      expect(result).toEqual({ passed: true, steps: STEPS.map(() => ({ ok: true })) });
      expect(page.events).toEqual(['click 5', 'change 8', 'key Escape']);
      expect(page.elements.find((element) => element.id === 7)!.value).toBe('Ada Lovelace');
      expect(page.elements.find((element) => element.id === 2)!.value).toBe('Grace');
      expect(page.sent.every(([method]) => ALLOWED.has(method))).toBe(true);
      expect(page.sent.filter(([method]) => method === 'Accessibility.queryAXTree').map(([, params]) => params['role'] ?? null)).toContain('dialog');
    }
  });

  it('finds a label only by a <label>, aria-label or aria-labelledby, never by an element\'s own text', async () => {
    const page = contactsPage(1280);
    page.state['dialog'] = true;
    page.elements.push({ id: 9, tag: 'button', role: 'button', name: 'Name', nameFrom: 'contents' });
    const result = await runJourney(page, [{ action: 'assert', target: { label: 'Name' }, expect: { valueEquals: '' } }], fast(1280));
    expect(result.passed).toBe(true);
  });

  it('fails a step whose Escape leaves the dialog open, and runs nothing after it (acceptance)', async () => {
    const result = await runJourney(contactsPage(1280, { stuckDialog: true }), STEPS, fast(1280));
    expect(result.passed).toBe(false);
    expect(result.steps).toHaveLength(10);
    expect(result.steps[9]).toEqual({ ok: false, failure: 'expectation', message: 'dialog "New contact" is still visible at 1280 px.' });
  });

  it('reports a target hidden at a width with that width, never skipping it (acceptance)', async () => {
    const result = await runJourney(contactsPage(390, { addHiddenBelow: 640 }), STEPS, fast(390));
    expect(result.steps).toHaveLength(3);
    expect(result.steps[2]).toEqual({ ok: false, failure: 'hidden', hiddenAt: 390, message: 'No visible element matches button "Add contact" at 390 px.' });
  });

  it('refuses a target more than one element matches, and a click another element would take', async () => {
    const twice = contactsPage(1280);
    twice.elements.push({ id: 9, tag: 'button', role: 'button', name: 'Add contact', nameFrom: 'contents' });
    expect((await runJourney(twice, STEPS.slice(2, 4), fast(1280))).steps[0]).toMatchObject({ ok: false, failure: 'ambiguous' });
    const covered = new FakeJourneyPage([{ id: 5, tag: 'button', role: 'button', name: 'Save', nameFrom: 'contents', covered: true }], 1280);
    expect((await runJourney(covered, [{ action: 'click', target: { role: 'button', name: 'Save' } }, { action: 'assert', target: { role: 'button', name: 'Save' }, expect: { visible: true } }], fast(1280))).steps[0]).toMatchObject({ ok: false, failure: 'covered' });
    expect(covered.events).toEqual([]);
  });

  it('refuses fill on no text field and select of no option', async () => {
    const page = contactsPage(1280);
    page.state['dialog'] = true;
    const fillButton = await runJourney(page, [{ action: 'fill', target: { role: 'button', name: 'Add contact' }, value: 'x' }, STEPS[3]!], fast(1280));
    expect(fillButton.steps[0]).toMatchObject({ ok: false, failure: 'notEditable' });
    const noOption = await runJourney(page, [{ action: 'select', target: { label: 'Group' }, value: 'Friends' }, STEPS[7]!], fast(1280));
    expect(noOption.steps[0]).toMatchObject({ ok: false, failure: 'noOption', message: 'label "Group" has no enabled option with the value or label "Friends".' });
  });

  it('parses the page\'s answers as hostile: a malformed one fails the step, it never throws', async () => {
    const page = contactsPage(1280);
    const hostile = { send: async (method: JourneyCdpMethod, params: Record<string, unknown>) => (method === 'Accessibility.queryAXTree' ? { nodes: 'all of them' } : page.send(method, params)) };
    const result = await runJourney(hostile, STEPS.slice(2, 4), fast(1280));
    expect(result.steps[0]).toEqual({ ok: false, failure: 'error', message: 'The page failed the step: The page answered Accessibility.queryAXTree with something unexpected' });
  });

  it('outlines each target before its step acts when it replays, and stops at once on abort', async () => {
    const page = contactsPage(1280);
    await runJourney(page, STEPS.slice(2, 4), fast(1280, { highlight: { pauseMs: 0 } }));
    expect(page.highlighted).toEqual([5, 6]);
    const stop = new AbortController();
    stop.abort(new Error('Stopped'));
    await expect(runJourney(contactsPage(1280), STEPS, fast(1280, { signal: stop.signal }))).rejects.toThrow('Stopped');
  });
});
