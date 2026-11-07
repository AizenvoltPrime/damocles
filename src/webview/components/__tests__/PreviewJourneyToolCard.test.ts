// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { JourneyStep, JourneyStepResult, PreviewJourneyArgs, PreviewJourneyDetails } from '@shared/types/design';
import { TOOL_PREVIEW_JOURNEY } from '@shared/tool-names';
import type { ToolCall } from '@shared/types/session';
import { i18n, loadLocale } from '@/i18n';
import { useDesignStore } from '@/stores/useDesignStore';
import { createDesignHandlers } from '@/composables/message-handler/handlers/design-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import PreviewJourneyToolCard from '../design/PreviewJourneyToolCard.vue';
import ToolCallRouter from '../ToolCallRouter.vue';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

// The backend's 11-step Contacts journey (api-contract), run at base and xl.
const STEPS: JourneyStep[] = [
  { action: 'fill', target: { placeholder: 'Search contacts' }, value: 'Grace' },
  { action: 'assert', target: { role: 'list', name: 'Contacts' }, expect: { textContains: 'Grace Hopper' } },
  { action: 'click', target: { role: 'button', name: 'Add contact' } },
  { action: 'assert', target: { role: 'dialog', name: 'New contact' }, expect: { visible: true } },
  { action: 'fill', target: { label: 'Name' }, value: 'Ada Lovelace' },
  { action: 'assert', target: { label: 'Name' }, expect: { valueEquals: 'Ada Lovelace' } },
  { action: 'select', target: { label: 'Group' }, value: 'work' },
  { action: 'assert', target: { label: 'Group' }, expect: { valueEquals: 'work' } },
  { action: 'press', target: { label: 'Name' }, key: 'Escape' },
  { action: 'assert', target: { role: 'dialog', name: 'New contact' }, expect: { visible: false } },
  { action: 'assert', target: { text: 'Grace Hopper' }, expect: { visible: true } },
];
const ARGS: PreviewJourneyArgs = { screen: 'screens/S1-contacts.html', state: 'default', steps: STEPS, untested: ['Saving a contact', 'Deleting a contact'] };
const allOk = (): JourneyStepResult[] => STEPS.map(() => ({ ok: true }));

function details(results: PreviewJourneyDetails['results']): PreviewJourneyDetails {
  return {
    screen: 'S1', relPath: ARGS.screen, journeyFile: 'screens/S1-contacts.journey.json', specFile: 'screens/S1-contacts.journey.spec.ts',
    viewports: [{ breakpoint: 'base', width: 390 }, { breakpoint: 'xl', width: 1280 }], state: 'default', steps: STEPS, results,
    untested: ARGS.untested, passed: results.every((run) => run.passed), contentHash: 'abc', outline: false,
  };
}
const PASSED = details([{ width: 390, passed: true, steps: allOk() }, { width: 1280, passed: true, steps: allOk() }]);
// The Escape step's assert fails at base, so the run ends there; xl passes.
const FAILED = details([
  { width: 390, passed: false, steps: [...allOk().slice(0, 9), { ok: false, failure: 'expectation', message: 'dialog "New contact" is still visible' }] },
  { width: 1280, passed: true, steps: allOk() },
]);

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: 'call_journey', name: TOOL_PREVIEW_JOURNEY, input: { ...ARGS }, status: 'running', ...overrides };
}

// As core delivers a result: `toolMetadata` while the call still runs, then `toolCompleted` in a later flush.
async function deliver(wrapper: VueWrapper, result: PreviewJourneyDetails): Promise<void> {
  await wrapper.setProps({ toolCall: call({ metadata: { ...result } }) });
  await nextTick();
  await wrapper.setProps({ toolCall: call({ status: 'completed', metadata: { ...result } }) });
}

const mounted: VueWrapper[] = [];
function card(toolCall: ToolCall): VueWrapper {
  const wrapper = mount(PreviewJourneyToolCard, { props: { toolCall }, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}
const states = (wrapper: VueWrapper): string[] => wrapper.findAll('[data-testid="preview-journey-step"]').map((row) => row.attributes('data-state')!);
const counter = (wrapper: VueWrapper): string => wrapper.get('[data-testid="preview-journey-counter"] [aria-hidden="true"]').text().replace(/\s+/g, '');

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  i18n.global.locale.value = 'en';
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.documentElement.removeAttribute('data-reduced-motion');
  vi.useRealTimers();
});

describe('the PreviewJourney card', () => {
  it('shows the steps it was asked to run as pending under a header spinner while the call has no result', () => {
    const wrapper = card(call());

    expect(states(wrapper)).toEqual(STEPS.map(() => 'pending'));
    expect(wrapper.find('[data-testid="preview-journey-counter"]').exists()).toBe(false);
    expect(wrapper.find('.d-spinning').exists()).toBe(true);
    expect(wrapper.get('[data-testid="preview-journey-running"]').text()).toBe('Running the journey at each journey width…');
    expect(wrapper.find('[data-testid="preview-journey-width"]').exists()).toBe(false);
  });

  it('reads each step as a sentence in the view\'s language, naming its accessible target', async () => {
    const wrapper = card(call());
    const text = wrapper.findAll('[data-testid="preview-journey-step-text"]').map((row) => row.text());

    expect(text[0]).toBe('Type “Grace” into field with placeholder “Search contacts”');
    expect(text[1]).toBe('list “Contacts” contains “Grace Hopper”');
    expect(text[2]).toBe('Click button “Add contact”');
    expect(text[6]).toBe('Choose “work” in field “Group”');
    expect(text[8]).toBe('Press Escape in field “Name”');
    expect(text[9]).toBe('dialog “New contact” is hidden');

    await loadLocale('el');
    i18n.global.locale.value = 'el';
    await nextTick();
    expect(wrapper.findAll('[data-testid="preview-journey-step-text"]')[0]!.text()).toBe('Πληκτρολόγηση «Grace» σε πεδίο με υπόδειξη «Search contacts»');
  });

  it('shows a passed journey at once from history: every step passed, 11/11, a passing chip per width and the untested remainder', () => {
    const wrapper = card(call({ status: 'completed', metadata: { ...PASSED } }));

    expect(states(wrapper)).toEqual(STEPS.map(() => 'pass'));
    expect(counter(wrapper)).toBe('11/11');
    const chips = wrapper.findAll('[data-testid="preview-journey-width"]');
    expect(chips.map((chip) => chip.text())).toEqual(['base · 390 px11/11passed', 'xl · 1280 px11/11passed']);
    expect(chips.map((chip) => chip.attributes('data-passed'))).toEqual(['true', 'true']);
    expect(wrapper.get('[data-testid="preview-journey-untested"]').text()).toContain('Saving a contact');
    expect(wrapper.get('[data-testid="preview-journey-untested"]').text()).toContain('Deleting a contact');
    expect(wrapper.get('[data-testid="preview-journey-files"]').text()).toContain('screens/S1-contacts.journey.spec.ts');
    expect(wrapper.get('[data-testid="preview-journey-card"]').attributes('data-passed')).toBe('true');
  });

  it('opens on the failing width, marks the failed step with why, and shows the steps after it as not run', async () => {
    const wrapper = card(call({ status: 'completed', metadata: { ...FAILED } }));

    expect(states(wrapper)).toEqual([...Array(9).fill('pass'), 'fail', 'notRun']);
    const failure = wrapper.get('[data-testid="preview-journey-failure"]');
    expect(failure.attributes('data-failure')).toBe('expectation');
    expect(failure.text()).toContain('The check did not hold within 5 s');
    expect(failure.text()).toContain('dialog "New contact" is still visible');
    expect(counter(wrapper)).toBe('9/11');
    expect(wrapper.get('[data-testid="preview-journey-card"]').attributes('data-passed')).toBe('false');
    expect(wrapper.findAll('[data-testid="preview-journey-width"]').map((chip) => chip.attributes('data-passed'))).toEqual(['false', 'true']);

    await wrapper.get('[data-testid="preview-journey-width"][data-width="1280"]').trigger('click');
    expect(states(wrapper)).toEqual(STEPS.map(() => 'pass'));
  });

  it('names the width a step\'s target was hidden at', () => {
    const hidden = details([
      { width: 390, passed: false, steps: [...allOk().slice(0, 2), { ok: false, failure: 'hidden', hiddenAt: 390, message: 'button "Add contact" is hidden' }] },
      { width: 1280, passed: true, steps: allOk() },
    ]);
    const wrapper = card(call({ status: 'completed', metadata: { ...hidden } }));

    expect(states(wrapper).slice(0, 4)).toEqual(['pass', 'pass', 'fail', 'notRun']);
    expect(wrapper.get('[data-testid="preview-journey-failure"]').text()).toContain('Hidden at base · 390 px');
  });

  it('reveals a live result step by step, the active step ringed and spinning, ending at 11/11', async () => {
    vi.useFakeTimers();
    const wrapper = card(call());
    await deliver(wrapper, PASSED);

    expect(states(wrapper)[0]).toBe('active');
    expect(states(wrapper).slice(1)).toEqual(STEPS.slice(1).map(() => 'waiting'));
    const active = wrapper.findAll('[data-testid="preview-journey-step"]')[0]!;
    expect(active.find('.d-spinning').exists()).toBe(true);
    expect(active.find('[class*="d-attention-ring"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="preview-journey-card"]').attributes('data-revealing')).toBe('true');
    expect(counter(wrapper)).toBe('0/11');

    await vi.advanceTimersByTimeAsync(170 * 4);
    expect(states(wrapper).slice(0, 5)).toEqual(['pass', 'pass', 'pass', 'pass', 'active']);

    await vi.runAllTimersAsync();
    expect(states(wrapper)).toEqual(STEPS.map(() => 'pass'));
    expect(counter(wrapper)).toBe('11/11');
    expect(wrapper.get('[data-testid="preview-journey-card"]').attributes('data-revealing')).toBeUndefined();
  });

  it('shows a live result at once under reduced motion', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    const wrapper = card(call());
    await deliver(wrapper, FAILED);

    expect(states(wrapper)).toEqual([...Array(9).fill('pass'), 'fail', 'notRun']);
    expect(counter(wrapper)).toBe('9/11');
  });

  it('shows a refused call\'s steps as not run with the refusal', () => {
    const wrapper = card(call({ status: 'failed', errorMessage: 'A journey has at most 16 steps, asserts counted; this one has 17.' }));

    expect(states(wrapper)).toEqual(STEPS.map(() => 'notRun'));
    expect(wrapper.get('[data-testid="preview-journey-error"]').text()).toContain('at most 16 steps');
    expect(wrapper.find('[data-testid="preview-journey-replay"]').exists()).toBe(false);
  });

  it('leaves out a refused call\'s steps that are no journey step, never showing a raw key or an empty name', () => {
    const steps = [
      STEPS[0],
      { action: 'hover', target: { role: 'button', name: 'Save' } },
      { action: 'click', target: { role: 'button' } },
      { action: 'assert', target: { label: 'Name' } },
      STEPS[1],
    ];
    const wrapper = card(call({ status: 'failed', input: { ...ARGS, steps }, errorMessage: 'step 2: action must be fill, select, click, press or assert.' }));

    expect(wrapper.findAll('[data-testid="preview-journey-step"]').map((row) => row.attributes('data-action'))).toEqual(['fill', 'assert']);
    expect(wrapper.text()).not.toContain('design.journey');
    expect(wrapper.text()).not.toContain('“”');
  });

  it('words a failure a newer core names as an error, and counts nothing for a result with no width run', () => {
    const unknown = details([{ width: 390, passed: false, steps: [{ ok: false, failure: 'teleported' as never, message: 'gone' }] }, { width: 1280, passed: true, steps: allOk() }]);
    const failing = card(call({ status: 'completed', metadata: { ...unknown } }));
    expect(failing.get('[data-testid="preview-journey-failure"]').text()).toContain('The step failed');
    expect(failing.text()).not.toContain('design.journey.failure');

    const empty = card(call({ status: 'completed', metadata: { ...details([]), viewports: [] } }));
    expect(empty.find('[data-testid="preview-journey-counter"]').exists()).toBe(false);
    expect(empty.text()).not.toContain('Infinity');
  });
});

describe('Replay in preview', () => {
  const ctx = {} as HandlerContext;

  it('is offered only where the host has the preview tab (desktop)', async () => {
    const wrapper = card(call({ status: 'completed', metadata: { ...PASSED } }));
    expect(wrapper.find('[data-testid="preview-journey-replay"]').exists()).toBe(false);

    useDesignStore().setOpenPreview(true);
    await nextTick();
    expect(wrapper.get('[data-testid="preview-journey-replay"]').text()).toBe('Replay in preview');
  });

  it('sends the call with the motion setting, stays disabled while replaying, and shows the localized refusal', async () => {
    useDesignStore().setOpenPreview(true);
    document.documentElement.setAttribute('data-reduced-motion', '');
    const wrapper = card(call({ status: 'completed', metadata: { ...PASSED } }));
    const button = wrapper.get('[data-testid="preview-journey-replay"]');

    await button.trigger('click');
    await button.trigger('click');
    expect(posted).toEqual([{ type: 'replayDesignJourney', toolCallId: 'call_journey', reducedMotion: true }]);
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toBe('Replaying…');

    createDesignHandlers().designJourneyReplayed!({ type: 'designJourneyReplayed', toolCallId: 'call_journey', ok: false, error: { message: 'Open this chat in the Damocles app to replay the journey.' } }, ctx);
    await nextTick();
    expect(wrapper.get('[data-testid="preview-journey-replay-refusal"]').text()).toBe('Open this chat in the Damocles app to replay the journey.');
    expect(button.attributes('disabled')).toBeUndefined();

    await button.trigger('click');
    expect(wrapper.find('[data-testid="preview-journey-replay-refusal"]').exists()).toBe(false);
    createDesignHandlers().designJourneyReplayed!({ type: 'designJourneyReplayed', toolCallId: 'call_journey', ok: true }, ctx);
    await nextTick();
    expect(button.attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="preview-journey-replay-refusal"]').exists()).toBe(false);
  });

  it('drops a reply for a replay the conversation no longer holds', () => {
    useDesignStore().replayStarted('call_journey');
    useDesignStore().resetConversation();
    createDesignHandlers().designJourneyReplayed!({ type: 'designJourneyReplayed', toolCallId: 'call_journey', ok: true }, ctx);

    expect(useDesignStore().journeyReplays).toEqual({});
  });
});

describe('the tool call router', () => {
  it('routes PreviewJourney to its card', () => {
    const toolCall = call({ status: 'completed', metadata: { ...PASSED } });
    const wrapper = mount(ToolCallRouter, {
      props: { toolCall, toolUseId: toolCall.id, toolName: TOOL_PREVIEW_JOURNEY, message: { id: 'a1', role: 'assistant', content: '', timestamp: 1 } },
      global: { plugins: [i18n] },
    });
    mounted.push(wrapper);

    expect(wrapper.find('[data-testid="preview-journey-card"]').exists()).toBe(true);
  });
});
