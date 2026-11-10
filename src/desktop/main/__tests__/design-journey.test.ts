import { describe, expect, it } from 'vitest';
import type { JourneyStep, JourneyTarget } from '../../../shared/types/design';
import { runJourney, SCROLL_POSITION, type JourneyCdpMethod } from '../design/design-journey';
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

  it('matches exact: false as a case-insensitive part of the name or text, as Playwright does (acceptance)', async () => {
    const page = new FakeJourneyPage([
      { id: 2, tag: 'button', role: 'button', name: 'Save changes', nameFrom: 'contents', text: 'Save changes' },
      { id: 3, tag: 'button', role: 'button', name: 'Folding the sections (3 open)', nameFrom: 'contents', text: 'Folding the sections (3 open)' },
      { id: 4, tag: 'input', role: 'textbox', name: 'Email address', nameFrom: 'label', placeholder: 'you@example.com', value: '' },
    ], 1280);
    const visible = (target: JourneyTarget): JourneyStep => ({ action: 'assert', target, expect: { visible: true } });
    const loose = await runJourney(page, [visible({ text: 'save', exact: false }), visible({ role: 'button', name: 'folding  the SECTIONS', exact: false }), visible({ label: 'email', exact: false }), visible({ placeholder: 'EXAMPLE', exact: false })], fast(1280));
    expect(loose).toEqual({ passed: true, steps: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }] });
    // an inexact role query names the role alone and keeps the names that contain the text
    expect(page.sent.find(([method, params]) => method === 'Accessibility.queryAXTree' && params['role'] === 'button')![1]).toEqual({ backendNodeId: 1, role: 'button' });
    const exact = await runJourney(page, [visible({ text: 'save' })], fast(1280));
    expect(exact.steps[0]).toMatchObject({ ok: false, failure: 'hidden' });
  });

  it('fails an inexact role look whose role lists more nodes than it reads, rather than missing a match past them', async () => {
    const page = new FakeJourneyPage(Array.from({ length: 1025 }, (_, index) => ({ id: index + 2, tag: 'button' as const, role: 'button', name: `Row ${index}`, nameFrom: 'contents' as const })), 1280);
    const result = await runJourney(page, [{ action: 'assert', target: { role: 'button', name: 'row 1024', exact: false }, expect: { visible: true } }], fast(1280));
    expect(result.steps[0]).toEqual({ ok: false, failure: 'ambiguous', message: 'Too many button elements at 1280 px to search for button ~"row 1024"; use an exact name.' });
  });

  it('presses as locator.press does: focus that an element may refuse, then the key to the focused element or the page (acceptance)', async () => {
    const page = new FakeJourneyPage([
      { id: 6, tag: 'div', role: 'dialog', name: 'Menu', nameFrom: 'aria-label', shown: (current) => current.state['open'] === true },
    ], 1280);
    page.state['open'] = true;
    page.documentKey = (key, current) => {
      if (key === 'Escape') current.state['open'] = false;
    };
    const result = await runJourney(page, [{ action: 'press', target: { role: 'dialog', name: 'Menu' }, key: 'Escape' }, { action: 'assert', target: { role: 'dialog', name: 'Menu' }, expect: { visible: false } }], fast(1280));
    expect(result.passed).toBe(true);
    expect(page.sent.some(([method]) => method === 'DOM.focus')).toBe(false);
    expect(page.events).toEqual(['key Escape']);
  });

  it('scrolls a target into view, and to: "end" wheels the page or the target box to its end, loading the next batch (acceptance)', async () => {
    const page = new FakeJourneyPage([
      { id: 2, tag: 'ul', role: 'list', name: 'Results', nameFrom: 'aria-label', scroll: { top: 0, height: 2000, visible: 400 } },
      { id: 3, tag: 'span', text: 'Item 21', shown: (current) => current.state['loaded'] === true },
    ], 1280);
    page.scroll.height = 3000;
    page.onScrolledToEnd = (current) => {
      current.state['loaded'] = true;
    };
    const more: JourneyStep = { action: 'assert', target: { text: 'Item 21' }, expect: { visible: true } };
    expect(await runJourney(page, [{ action: 'scroll', to: 'end' }, more], fast(1280))).toEqual({ passed: true, steps: [{ ok: true }, { ok: true }] });
    expect(page.scroll.top).toBe(2100);
    await runJourney(page, [{ action: 'scroll', target: { role: 'list', name: 'Results' }, to: 'end' }, more], fast(1280));
    expect(page.elements[0]!.scroll!.top).toBe(1600);
    expect(page.events).toEqual(['wheel page', 'wheel 2']);
    expect(page.sent.filter(([method]) => method === 'DOM.scrollIntoViewIfNeeded').length).toBeGreaterThan(0);
  });

  it('wheels the box that scrolls a target that does not scroll itself: its scrolling ancestor, else the page (acceptance)', async () => {
    const page = new FakeJourneyPage([
      { id: 2, tag: 'ul', role: 'list', name: 'Results', nameFrom: 'aria-label' },
      { id: 4, tag: 'div', role: 'region', name: 'Feed', nameFrom: 'aria-label', scroll: { top: 0, height: 1500, visible: 500 } },
      { id: 5, tag: 'ul', role: 'list', name: 'Posts', nameFrom: 'aria-label', parent: 4 },
      { id: 3, tag: 'span', text: 'Item 21', shown: (current) => current.state['loaded'] === true },
    ], 1280);
    page.scroll.height = 3000;
    page.onScrolledToEnd = (current) => {
      current.state['loaded'] = true;
    };
    const more: JourneyStep = { action: 'assert', target: { text: 'Item 21' }, expect: { visible: true } };
    expect(await runJourney(page, [{ action: 'scroll', target: { role: 'list', name: 'Results' }, to: 'end' }, more], fast(1280))).toEqual({ passed: true, steps: [{ ok: true }, { ok: true }] });
    expect(page.scroll.top).toBe(2100);
    await runJourney(page, [{ action: 'scroll', target: { role: 'list', name: 'Posts' }, to: 'end' }, more], fast(1280));
    expect(page.elements[1]!.scroll!.top).toBe(1000);
    expect(page.events).toEqual(['wheel page', 'wheel 4']);
  });

  it('measures the scroll box the wheel chains to in the page\'s own terms', () => {
    const box = (overflowY: string, scrollHeight: number, clientHeight: number, parentElement: unknown) => ({ overflowY, scrollTop: 7, scrollHeight, clientHeight, parentElement, getRootNode: () => ({}) });
    const body = { overflowY: 'visible', parentElement: null };
    const scrollingElement = { scrollTop: 40, scrollHeight: 3000, clientHeight: 900 };
    const measure = new Function('document', 'getComputedStyle', 'ShadowRoot', `return ${SCROLL_POSITION};`)({ body, documentElement: scrollingElement, scrollingElement }, (element: { overflowY: string }) => ({ overflowY: element.overflowY }), class {}) as (element: unknown) => number[];
    const feed = box('auto', 1500, 500, body);
    expect(measure(box('visible', 400, 400, feed))).toEqual([7, 1500, 500]);
    // a box that could scroll but has nothing more to show passes the wheel on, as does one that clips
    expect(measure(box('visible', 400, 400, box('auto', 500, 500, box('hidden', 2000, 500, body))))).toEqual([40, 3000, 900]);
    expect(measure(null)).toEqual([40, 3000, 900]);
  });

  it('settles the page after each action that passed, before the next step looks', async () => {
    const order: string[] = [];
    const page = contactsPage(1280);
    const traced = { send: (method: JourneyCdpMethod, params: Record<string, unknown>) => {
      if (method.startsWith('Input.')) order.push(method);
      return page.send(method, params);
    } };
    await runJourney(traced, STEPS.slice(2, 4), { ...fast(1280), afterAction: async () => void order.push('settle') });
    expect(order.slice(-2)).toEqual(['Input.dispatchMouseEvent', 'settle']);
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
