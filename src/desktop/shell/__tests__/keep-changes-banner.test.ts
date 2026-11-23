// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { KEEP_CHANGES_MS, type KeepChangesState } from '@shared/themes/agent';
import KeepChangesBanner from '../components/KeepChangesBanner.vue';
import ShowInWindowStrip from '../components/ShowInWindowStrip.vue';
import { loadShellLocale, shellI18n } from '../i18n';
import { installVisibilityObserver, type FakeVisibility } from '../../../webview/__tests__/visibility-observer';

const START = 1_000_000;
const COUNTING: KeepChangesState = {
  phase: 'counting', endsAt: START + KEEP_CHANGES_MS, durationMs: KEEP_CHANGES_MS, chatTitle: 'Warmer sidebar', change: { kind: 'create', theme: 'Amber Night', picked: ['dark'] }, previousName: 'Bleach', changeCount: 1,
};

const mounted: VueWrapper[] = [];
let visibility: FakeVisibility;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  visibility = installVisibilityObserver();
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.documentElement.removeAttribute('data-reduced-motion');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function banner(state: KeepChangesState = COUNTING): VueWrapper {
  const wrapper = mount(KeepChangesBanner, { props: { state }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

const advance = async (ms: number): Promise<void> => {
  vi.advanceTimersByTime(ms);
  await nextTick();
};
const count = (w: VueWrapper): string => w.get('[data-testid="keep-changes-count"]').text();
const bar = (w: VueWrapper) => w.get('[role="progressbar"]');
const live = (w: VueWrapper): string => w.get('[data-testid="keep-changes-live"]').text();

describe('the keep-changes banner', () => {
  // a name written right to left would take the full stop and the count beside it into its own run
  it('isolates a right-to-left chat title and theme name in its sentences, and keeps the text free of direction marks', async () => {
    const chat = 'צבעים 2';
    const theme = 'ליל 3';
    const w = banner({ ...COUNTING, chatTitle: chat, change: { kind: 'create', theme, picked: ['dark'] }, previousName: 'שחר' });
    expect(w.get('#keep-changes-desc').findAll('bdi').map((run) => run.text())).toEqual([chat, theme]);
    await w.setProps({ state: { ...COUNTING, chatTitle: chat, change: { kind: 'create', theme, picked: ['dark'] }, previousName: 'שחר', phase: 'kept' } });
    expect(w.get('[data-testid="keep-changes-live"]').findAll('bdi').map((run) => run.text())).toEqual([theme, 'שחר']);
    expect(w.text()).not.toMatch(/[\u2066-\u2069]/);
  });

  // Not a dialog: it takes no focus and the window stays usable, and the polite status region speaks for it.
  it('asks to keep the theme as a trusted, labelled region with Keep, Revert now and the time left', async () => {
    const w = banner();
    const root = w.get('[data-testid="keep-changes-banner"]');
    expect(root.attributes('role')).toBe('region');
    expect(root.attributes('aria-labelledby')).toBe('keep-changes-title');
    expect(root.attributes('aria-describedby')).toBeUndefined();
    expect(root.attributes('data-trusted')).toBeDefined();
    expect(w.get('#keep-changes-title').text()).toBe('Keep this theme?');
    expect(w.get('#keep-changes-desc').text()).toBe('The agent in “Warmer sidebar” applied Amber Night. It reverts in 15 s unless you keep it.');
    expect(bar(w).attributes('aria-label')).toBe('Time left before revert');
    expect(w.get('[data-testid="keep-changes-keep"]').text()).toBe('Keep');
    expect(w.get('[data-testid="keep-changes-revert"]').text()).toBe('Revert now');
  });

  it('names no single chat once the countdown covers changes of more than one, and says how its end left them', async () => {
    const { chatTitle: _title, ...rest } = COUNTING;
    const several: KeepChangesState = { ...rest, changeCount: 3, several: true };
    const w = banner(several);
    expect(w.get('#keep-changes-desc').text()).toBe('The theme changed 3 times, by more than one chat or by you and a chat. It reverts in 15 s unless you keep it.');
    await w.setProps({ state: { ...several, phase: 'kept' } });
    expect(live(w)).toBe('The changes stay. Undo Theme Change takes them back one at a time.');
    await w.setProps({ state: { ...several, phase: 'reverted', endedBy: 'user' } });
    expect(live(w)).toBe('Back to the look from before the first change. Every chat whose turn waited was told you reverted it.');
  });

  it('says the change turned wallpapers off, and that an undo took that back', () => {
    const off = banner({ ...COUNTING, change: { kind: 'wallpapersOff' } });
    expect(off.get('#keep-changes-desc').text()).toBe('The agent in “Warmer sidebar” turned wallpapers off. It reverts in 15 s unless you keep it.');
    const undone = banner({ ...COUNTING, change: { kind: 'restore', before: { kind: 'wallpapersOff' } } });
    expect(undone.get('#keep-changes-desc').text()).toBe('The agent in “Warmer sidebar” undid its change that turned wallpapers off. It reverts in 15 s unless you keep it.');
  });

  it('emits keep and revert from its buttons; main does the rest', async () => {
    const w = banner();
    await w.get('[data-testid="keep-changes-keep"]').trigger('click');
    await w.get('[data-testid="keep-changes-revert"]').trigger('click');
    expect(w.emitted('keep')).toHaveLength(1);
    expect(w.emitted('revert')).toHaveLength(1);
  });

  it('does nothing while covered, says why once the cover outlasts its entrance, and acts once it is fully visible', async () => {
    const w = banner();
    visibility.report(false);
    await nextTick();
    expect(visibility.inits.at(-1)).toMatchObject({ trackVisibility: true, delay: 100 });
    expect(w.get('[role="group"]').attributes('aria-disabled')).toBe('true');
    expect(w.find('[data-testid="trusted-checking"]').exists()).toBe(false);
    await advance(500);
    expect(w.get('[data-testid="trusted-checking"]').text()).toBe('This card must be fully visible before you can answer. Scroll it into view or move what covers it.');
    await w.get('[data-testid="keep-changes-keep"]').trigger('click');
    await w.get('[data-testid="keep-changes-revert"]').trigger('click');
    expect(w.emitted('keep')).toBeUndefined();
    expect(w.emitted('revert')).toBeUndefined();

    visibility.report(true);
    await nextTick();
    expect(w.find('[data-testid="trusted-checking"]').exists()).toBe(false);
    expect(w.get('[role="group"]').attributes('aria-disabled')).toBeUndefined();
    await w.get('[data-testid="keep-changes-keep"]').trigger('click');
    expect(w.emitted('keep')).toHaveLength(1);
  });

  it('counts the 15 s down from main\'s endsAt, then shows main\'s revert at the timeout', async () => {
    const w = banner();
    expect(count(w)).toBe('15');
    await advance(5_000);
    expect(count(w)).toBe('10');
    expect(Number(bar(w).attributes('data-percent'))).toBe(67);
    await advance(10_000);
    expect(count(w)).toBe('0');
    expect(bar(w).attributes('data-percent')).toBe('0');

    await w.setProps({ state: { ...COUNTING, phase: 'reverted', endedBy: 'timeout' } });
    expect(w.get('#keep-changes-title').text()).toBe('Theme reverted.');
    expect(live(w)).toBe('Back to Bleach. Nobody answered in time. The agent\'s turn was told the change was reverted.');
    expect(w.find('[data-testid="keep-changes-keep"]').exists()).toBe(false);
    expect(w.find('[role="progressbar"]').exists()).toBe(false);
  });

  // main says who ended the countdown; the banner claims the user did only when main says so
  it('words a reverted countdown by who ended it, in English and Greek', async () => {
    const reverted: KeepChangesState = { ...COUNTING, phase: 'reverted' };
    const { previousName: _previous, ...unnamed } = reverted;
    const several: KeepChangesState = { ...unnamed, several: true, changeCount: 3 };
    const w = banner({ ...reverted, endedBy: 'user' });
    expect(live(w)).toBe('Back to Bleach. The agent\'s turn was told you reverted it.');
    await w.setProps({ state: { ...reverted, endedBy: 'engineStart' } });
    expect(live(w)).toBe('Back to Bleach. The engine restarted during the countdown and reverted the change.');
    await w.setProps({ state: reverted });
    expect(live(w)).toBe('Back to Bleach.');
    await w.setProps({ state: { ...unnamed, endedBy: 'timeout' } });
    expect(live(w)).toBe('Back to the previous look. Nobody answered in time. The agent\'s turn was told the change was reverted.');
    await w.setProps({ state: { ...several, endedBy: 'timeout' } });
    expect(live(w)).toBe('Back to the look from before the first change. Nobody answered in time. Every chat whose turn waited was told the changes were reverted.');
    await w.setProps({ state: { ...several, endedBy: 'engineStart' } });
    expect(live(w)).toBe('Back to the look from before the first change. The engine restarted during the countdown and reverted the changes.');
    await w.setProps({ state: several });
    expect(live(w)).toBe('Back to the look from before the first change.');
    const locale = shellI18n.global.locale as unknown as { value: string };
    const was = locale.value;
    expect(await loadShellLocale('el')).toBe(true);
    locale.value = 'el';
    try {
      for (const endedBy of ['timeout', 'engineStart', undefined] as const) {
        await w.setProps({ state: { ...reverted, ...(endedBy ? { endedBy } : {}) } });
        expect(live(w)).not.toContain('επαναφέρατε');
        expect(live(w).startsWith('Ξανά στο Bleach.')).toBe(true);
      }
      await w.setProps({ state: { ...reverted, endedBy: 'user' } });
      expect(live(w)).toContain('επαναφέρατε');
    } finally {
      locale.value = was;
    }
  });

  it('says the engine could not revert a change its start kept, and nothing of the kind for any other kept change', async () => {
    const kept: KeepChangesState = { ...COUNTING, phase: 'kept' };
    const w = banner({ ...kept, endedBy: 'engineStart' });
    expect(w.get('#keep-changes-title').text()).toBe('Theme kept.');
    expect(live(w)).toBe('The engine restarted and could not revert the change, so it stays. Undo Theme Change brings back the previous look.');
    await w.setProps({ state: { ...kept, endedBy: 'engineStart', several: true, changeCount: 2 } });
    expect(live(w)).toBe('The engine restarted and could not revert the changes, so they stay. Undo Theme Change takes them back one at a time.');
    await w.setProps({ state: { ...kept, endedBy: 'user' } });
    expect(live(w)).toBe('Amber Night stays. Undo Theme Change brings back Bleach.');
  });

  it('says the theme was kept and what Undo brings back', async () => {
    const w = banner({ ...COUNTING, phase: 'kept' });
    expect(w.get('#keep-changes-title').text()).toBe('Theme kept.');
    expect(live(w)).toBe('Amber Night stays. Undo Theme Change brings back Bleach.');
  });

  // An undo names the theme whose change it took back, so that theme is not what stays.
  it('never says the theme of an undone change stays when the undo is kept', () => {
    for (const before of [{ kind: 'create', theme: 'Amber Night' }, { kind: 'save', theme: 'Amber Night' }, { kind: 'wallpapersOff' }] as const) {
      const w = banner({ ...COUNTING, phase: 'kept', change: { kind: 'restore', before } });
      expect(live(w), before.kind).toBe('The change stays. Undo Theme Change brings back the previous look.');
    }
  });

  it('counts a restarted countdown from now, not from its last tick: 15 at once, shown and announced', async () => {
    const w = banner();
    await advance(8_000);
    vi.setSystemTime(START + 8_200);
    await w.setProps({ state: { ...COUNTING, endsAt: START + 8_050 + KEEP_CHANGES_MS, changeCount: 2 } });
    expect(count(w)).toBe('15');
    expect(live(w)).toBe('Keep this theme? It reverts in 15 seconds.');
    // 150 ms of the new countdown are gone by now, which the clock sampled at the last tick would not show
    expect(bar(w).attributes('data-percent')).toBe('99');
  });

  it('never counts more than the whole countdown, whatever the clock says', async () => {
    const w = banner({ ...COUNTING, endsAt: START + KEEP_CHANGES_MS + 60_000 });
    expect(count(w)).toBe('15');
    expect(bar(w).attributes('data-percent')).toBe('100');
  });

  it('takes no second answer while main says one is on its way to core, and keeps focus on its button', async () => {
    const w = banner();
    (w.vm as unknown as { focus: () => boolean }).focus();
    await w.setProps({ state: { ...COUNTING, ending: 'reverted' } });
    expect(w.get('[data-testid="keep-changes-held"]').text()).toBe('Reverting…');
    expect(w.find('[data-testid="keep-changes-count"]').exists()).toBe(false);
    expect(w.find('[role="progressbar"]').exists()).toBe(false);
    expect(w.get('[role="group"]').attributes('aria-disabled')).toBe('true');
    for (const testId of ['keep-changes-keep', 'keep-changes-revert']) {
      const button = w.get(`[data-testid="${testId}"]`);
      expect(button.attributes('aria-disabled')).toBe('true');
      expect(button.attributes('disabled')).toBeUndefined();
      await button.trigger('click');
    }
    expect(w.emitted('keep')).toBeUndefined();
    expect(w.emitted('revert')).toBeUndefined();
    expect(document.activeElement).toBe(w.get('[data-testid="keep-changes-keep"]').element);

    await w.setProps({ state: { ...COUNTING, ending: 'kept' } });
    expect(w.get('[data-testid="keep-changes-held"]').text()).toBe('Keeping…');
    // core refused: main counts again, and the buttons act again
    await w.setProps({ state: COUNTING });
    await w.get('[data-testid="keep-changes-keep"]').trigger('click');
    expect(w.emitted('keep')).toHaveLength(1);
  });

  it('says the engine is not running, in place of a countdown nothing can end, and takes no answer meanwhile', async () => {
    const w = banner({ ...COUNTING, endsAt: START - 60_000, engineDown: true });
    const waits = 'The engine is not running, so you cannot keep or revert this yet. When the engine starts again, it reverts the change, or keeps it if it cannot revert it.';
    expect(w.get('#keep-changes-desc').text()).toBe(`The agent in “Warmer sidebar” applied Amber Night. ${waits}`);
    expect(w.find('[data-testid="keep-changes-count"]').exists()).toBe(false);
    expect(w.find('[role="progressbar"]').exists()).toBe(false);
    await w.get('[data-testid="keep-changes-keep"]').trigger('click');
    await w.get('[data-testid="keep-changes-revert"]').trigger('click');
    expect(w.emitted('keep')).toBeUndefined();
    expect(w.emitted('revert')).toBeUndefined();
    await advance(250);
    expect(live(w)).toBe(waits);

    shellI18n.global.locale.value = 'el';
    await nextTick();
    expect(w.get('[data-testid="keep-changes-held"]').text()).toContain('Η μηχανή δεν εκτελείται');
    shellI18n.global.locale.value = 'en';
  });

  it('restarts with a later change and says how many changes it covers', async () => {
    const w = banner();
    await advance(8_000);
    expect(count(w)).toBe('7');
    vi.setSystemTime(START + 8_000);
    await w.setProps({ state: { ...COUNTING, endsAt: START + 8_000 + KEEP_CHANGES_MS, changeCount: 2 } });
    await advance(250);
    expect(count(w)).toBe('15');
    expect(w.get('#keep-changes-desc').text()).toContain('The agent in “Warmer sidebar” made 2 theme changes.');
  });

  it('words the change core sends as data: an undo, a schedule, an untitled chat', async () => {
    const w = banner({ ...COUNTING, change: { kind: 'restore', before: { kind: 'save', theme: 'Amber Night' } } });
    expect(w.get('#keep-changes-desc').text()).toContain('The agent in “Warmer sidebar” undid its change to Amber Night.');
    await w.setProps({ state: { ...COUNTING, change: { kind: 'schedule', enabled: true, rules: 2 } } });
    expect(w.get('#keep-changes-desc').text()).toContain('The agent in “Warmer sidebar” changed the theme schedule.');
    const { chatTitle: _untitled, ...untitled } = COUNTING;
    await w.setProps({ state: untitled });
    expect(w.get('#keep-changes-desc').text()).toContain('The agent in a chat applied Amber Night.');
    await w.setProps({ state: { ...untitled, phase: 'kept', change: { kind: 'schedule', enabled: false, rules: 0 } } });
    expect(live(w)).toBe('The change stays. Undo Theme Change brings back the previous look.');
  });

  it('announces the time politely, starting empty, then at the start and every 5 s, never every second', async () => {
    const w = banner();
    const region = w.get('[data-testid="keep-changes-live"]');
    expect(region.attributes('role')).toBe('status');
    expect(region.attributes('aria-live')).toBe('polite');
    expect(live(w)).toBe('');
    await advance(250);
    expect(live(w)).toBe('Keep this theme? It reverts in 15 seconds.');
    await advance(2_000);
    expect(live(w)).toBe('Keep this theme? It reverts in 15 seconds.');
    await advance(3_000);
    expect(live(w)).toBe('Keep this theme? It reverts in 10 seconds.');
  });

  it('holds the bar still under reduce motion while the count runs', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    const w = banner();
    await advance(6_000);
    expect(count(w)).toBe('9');
    expect(bar(w).attributes('data-percent')).toBe('100');
    expect(bar(w).attributes('aria-valuetext')).toBe('9 seconds left');
  });

  it('takes focus on Keep when F6 lands on it', async () => {
    const w = banner();
    expect((w.vm as unknown as { focus: () => boolean }).focus()).toBe(true);
    expect(document.activeElement).toBe(w.get('[data-testid="keep-changes-keep"]').element);
  });
});

describe('the Show in window strip', () => {
  it('names the chat whose card shows its proposal, and stops from Stop showing', async () => {
    const wrapper = mount(ShowInWindowStrip, { props: { proposal: { promptId: 'tc-1', chatTitle: 'Warmer sidebar' } }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    const strip = wrapper.get('[data-testid="show-in-window-strip"]');
    expect(strip.attributes('role')).toBe('region');
    expect(strip.attributes('data-trusted')).toBeDefined();
    expect(strip.text()).toContain('Showing the agent\'s proposal in the window.');
    expect(strip.text()).toContain('Answer the card in “Warmer sidebar” to keep or discard it.');
    await wrapper.get('[data-testid="show-in-window-stop"]').trigger('click');
    expect(wrapper.emitted('stop')).toHaveLength(1);
  });
});
