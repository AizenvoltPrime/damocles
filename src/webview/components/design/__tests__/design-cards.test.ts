// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { DesignChatStateView, DesignCheckSummary, DesignResultView, PlanApprovalDesignLink } from '@shared/types/design';
import { DESIGN_DECISIONS_DETAIL_KEY } from '@shared/types/design';
import { TOOL_DESIGN_CHECK, TOOL_DESIGN_SCREENSHOT, TOOL_EXTRACT_TOKENS, TOOL_FINISH_DESIGN, TOOL_INVENTORY, TOOL_LOAD_DESIGN_SKILL, TOOL_RECORD_DECISION, TOOL_START_DESIGN } from '@shared/tool-names';
import type { ToolCall } from '@shared/types/session';
import { i18n } from '@/i18n';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDesignStore } from '@/stores/useDesignStore';
import { SEND_PROMPT_KEY } from '@/composables/useSendPrompt';
import DesignResultCard from '../DesignResultCard.vue';
import DesignPlanStrip from '../DesignPlanStrip.vue';
import DesignHeader from '../DesignHeader.vue';
import { DESIGN_STRIP } from '../design-strip';
import DesignCheckReport from '../DesignCheckReport.vue';
import DesignToolCard from '../DesignToolCard.vue';
import StartDesignToolCard from '../StartDesignToolCard.vue';
import FinishDesignToolCard from '../FinishDesignToolCard.vue';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const RESULT: DesignResultView = {
  designId: 'contacts-1a2b3c4d',
  version: 2,
  folder: '/home/u/.damocles/designs/contacts-1a2b3c4d',
  title: 'Contacts',
  screens: ['S1', 'S2'],
  decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Interactive prototype' }, { id: 'D2', title: 'Layout', chosen: 'Table' }],
  check: { errors: 0, warnings: [{ rule: 'ds.hidden-required', severity: 'warning', screen: 'S1', element: 'input#email', message: 'A required field is hidden at sm' }] },
  journeys: [],
  previousVersion: 1,
  changes: [{ kind: 'screenAdded', screen: 'S2' }, { kind: 'decisionAdded', id: 'D2', title: 'Layout', chosen: 'Table' }],
};

const DESIGN: DesignChatStateView = {
  designId: RESULT.designId, title: 'Design · Contacts', folder: RESULT.folder, parentSessionId: 'parent-1', parentTitle: 'Contacts',
  status: 'draft', version: null, fidelity: 'interactive', ruleSet: 'full', enabled: true, superseded: false, supersededBy: null,
  decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Interactive prototype', rejected: ['Static mockup'], source: { kind: 'question', ref: 'call_1' } }],
};

const mounted: VueWrapper[] = [];
function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  i18n.global.locale.value = 'en';
});

describe('the Design finished card', () => {
  const sent: string[] = [];
  let dispatched = true;
  const resultCard = (): VueWrapper => track(mount(DesignResultCard, {
    props: { result: RESULT, entryId: 'e1' },
    global: { plugins: [i18n], provide: { [SEND_PROMPT_KEY as symbol]: (prompt: string) => (dispatched && sent.push(prompt) > 0) } },
  }));
  const awaiting = (entryId: string | null): void => useDesignStore().setState(null, {
    designId: RESULT.designId, title: 'Contacts', folder: RESULT.folder, designSessionId: 'd1', status: 'finished', version: 2, awaitingContinue: entryId,
  });

  beforeEach(() => {
    sent.length = 0;
    dispatched = true;
    useStreamingStore().messages = [
      { id: 'u1', role: 'user', content: 'Design the contacts page first', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'Opening a design chat.', timestamp: 2 },
    ];
  });

  it('titles the version and summarizes screens, decisions, the check and its warnings', () => {
    const card = resultCard();

    expect(card.get('[data-testid="design-result-title"]').text()).toBe('Design finished · v2');
    expect(card.get('[data-testid="design-result-subtitle"]').text()).toBe('2 screens · 2 decisions · check passed · 1 warning');
    expect(card.get('[data-testid="design-result-decisions"]').text()).toContain('D1 Fidelity · Interactive prototype');
    expect(card.get('[data-testid="design-result-changes"]').text()).toContain('Changed since v1');
  });

  it('names a warning by its rule and element in the view\'s language, never by the check\'s English message', async () => {
    const card = resultCard();
    const warning = card.get('[data-testid="design-result-warning"]');

    expect(warning.attributes('data-rule')).toBe('ds.hidden-required');
    expect(warning.text()).toBe('Required field hidden at a width S1 input#email');
    expect(warning.text()).not.toContain('A required field is hidden at sm');

    i18n.global.locale.value = 'el';
    await nextTick();
    expect(card.get('[data-testid="design-result-warning"]').text()).toBe('Υποχρεωτικό πεδίο κρυμμένο σε κάποιο πλάτος S1 input#email');
    i18n.global.locale.value = 'en';
  });

  it('counts the warnings a capped rule left out of its list', () => {
    const capped: DesignResultView = { ...RESULT, check: { errors: 0, warnings: [{ ...RESULT.check.warnings[0]!, more: 4 }] } };
    const card = track(mount(DesignResultCard, { props: { result: capped, entryId: 'e1' }, global: { plugins: [i18n] } }));

    expect(card.get('[data-testid="design-result-subtitle"]').text()).toBe('2 screens · 2 decisions · check passed · 5 warnings');
    expect(card.get('[data-testid="design-result-warning-more"]').text()).toBe('4 more on this screen');
  });

  it('words the changes since the last version from their kinds, in the view\'s language', async () => {
    const card = resultCard();
    const changes = card.findAll('[data-testid="design-change"]');

    expect(changes.map((change) => change.attributes('data-kind'))).toEqual(['screenAdded', 'decisionAdded']);
    expect(changes.map((change) => change.text())).toEqual(['S2 added', 'D2 Layout · Table']);

    i18n.global.locale.value = 'el';
    await nextTick();
    expect(card.findAll('[data-testid="design-change"]')[0]!.text()).toBe('S2 προστέθηκε');
    i18n.global.locale.value = 'en';
  });

  it('shows Continue only for the card core says nothing answered, and sends the plain continue message once', async () => {
    const card = resultCard();
    expect(card.find('[data-testid="design-result-continue"]').exists()).toBe(false);

    awaiting('e1');
    await nextTick();
    const button = card.get('[data-testid="design-result-continue"]');
    await button.trigger('click');
    await button.trigger('click');
    expect(sent).toEqual(['Continue with design v2']);

    // The run answers it: hidden while it runs, and core names no card once it settled.
    useUIStore().setProcessing(true);
    await nextTick();
    expect(card.find('[data-testid="design-result-continue"]').exists()).toBe(false);
    awaiting(null);
    useUIStore().setProcessing(false);
    await nextTick();
    expect(card.find('[data-testid="design-result-continue"]').exists()).toBe(false);
  });

  it('keeps Continue clickable when the composer did not send it', async () => {
    awaiting('e1');
    dispatched = false;
    const card = resultCard();
    await nextTick();

    await card.get('[data-testid="design-result-continue"]').trigger('click');
    expect(card.get('[data-testid="design-result-continue"]').attributes('disabled')).toBeUndefined();

    dispatched = true;
    await card.get('[data-testid="design-result-continue"]').trigger('click');
    expect(sent).toEqual(['Continue with design v2']);
  });

  it('reads Continue from core, not the transcript: a message after the card that left the transcript changes nothing', async () => {
    awaiting('e1');
    useStreamingStore().messages = [{ id: 'a9', role: 'assistant', content: 'An earlier reply.', timestamp: 1 }];
    const card = resultCard();
    await nextTick();

    expect(card.find('[data-testid="design-result-continue"]').exists()).toBe(true);
  });

  it('hides Continue while a run is going, since that run answers the card', async () => {
    awaiting('e1');
    useUIStore().setProcessing(true);
    const card = resultCard();
    await nextTick();

    expect(card.find('[data-testid="design-result-continue"]').exists()).toBe(false);
  });

  it('opens the design chat and design.md', async () => {
    const card = resultCard();

    await card.get('[data-testid="design-result-open-chat"]').trigger('click');
    await card.get('[data-testid="design-result-open-md"]').trigger('click');

    expect(posted).toEqual([
      { type: 'openDesignChat', designId: RESULT.designId },
      { type: 'openDesignFile', designId: RESULT.designId, file: 'design.md' },
    ]);
  });

  it('lists no change section for a first version', () => {
    const card = track(mount(DesignResultCard, { props: { result: { ...RESULT, version: 1, previousVersion: null, changes: [] }, entryId: 'e1' }, global: { plugins: [i18n] } }));

    expect(card.find('[data-testid="design-result-changes"]').exists()).toBe(false);
    // No composer to send through (a read-only view): no Continue.
    expect(card.find('[data-testid="design-result-continue"]').exists()).toBe(false);
  });

  it('titles a version that arrived after the plan approval as an update, lists its changes and never offers Continue', async () => {
    const card = track(mount(DesignResultCard, {
      props: { result: { ...RESULT, versionPause: { fromVersion: 1 } }, entryId: 'e1' },
      global: { plugins: [i18n], provide: { [SEND_PROMPT_KEY as symbol]: (prompt: string) => sent.push(prompt) > 0 } },
    }));

    expect(card.get('[data-testid="design-result-title"]').text()).toBe('Design updated · v1 → v2');
    expect(card.attributes('aria-label')).toBe('Design updated · v1 → v2');
    expect(card.get('[data-testid="design-result-changes"]').text()).toContain('S2 added');
    // Core names no paused card as awaiting Continue: the version prompt decides how the run starts.
    awaiting(null);
    await nextTick();
    expect(card.find('[data-testid="design-result-continue"]').exists()).toBe(false);
  });

  it('titles an update to a first version without a previous one', () => {
    const card = track(mount(DesignResultCard, {
      props: { result: { ...RESULT, version: 1, previousVersion: null, changes: [], versionPause: { fromVersion: 0 } }, entryId: 'e1' },
      global: { plugins: [i18n] },
    }));

    expect(card.get('[data-testid="design-result-title"]').text()).toBe('Design updated · v1');
  });

  it('says the journeys passed and lists each journey\'s untested remainder, a waived screen as needing none', () => {
    const journeys: DesignResultView['journeys'] = [
      { screen: 'S1', file: 'screens/S1-contacts.journey.json', spec: 'screens/S1-contacts.journey.spec.ts', widths: [390, 1280], passed: true, untested: ['Saving a contact', 'Deleting a contact'] },
      { screen: 'S2', waiver: true },
      { screen: 'S3', file: 'screens/S3-detail.journey.json', spec: 'screens/S3-detail.journey.spec.ts', widths: [390, 1280], passed: true, untested: [] },
    ];
    const card = track(mount(DesignResultCard, { props: { result: { ...RESULT, journeys }, entryId: 'e1' }, global: { plugins: [i18n] } }));

    expect(card.get('[data-testid="design-result-subtitle"]').text()).toBe('2 screens · 2 decisions · check passed · journeys passed · 1 warning');
    const rows = card.findAll('[data-testid="design-result-journey"]');
    expect(rows.map((row) => row.text())).toEqual([
      'S1 untested: Saving a contact · Deleting a contact',
      'S2 no interactive controls, so no journey needed',
      'S3 nothing listed as untested',
    ]);
    expect(rows[1]!.attributes('data-waiver')).toBe('true');
  });

  it('says nothing of journeys for a design that records none (static, or REDUCED)', () => {
    const card = track(mount(DesignResultCard, { props: { result: RESULT, entryId: 'e1' }, global: { plugins: [i18n] } }));

    expect(card.get('[data-testid="design-result-subtitle"]').text()).not.toContain('journeys');
    expect(card.find('[data-testid="design-result-journeys"]').exists()).toBe(false);
  });
});

describe('the plan approval strip', () => {
  const LINK: PlanApprovalDesignLink = { designId: RESULT.designId, title: 'Contacts', folder: RESULT.folder, version: 2, screens: 2, decisions: 3, warnings: [], journeysPassed: null };

  it('adds that the journeys passed only when the version records journeys', () => {
    const counts = (link: PlanApprovalDesignLink): string => track(mount(DesignPlanStrip, { props: { link }, global: { plugins: [i18n] } })).get('[data-testid="design-plan-strip-counts"]').text();

    expect(counts(LINK)).toBe('2 screens · 3 decisions · 0 warnings');
    expect(counts({ ...LINK, journeysPassed: true })).toBe('2 screens · 3 decisions · 0 warnings · journeys passed');
  });
});

describe('the design chat header', () => {
  const header = (design: DesignChatStateView): VueWrapper => track(mount(DesignHeader, {
    props: { design },
    global: { plugins: [i18n], stubs: { TransitionGroup: false } },
    attachTo: document.body,
  }));

  it('pops only a decision that arrives after it mounted', async () => {
    const wrapper = header(DESIGN);
    const first = wrapper.get('[data-decision-id="D1"]').element.parentElement!;
    expect(first.className).not.toContain('d-pop');

    await wrapper.setProps({ design: { ...DESIGN, decisions: [...DESIGN.decisions, { id: 'D2', title: 'Layout', chosen: 'Table', rejected: ['Cards'], source: { kind: 'chat', ref: 'u3' } }] } });

    expect(wrapper.get('[data-decision-id="D2"]').element.parentElement!.className).toContain('animate-[d-pop');
    expect(wrapper.get('[data-decision-id="D2"]').text()).toContain('D2');
  });

  it('opens the main chat from the parent chip, and offers none when the design has no parent', async () => {
    const wrapper = header(DESIGN);
    await wrapper.get('[data-testid="design-header-parent"]').trigger('click');
    expect(posted).toEqual([{ type: 'openParentChat' }]);

    await wrapper.setProps({ design: { ...DESIGN, parentSessionId: null, parentTitle: null } });
    expect(wrapper.get('[data-testid="design-header-parent"]').attributes('disabled')).toBeDefined();
  });

  it("keeps the fixed box the shell's gutter edge continues, its rows never wrapping and its decisions under an overlay slider", () => {
    const wrapper = header(DESIGN);
    const section = wrapper.get('[data-testid="design-header"]');
    expect(section.classes()).toEqual(expect.arrayContaining(DESIGN_STRIP.split(' ')));
    expect(wrapper.findAll('.flex-wrap')).toHaveLength(0);
    const strip = wrapper.get('[data-testid="design-decisions"]');
    expect([strip.attributes('role'), strip.attributes('tabindex')]).toEqual(['region', '0']);
    expect(strip.classes()).toContain('d-overflow-strip');
  });

  it('keeps the names of the chips that fold to their icons in a narrow header', async () => {
    useDesignStore().setOpenInBrowser(true);
    const wrapper = header({ ...DESIGN, enabled: false });
    await nextTick();
    for (const id of ['design-header-open-browser', 'design-header-off']) {
      const label = wrapper.get(`[data-testid="${id}"] span`);
      expect(label.classes()).toContain('@max-[32rem]/design:sr-only');
      expect(label.text()).toBe(id === 'design-header-off' ? 'Design mode is off' : 'Open in browser');
    }
  });

  it('names the version once one is finished', async () => {
    const wrapper = header(DESIGN);
    expect(wrapper.get('[data-testid="design-header-version"]').text()).toBe('Draft');

    await wrapper.setProps({ design: { ...DESIGN, status: 'finished', version: 1 } });
    expect(wrapper.get('[data-testid="design-header-version"]').text()).toBe('v1');
  });

  it('says a finished version was edited since, once the designer changed the folder', async () => {
    const wrapper = header({ ...DESIGN, status: 'draft', version: 1 });
    expect(wrapper.get('[data-testid="design-header-version"]').text()).toBe('v1 · edited');

    i18n.global.locale.value = 'el';
    await nextTick();
    expect(wrapper.get('[data-testid="design-header-version"]').text()).toBe('v1 · επεξεργασμένη');
  });

  it('draws faint text on the strip\'s tint in the faint text token', () => {
    const wrapper = header({ ...DESIGN, decisions: [] });
    const label = wrapper.get('[data-testid="design-header"] .uppercase');
    expect(label.classes()).toContain('text-(--d-faint-text)');
    expect(wrapper.find('.text-\\(--d-faint\\)').exists()).toBe(false);
  });

  it('lists the folder\'s files as a menu, keeping a list it holds while a refresh is out', async () => {
    const wrapper = header(DESIGN);
    const trigger = wrapper.get('[data-testid="design-header-folder"]').element as HTMLElement;
    const open = async (): Promise<void> => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await nextTick();
      await nextTick();
    };
    const menu = (): HTMLElement | null => document.querySelector('[data-testid="design-files"]');

    await open();
    expect(menu()?.getAttribute('role')).toBe('menu');
    expect(menu()?.querySelector('[role="menuitem"][data-disabled]')?.textContent?.trim()).toBe('Loading files…');
    useDesignStore().setFiles(DESIGN.designId, [{ path: 'design.md', bytes: 10 }, { path: 'screens/S1.html', bytes: 2048 }], false);
    await nextTick();
    const files = [...document.querySelectorAll<HTMLElement>('[data-testid="design-file"]')];
    expect(files.map((file) => file.getAttribute('role'))).toEqual(['menuitem', 'menuitem']);

    // Another open asks again, and the list it holds stays shown until the answer replaces it.
    useDesignStore().filesRequested(DESIGN.designId);
    await nextTick();
    expect(useDesignStore().fileLists[DESIGN.designId]).toMatchObject({ loaded: true, refreshing: true });
    expect(document.querySelectorAll('[data-testid="design-file"]')).toHaveLength(2);
    expect(menu()?.textContent).not.toContain('Loading files…');
    document.querySelectorAll<HTMLElement>('[data-testid="design-file"]')[1]!.click();
    expect(posted.at(-1)).toEqual({ type: 'openDesignFile', designId: DESIGN.designId, file: 'screens/S1.html' });
  });
});

describe('the DesignCheck report', () => {
  const SUMMARY: DesignCheckSummary = {
    errors: [{ rule: 'tokens.color', severity: 'error', screen: 'S1', element: 'button.save', message: 'Color #ff0000 is not a token' }],
    warnings: [{ rule: 'ds.hidden-required', severity: 'warning', screen: 'S1', element: 'input#email', message: 'Hidden at sm', hint: 'Keep required fields visible' }],
    attributesChecked: 42,
    tokensChecked: 18,
    skillHints: 1,
    widths: [],
  };

  it('lists errors before warnings, with no pass line while any error remains', () => {
    const report = track(mount(DesignCheckReport, { props: { summary: SUMMARY }, global: { plugins: [i18n] } }));
    const severities = report.findAll('[data-testid="design-check-issue"]').map((issue) => issue.attributes('data-severity'));

    expect(severities).toEqual(['error', 'warning']);
    expect(report.find('[data-testid="design-check-pass"]').exists()).toBe(false);
    expect(report.text()).toContain('Keep required fields visible');
    expect(report.text()).toContain('Checked 42 attributes against inventory.json and 18 tokens, plus 1 skill hint. No model call.');
  });

  it('names the width an issue was found at and the skill whose hint it quotes', () => {
    const report = track(mount(DesignCheckReport, { props: { summary: {
      ...SUMMARY,
      errors: [
        { rule: 'layout.overflow', severity: 'error', screen: 'S1', element: 'table.contacts', message: 'table.contacts is 812 px wide at 390 px', width: 390, breakpoint: 'base' },
        { rule: 'layout.overflow', severity: 'error', screen: 'S1', element: 'table.contacts', message: 'Overflows at 512 px', width: 512 },
      ],
      warnings: [{ rule: 'a11y.input-label', severity: 'warning', screen: 'S1', element: 'input#search', message: 'Input has no label', skill: 'accessibility-states', hint: 'Every input has a visible label.' }],
      widths: [390, 640],
    } }, global: { plugins: [i18n] } }));

    expect(report.findAll('[data-testid="design-check-issue-width"]').map((chip) => chip.text())).toEqual(['base · 390 px', '512 px']);
    const hint = report.get('[data-testid="design-check-issue-hint"]');
    expect(hint.text()).toContain('accessibility-states');
    expect(hint.get('q').text()).toBe('Every input has a visible label.');
    expect(report.get('[data-testid="design-check-errors"]').text()).toContain('812 px wide at 390 px');
  });

  it('shows the green line with the widths checked and the warning count when nothing failed', () => {
    const report = track(mount(DesignCheckReport, { props: { summary: { ...SUMMARY, errors: [], widths: [640, 1280] } }, global: { plugins: [i18n] } }));

    const pass = report.get('[data-testid="design-check-pass"]');
    expect(pass.findAll('span').map((part) => part.text())).toEqual(['0 errors at 2 widths', '·', '1 warning']);
    expect(report.text()).toContain('at 2 widths. No model call.');
  });

  it('says the width checks did not run in place of a pass when core skipped them', async () => {
    const skipped = { message: 'The width checks did not run. They run once this chat is open in the Damocles app.' };
    const report = track(mount(DesignCheckReport, { props: { summary: { ...SUMMARY, errors: [], widthChecks: { skipped } } }, global: { plugins: [i18n] } }));

    expect(report.find('[data-testid="design-check-pass"]').exists()).toBe(false);
    expect(report.get('[data-testid="design-check-skipped"]').text()).toBe(skipped.message);
    i18n.global.locale.value = 'el';
    await nextTick();
    expect(report.get('[data-testid="design-check-skipped"]').text()).toBe('Οι έλεγχοι πλάτους δεν εκτελέστηκαν. Εκτελούνται μόλις ανοίξει αυτή η συνομιλία στην εφαρμογή Damocles.');
  });

  it('counts the issues a capped rule left out, and says how many more there are', () => {
    const errors = Array.from({ length: 20 }, (_, index) => ({ rule: 'tokens.color', severity: 'error' as const, screen: 'S1', element: `div.c${index}`, message: 'Not a token' }));
    errors[19] = { ...errors[19]!, more: 5 } as typeof errors[number];
    const report = track(mount(DesignCheckReport, { props: { summary: { ...SUMMARY, errors } }, global: { plugins: [i18n] } }));

    expect(report.get('[data-testid="design-check-errors"] [data-testid="design-check-count"]').text()).toBe('25');
    expect(report.findAll('[data-testid="design-check-issue-more"]').map((more) => more.text())).toEqual(['5 more on this screen']);
  });

  it('labels each rule in the view\'s language, the id beside it, and falls back to the id for a rule it does not know', () => {
    const report = track(mount(DesignCheckReport, { props: { summary: { ...SUMMARY, errors: [
      { rule: 'links.no-javascript', severity: 'error', screen: 'S1', element: 'a.help', message: 'javascript: link' },
      { rule: 'brand.new-rule', severity: 'error', screen: 'S1', element: 'div', message: 'Something new' },
    ] } }, global: { plugins: [i18n] } }));

    const issues = report.findAll('[data-testid="design-check-errors"] [data-testid="design-check-issue"]');
    expect(issues[0]!.text()).toContain('javascript: link');
    expect(issues[0]!.text()).toContain('links.no-javascript');
    expect(issues[1]!.text().startsWith('brand.new-rule')).toBe(true);
  });
});

describe('the design tool cards', () => {
  const call = (name: string, metadata: Record<string, unknown>, status: ToolCall['status'] = 'completed'): ToolCall => ({ id: 't1', name, input: {}, status, metadata });

  it('lists inventory categories in the reference order with counts, each expanding to its file:line list', async () => {
    const card = track(mount(DesignToolCard, {
      props: { toolCall: call(TOOL_INVENTORY, { categories: [
        { key: 'screens', count: 1, refs: ['resources/js/pages/Contacts/Index.vue:1'] },
        { key: 'components', count: 2, refs: ['resources/js/components/ui/Button.vue:1', 'resources/js/components/ui/Input.vue:1'] },
      ] }) },
      global: { plugins: [i18n] },
      attachTo: document.body,
    }));
    const rows = card.findAll('[data-category]');

    expect(rows.map((row) => row.attributes('data-category'))).toEqual(['components', 'screens']);
    expect(rows[0]!.text()).toBe('Components2');
    await rows[0]!.trigger('click');
    expect(card.text()).toContain('resources/js/components/ui/Button.vue:1');
  });

  it('runs a DesignCheck result through the report', () => {
    const card = track(mount(DesignToolCard, {
      props: { toolCall: call(TOOL_DESIGN_CHECK, { errors: [], warnings: [], attributesChecked: 3, tokensChecked: 2, skillHints: 0, widths: [] }) },
      global: { plugins: [i18n] },
    }));

    expect(card.get('[data-testid="design-check-pass"]').text()).toBe('0 errors');
  });

  it('shows a screenshot per width with its breakpoint chip, in image order', () => {
    const card = track(mount(DesignToolCard, {
      props: { toolCall: { ...call(TOOL_DESIGN_SCREENSHOT, { outline: false, screens: [{ screen: 'S1', file: 'screens/S1.html', contentHash: 'h', widths: [
        { breakpoint: 'base', width: 390, cssHeight: 900 }, { breakpoint: 'sm', width: 640, cssHeight: 900 }, { breakpoint: null, width: 1000, cssHeight: 700 },
      ] }] }), imageCount: 3 } },
      global: { plugins: [i18n] },
    }));

    expect(card.text()).toContain('Screenshot');
    expect(card.text()).toContain('3 widths');
    expect(card.text()).toContain('base · 390 px');
    expect(card.text()).toContain('1000 px');
    expect(posted).toEqual([{ type: 'requestToolResultImages', requestId: expect.any(String), toolUseId: 't1', owner: { kind: 'session' } }]);
  });

  it('says the model got a text outline instead of screenshots', () => {
    const card = track(mount(DesignToolCard, {
      props: { toolCall: call(TOOL_DESIGN_SCREENSHOT, { outline: true, screens: [{ screen: 'S1', file: 'screens/S1.html', contentHash: 'h', widths: [{ breakpoint: 'base', width: 390, cssHeight: 900 }] }] }) },
      global: { plugins: [i18n] },
    }));

    expect(card.get('[data-testid="design-screenshot-outline"]').text()).toBe('This model reads no images, so it got a text outline of each width instead.');
    expect(card.find('[data-testid="tool-result-images"]').exists()).toBe(false);
    expect(posted).toEqual([]);
  });

  it('lists the design skills a LoadDesignSkill call loaded', () => {
    const card = track(mount(DesignToolCard, {
      props: { toolCall: call(TOOL_LOAD_DESIGN_SKILL, { skills: [{ name: 'accessibility-states', title: 'Accessibility states', hints: 3 }, { name: 'empty-states', title: 'Empty states', hints: 1 }] }) },
      global: { plugins: [i18n] },
    }));

    expect(card.text()).toContain('Load design skill');
    expect(card.findAll('[data-testid="design-loaded-skill"]').map((row) => row.text())).toEqual([
      'accessibility-statesAccessibility states3 skill hints', 'empty-statesEmpty states1 skill hint',
    ]);
  });

  it('shows a recorded decision as its chip with its source', () => {
    const card = track(mount(DesignToolCard, {
      props: { toolCall: call(TOOL_RECORD_DECISION, { [DESIGN_DECISIONS_DETAIL_KEY]: [{ id: 'D2', title: 'Layout', chosen: 'Table', rejected: [], source: { kind: 'chat', ref: 'u3' }, supersedes: 'D1' }] }) },
      global: { plugins: [i18n] },
    }));

    expect(card.get('[data-testid="design-recorded-decisions"]').text()).toContain('From the chat · replaces D1');
  });

  it('reads the parent link for the StartDesign card status and opens the design chat', async () => {
    useDesignStore().setState(null, { designId: RESULT.designId, title: 'Contacts', folder: RESULT.folder, designSessionId: 'd1', status: 'draft', version: null });
    const card = track(mount(StartDesignToolCard, {
      props: { toolCall: call(TOOL_START_DESIGN, { designId: RESULT.designId, folder: RESULT.folder, designSessionId: 'd1', reopened: false, title: 'Contacts' }) },
      global: { plugins: [i18n] },
    }));

    expect(card.text()).toContain('Design chat opened');
    expect(card.get('[data-testid="start-design-status"]').text()).toBe('Draft');
    expect(card.find('.d-pulsing').exists()).toBe(false);
    await card.get('[data-testid="start-design-open"]').trigger('click');
    expect(posted).toEqual([{ type: 'openDesignChat', designId: RESULT.designId }]);

    useDesignStore().setState(null, { designId: RESULT.designId, title: 'Contacts', folder: RESULT.folder, designSessionId: 'd1', status: 'finished', version: 1 });
    await nextTick();
    expect(card.get('[data-testid="start-design-status"]').text()).toBe('Finished · v1');

    useDesignStore().setState(null, { designId: RESULT.designId, title: 'Contacts', folder: RESULT.folder, designSessionId: 'd1', status: 'draft', version: 1 });
    await nextTick();
    expect(card.get('[data-testid="start-design-status"]').text()).toBe('v1 · edited');
  });

  it('keeps a StartDesign card opening until its details arrive, never saying it did not open', () => {
    const card = track(mount(StartDesignToolCard, { props: { toolCall: { id: 't1', name: TOOL_START_DESIGN, input: { title: 'Contacts' }, status: 'completed' } }, global: { plugins: [i18n] } }));

    expect(card.text()).toContain('Opening design chat…');
    expect(card.text()).not.toContain('did not open');
    expect(card.find('[data-testid="start-design-open"]').exists()).toBe(false);
  });

  it.each([
    ['abandoned', 'Not executed'],
    ['cancelled', 'Stopped'],
    ['unrecorded', 'Outcome not recorded'],
  ] as const)('words a StartDesign call that is %s as every tool card does', (status, note) => {
    const card = track(mount(StartDesignToolCard, { props: { toolCall: { id: 't1', name: TOOL_START_DESIGN, input: {}, status, abandonReason: 'stopped' } }, global: { plugins: [i18n] } }));

    expect(card.get('[data-testid="tool-card-status-note"]').text()).toContain(note);
    expect(card.text()).not.toContain('did not open');
    expect(card.text()).toContain('Start design');
  });

  it('caps an inventory category\'s list in a scrolling box and says how many more it holds', async () => {
    const refs = Array.from({ length: 200 }, (_, index) => `--token-${index}`);
    const card = track(mount(DesignToolCard, {
      props: { toolCall: call(TOOL_INVENTORY, { categories: [{ key: 'tokens', count: 1200, refs }] }) },
      global: { plugins: [i18n] },
      attachTo: document.body,
    }));

    expect(card.get('[data-category="tokens"]').text()).toBe('Tokens1200');
    await card.get('[data-category="tokens"]').trigger('click');
    expect(card.get('[data-testid="design-inventory-refs"]').classes()).toEqual(expect.arrayContaining(['max-h-48', 'overflow-y-auto']));
    expect(card.findAll('[data-testid="design-inventory-refs"] li[dir="ltr"]')).toHaveLength(200);
    expect(card.get('[data-testid="design-inventory-more"]').text()).toBe('1000 more');
  });

  it('shows the bare row for details an earlier build recorded in another shape', () => {
    const tokens = track(mount(DesignToolCard, { props: { toolCall: call(TOOL_EXTRACT_TOKENS, { count: 3, groups: {} }) }, global: { plugins: [i18n] } }));
    const check = track(mount(DesignToolCard, { props: { toolCall: call(TOOL_DESIGN_CHECK, { errors: [], warnings: [] }) }, global: { plugins: [i18n] } }));
    const shot = track(mount(DesignToolCard, { props: { toolCall: call(TOOL_DESIGN_SCREENSHOT, { outline: false, screens: [{ screen: 'S1' }] }) }, global: { plugins: [i18n] } }));

    expect(tokens.find('[data-testid="design-tokens"]').exists()).toBe(false);
    expect(check.find('[data-testid="design-check-report"]').exists()).toBe(false);
    expect(shot.find('[data-testid="design-screenshot"]').exists()).toBe(false);
    expect(tokens.find('[data-testid="design-tool-card"]').exists()).toBe(true);
  });

  it('shows how long a design tool ran, as every tool card does', () => {
    const card = track(mount(DesignToolCard, { props: { toolCall: { ...call(TOOL_LOAD_DESIGN_SKILL, { skills: [] }), durationMs: 1500 } }, global: { plugins: [i18n] } }));

    expect(card.get('[data-testid="tool-card-duration"]').text()).toBe('1.5s');
  });
});

describe('the FinishDesign card', () => {
  const SKIPPED = { message: 'Open this chat in the Damocles app to run the width checks.' };
  const STATIC_PASS: DesignCheckSummary = { errors: [], warnings: [], attributesChecked: 4, tokensChecked: 3, skillHints: 0, widths: [] };
  const finishCard = (toolCall: Partial<ToolCall>): VueWrapper => track(mount(FinishDesignToolCard, {
    props: { toolCall: { id: 'f1', name: TOOL_FINISH_DESIGN, input: {}, status: 'failed', ...toolCall } },
    global: { plugins: [i18n] },
  }));

  it('states why it refused when the width checks could not run, and never shows a passing check', async () => {
    const card = finishCard({ metadata: { ...STATIC_PASS, widthChecks: { skipped: SKIPPED } }, errorMessage: `FinishDesign refused: ${SKIPPED.message}` });

    expect(card.text()).toContain('Finish refused');
    expect(card.get('[data-testid="finish-design-refusal"]').text()).toBe(SKIPPED.message);
    expect(card.find('[data-testid="design-check-pass"]').exists()).toBe(false);
    expect(card.find('[data-testid="design-check-report"]').exists()).toBe(true);

    i18n.global.locale.value = 'el';
    await nextTick();
    expect(card.get('[data-testid="finish-design-refusal"]').text()).toBe('Ανοίξτε αυτή τη συνομιλία στην εφαρμογή Damocles για να εκτελεστούν οι έλεγχοι πλάτους.');
  });

  it('shows the reason above the check\'s own errors when the width checks could not run either', () => {
    const errors = [{ rule: 'tokens.color', severity: 'error' as const, screen: 'S1', element: 'div', message: 'Not a token', more: 2 }];
    const card = finishCard({ metadata: { ...STATIC_PASS, errors, widthChecks: { skipped: SKIPPED } } });

    expect(card.get('[data-testid="finish-design-refusal"]').text()).toBe(SKIPPED.message);
    expect(card.get('[data-testid="design-check-errors"]').text()).toContain('tokens.color');
    expect(card.text()).toContain('3 errors');
  });

  it('lists the check\'s errors as the reason when the check failed', () => {
    const errors = [{ rule: 'tokens.color', severity: 'error' as const, screen: 'S1', element: 'div', message: 'Not a token' }];
    const card = finishCard({ metadata: { ...STATIC_PASS, errors } });

    expect(card.find('[data-testid="finish-design-refusal"]').exists()).toBe(false);
    expect(card.get('[data-testid="design-check-errors"]').text()).toContain('tokens.color');
    expect(card.find('[data-testid="design-check-pass"]').exists()).toBe(false);
  });

  it('shows the error of a refusal that carries no check', () => {
    const card = finishCard({ errorMessage: 'This design continues in another design chat, so this one cannot finish it.' });

    expect(card.find('[data-testid="design-check-report"]').exists()).toBe(false);
    expect(card.text()).toContain('This design continues in another design chat');
  });

  it('shows where a finished version went, and the warnings and journeys that travel with it', () => {
    const card = finishCard({
      status: 'completed',
      metadata: {
        designId: RESULT.designId, version: 2, reused: false, delivery: 'live',
        check: { errors: 0, warnings: [{ rule: 'ds.hidden-required', severity: 'warning', screen: 'S1', element: 'input#email', message: 'Hidden at sm', more: 1 }] },
        journeys: [{ screen: 'S2', waiver: true }],
      },
    });

    expect(card.text()).toContain('Design v2 finished');
    expect(card.get('[data-testid="finish-design-delivery"]').text()).toBe('Sent to the main chat');
    expect(card.get('[data-testid="design-check-warnings"] [data-testid="design-check-count"]').text()).toBe('2');
    expect(card.find('[data-testid="design-check-pass"]').exists()).toBe(false);
    expect(card.get('[data-testid="design-result-journey"]').text()).toBe('S2 no interactive controls, so no journey needed');
  });

  it('says it waits for the approval while its prompt is open, without the running sweep', async () => {
    const card = finishCard({ status: 'running' });
    expect(card.find('.d-sweep-bar').exists()).toBe(true);

    useDesignStore().addApprovalPrompt({
      promptId: 'da-1', designId: RESULT.designId, summary: 'Contacts', previousVersion: null, changes: [], warnings: [], decisions: [], screens: [], hasParent: true,
    });
    await nextTick();

    expect(card.attributes('data-approval')).toBe('awaiting');
    expect(card.text()).toContain('Needs approval');
    expect(card.find('.d-sweep-bar').exists()).toBe(false);
  });

  it('shows the note of a version the user sent back for changes, never the model-facing error text', async () => {
    const card = finishCard({
      status: 'failed',
      metadata: { designId: RESULT.designId, approval: 'changesRequested', feedback: 'Make the table denser.\nKeep the search.' },
      errorMessage: 'The user asked for changes before this version is made: ...',
    });

    expect(card.attributes('data-approval')).toBe('changesRequested');
    expect(card.text()).toContain('Changes requested');
    expect(card.get('[data-testid="finish-design-note"]').element.textContent).toBe('Make the table denser.\nKeep the search.');
    expect(card.get('[data-testid="finish-design-unapproved"]').text()).toContain('No version was made. The designer keeps working on your note.');
    expect(card.text()).not.toContain('The user asked for changes');
    expect(card.find('[data-testid="tool-card-status-note"]').exists()).toBe(false);

    i18n.global.locale.value = 'el';
    await nextTick();
    expect(card.text()).toContain('Ζητήθηκαν αλλαγές');
    expect(card.text()).toContain('Η σημείωσή σας');
  });

  it.each([
    ['stopped', 'failed', 'Stopped without a version', 'No version was made. The designer waits for your next message.'],
    ['cancelled', 'failed', 'Approval closed', 'The approval closed without an answer, so no version was made.'],
    ['cancelled', 'cancelled', 'Approval closed', 'The approval closed without an answer, so no version was made.'],
  ] as const)('says a %s approval made no version (status %s), live and on a replay', (approval, status, title, note) => {
    const card = finishCard({ status, metadata: { designId: RESULT.designId, approval } });

    expect(card.attributes('data-approval')).toBe(approval);
    expect(card.text()).toContain(title);
    expect(card.get('[data-testid="finish-design-unapproved"]').text()).toBe(note);
    expect(card.find('[data-testid="finish-design-delivery"]').exists()).toBe(false);
    expect(card.find('[data-testid="tool-card-status-note"]').exists()).toBe(false);
  });

  it('shows a delivery a newer core names as it is, never as a keypath', () => {
    const card = finishCard({ status: 'completed', metadata: { designId: RESULT.designId, version: 2, reused: false, delivery: 'teleported', check: { errors: 0, warnings: [] }, journeys: [] } });

    expect(card.get('[data-testid="finish-design-delivery"]').text()).toBe('teleported');
  });
});

// Reka opens a menu on Enter (or a pointer press, never a click) and portals its content to `document.body`.
async function openMenu(wrapper: VueWrapper, testId: string): Promise<void> {
  const trigger = wrapper.get(`[data-testid="${testId}"]`).element as HTMLElement;
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await nextTick();
}

describe('Open in browser', () => {
  const resultCard = (): VueWrapper => track(mount(DesignResultCard, { props: { result: RESULT, entryId: 'e1' }, global: { plugins: [i18n] }, attachTo: document.body }));
  const header = (): VueWrapper => track(mount(DesignHeader, { props: { design: DESIGN }, global: { plugins: [i18n] }, attachTo: document.body }));

  it('is offered on the card and the header only where the host\'s rule set opens designs from the chat (REDUCED)', async () => {
    const card = resultCard();
    const chatHeader = header();
    expect(card.find('[data-testid="design-result-open-browser"]').exists()).toBe(false);
    expect(chatHeader.find('[data-testid="design-header-open-browser"]').exists()).toBe(false);

    useDesignStore().setOpenInBrowser(true);
    await nextTick();

    expect(card.get('[data-testid="design-result-open-browser"]').text()).toBe('Open in browser');
    expect(chatHeader.get('[data-testid="design-header-open-browser"]').text()).toBe('Open in browser');
  });

  it.each([
    ['the card', resultCard, 'design-result-open-browser'],
    ['the header', header, 'design-header-open-browser'],
  ] as const)('lists the design\'s screens from %s and opens the one picked', async (_where, mountIt, testId) => {
    useDesignStore().setOpenInBrowser(true);
    const wrapper = mountIt();
    await nextTick();

    await openMenu(wrapper, testId);
    expect(posted).toEqual([{ type: 'requestDesignFiles', designId: RESULT.designId }]);
    useDesignStore().setFiles(RESULT.designId, [
      { path: 'design.md', bytes: 10 },
      { path: 'screens/S1-contacts.html', bytes: 2048 },
      { path: 'screens/S1.journey.json', bytes: 10 },
      { path: 'screens/S2-detail.html', bytes: 1024 },
      { path: 'variants/a/screens/S1.html', bytes: 10 },
    ], false);
    await nextTick();

    const screens = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="design-screen"]')];
    expect(screens.map((screen) => screen.textContent?.trim())).toEqual(['screens/S1-contacts.html', 'screens/S2-detail.html']);
    expect(screens[0]!.getAttribute('aria-label')).toBe('Open screens/S1-contacts.html in the browser');
    screens[0]!.click();
    // Reka closes the menu a tick after the item's select.
    await nextTick();
    await nextTick();
    await nextTick();

    expect(posted.at(-1)).toEqual({ type: 'openDesignInBrowser', designId: RESULT.designId, relPath: 'screens/S1-contacts.html' });
    // The menu closes; its exit animation keeps it in the page a moment.
    expect(document.querySelector('[data-testid="design-screens"]')?.getAttribute('data-state')).toBe('closed');
  });

  it('says when the design has no screen yet', async () => {
    useDesignStore().setOpenInBrowser(true);
    const wrapper = resultCard();
    await nextTick();

    await openMenu(wrapper, 'design-result-open-browser');
    useDesignStore().setFiles(RESULT.designId, [{ path: 'design.md', bytes: 10 }], false);
    await nextTick();

    expect(document.querySelector('[data-testid="design-no-screens"]')?.textContent?.trim()).toBe('No screens yet');
  });
});

describe('Open preview', () => {
  const resultCard = (): VueWrapper => track(mount(DesignResultCard, { props: { result: RESULT, entryId: 'e1' }, global: { plugins: [i18n] }, attachTo: document.body }));
  const designHeader = (): VueWrapper => track(mount(DesignHeader, { props: { design: DESIGN }, global: { plugins: [i18n] }, attachTo: document.body }));

  it("is offered in the design chat's header where the host has the preview tab, so a closed preview opens again", async () => {
    const wrapper = designHeader();
    expect(wrapper.find('[data-testid="design-header-open-preview"]').exists()).toBe(false);

    useDesignStore().setOpenPreview(true);
    await nextTick();
    expect(wrapper.get('[data-testid="design-header-open-preview"] span').text()).toBe('Open preview');

    await openMenu(wrapper, 'design-header-open-preview');
    useDesignStore().setFiles(DESIGN.designId, [{ path: 'design.md', bytes: 10 }, { path: 'screens/S2-home.html', bytes: 2048 }], false);
    await nextTick();
    const screens = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="design-screen"]')];
    expect(screens.map((screen) => screen.textContent?.trim())).toEqual(['screens/S2-home.html']);
    screens[0]!.click();
    expect(posted.at(-1)).toEqual({ type: 'openDesignPreview', designId: DESIGN.designId, relPath: 'screens/S2-home.html' });
  });

  it('is offered on the card only where the host has the preview tab (FULL), never as Open in browser there', async () => {
    const card = resultCard();
    expect(card.find('[data-testid="design-result-open-preview"]').exists()).toBe(false);

    useDesignStore().setOpenPreview(true);
    await nextTick();

    expect(card.get('[data-testid="design-result-open-preview"]').text()).toBe('Open preview');
    expect(card.find('[data-testid="design-result-open-browser"]').exists()).toBe(false);
  });

  it('opens the screen picked in the preview tab', async () => {
    useDesignStore().setOpenPreview(true);
    const card = resultCard();
    await nextTick();

    await openMenu(card, 'design-result-open-preview');
    expect(posted).toEqual([{ type: 'requestDesignFiles', designId: RESULT.designId }]);
    useDesignStore().setFiles(RESULT.designId, [{ path: 'screens/S1-contacts.html', bytes: 2048 }, { path: 'screens/S2-detail.html', bytes: 1024 }], false);
    await nextTick();

    const screens = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="design-screen"]')];
    expect(screens[1]!.getAttribute('aria-label')).toBe('Open screens/S2-detail.html in the preview tab');
    screens[1]!.click();
    expect(posted.at(-1)).toEqual({ type: 'openDesignPreview', designId: RESULT.designId, relPath: 'screens/S2-detail.html' });
  });

  it('follows designState: a core that omits openPreview hides the button', async () => {
    const { createDesignHandlers } = await import('@/composables/message-handler/handlers/design-handlers');
    const handlers = createDesignHandlers();
    const state = { type: 'designState', design: null, link: null } as const;
    handlers.designState!({ ...state, openPreview: true }, {} as never);
    expect(useDesignStore().openPreview).toBe(true);
    handlers.designState!(state, {} as never);
    expect(useDesignStore().openPreview).toBe(false);
  });
});
