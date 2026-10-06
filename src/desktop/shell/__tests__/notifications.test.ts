// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { OverlayRequest, OverlayToast } from '../../preload/overlay-channels';
import type { NotificationBody, NotificationEntry } from '../../preload/notifications';
import NotifierApp from '../overlay/NotifierApp.vue';
import OverlayApp from '../overlay/OverlayApp.vue';
import TitleBar from '../components/TitleBar.vue';
import { shellI18n } from '../i18n';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { FakeResizeObserver, fakeOverlayApi, fakeShellApi, STATE, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];
let api: FakeOverlayApi;

function mountOverlay(): VueWrapper {
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge: createOverlaySettingsBridge(api) },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

// The desktop popup window's page, the only one that renders toasts.
function mountNotifier(): VueWrapper {
  const wrapper = mount(NotifierApp, {
    props: { api },
    global: { plugins: [shellI18n], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

async function open(wrapper: VueWrapper, id: string, request: OverlayRequest): Promise<void> {
  api.request(id, request);
  await flushPromises();
  await wrapper.vm.$nextTick();
}

// The text an aria-labelledby or aria-describedby list of ids reads out, in order.
function referenced(wrapper: VueWrapper, ids: string | undefined): string {
  return (ids ?? '').split(' ').filter(Boolean).map((id) => wrapper.get(`#${id}`).text()).join(' ');
}

const press = (key: string, init: KeyboardEventInit = {}): void => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
};

const CHAT = { project: { key: 'p1', name: 'acme' }, title: 'Rate-limit the /login route' };
const APPROVAL: NotificationBody = { kind: 'approval', chat: CHAT, summary: 'edit src/routes/auth.ts (+7 lines).' };

function toast(id: string, body: NotificationBody, remainingMs = 12_000): OverlayToast {
  return { id, at: Date.now(), lifeMs: 12_000, remainingMs, body };
}

function entry(id: string, body: NotificationBody, read = false): NotificationEntry {
  return { id, at: Date.now() - 5 * 60_000, read, body };
}

const CENTER: OverlayRequest = { kind: 'notifications', anchor: { x: 900, y: 6, width: 30, height: 28 } };

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  api = fakeOverlayApi();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('notification toasts', () => {
  it('render a kind as the reference does: project avatar, header, title, coloured lead and action pill', async () => {
    const wrapper = mountNotifier();
    await flushPromises();
    api.toast(toast('a1', APPROVAL));
    await flushPromises();

    const card = wrapper.get('[data-toast-id="a1"]');
    expect(card.attributes('data-kind')).toBe('approval');
    expect(card.text()).toContain('Damocles');
    expect(card.text()).toContain('acme');
    expect(card.text()).toContain('Rate-limit the /login route');
    expect(card.get('.line-clamp-2').text()).toBe('Needs your approval to edit src/routes/auth.ts (+7 lines).');
    expect(card.get('.line-clamp-2 span').classes()).toContain('text-(--d-warning)');
    expect(card.find('.project-avatar').text()).toBe('A');
    const primary = card.get('[data-toast-primary]');
    expect(primary.text()).toBe('Review');
    expect(primary.classes()).toEqual(expect.arrayContaining(['bg-(--d-warning)/16', 'text-(--d-warning-text)']));
    expect(wrapper.get('[data-testid="overlay-toasts-assertive"]').text()).toContain('Needs your approval to');

    await primary.trigger('click');
    expect(api.resolveToast).toHaveBeenCalledWith('a1', 'open');
  });

  it('starts the life bar at the share of life main says is left, and holds the life while hovered or focused', async () => {
    const wrapper = mountNotifier();
    await flushPromises();
    api.toast(toast('d1', { kind: 'done', chat: CHAT, durationMs: 252_000 }, 6_000));
    await flushPromises();

    const card = wrapper.get('[data-toast-id="d1"]');
    expect(card.text()).toContain('Finished in 4m 12s.');
    const life = card.get('[data-testid="overlay-toast-life"]');
    const style = (life.element as HTMLElement).style;
    expect(Number(style.getPropertyValue('--life-from'))).toBeCloseTo(0.5, 1);
    expect(Number.parseFloat(style.animationDuration)).toBeGreaterThan(5_500);
    expect(Number.parseFloat(style.animationDuration)).toBeLessThanOrEqual(6_000);
    expect(life.classes()).toContain('bg-(--d-success)');

    await card.trigger('mouseenter');
    expect(api.holdToast).toHaveBeenLastCalledWith('d1', true);
    (card.get('[data-toast-primary]').element as HTMLElement).focus();
    await card.trigger('focusin');
    await card.trigger('mouseleave');
    // Focus still holds it.
    expect(api.holdToast).toHaveBeenCalledTimes(1);
    await card.trigger('focusout');
    expect(api.holdToast).toHaveBeenLastCalledWith('d1', false);
  });

  it('dismisses with the close button, never opening, and opens from a click on the card', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 2, 9, 0));
    const wrapper = mountNotifier();
    await flushPromises();
    api.toast(toast('e1', { kind: 'error', chat: CHAT, reason: 'rateLimit', windowLabel: 'Session (5hr)', resetsAt: new Date(2026, 0, 2, 14, 5).getTime() }));
    api.toast(toast('e2', { kind: 'error', chat: CHAT, reason: 'error', message: 'Overloaded' }));
    await flushPromises();

    expect(wrapper.get('[data-toast-id="e1"]').text()).toContain('Paused: The Session (5hr) limit was reached. Resets at 14:05.');
    expect(wrapper.get('[data-toast-id="e2"]').text()).toContain('Paused: Overloaded');
    await wrapper.get('[data-toast-id="e1"] [data-testid="overlay-toast-dismiss"]').trigger('click');
    expect(api.resolveToast).toHaveBeenLastCalledWith('e1', undefined);
    await wrapper.get('[data-toast-id="e2"] .line-clamp-2').trigger('click');
    expect(api.resolveToast).toHaveBeenLastCalledWith('e2', 'open');
  });

  it('shows a usage crossing under Usage with the app\'s avatar, the plan and window, and a later day\'s reset with its weekday', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2025, 11, 31, 9, 0));
    const wrapper = mountNotifier();
    await flushPromises();
    const resetsAt = new Date(2026, 0, 2, 18, 0).getTime();
    api.toast(toast('u1', { kind: 'limit', reason: 'usage', windowLabel: '5-hour window', threshold: 80, utilization: 85, resetsAt, planName: 'Max 20x' }, 9000));
    await flushPromises();

    const card = wrapper.get('[data-toast-id="u1"]');
    expect(card.attributes('data-kind')).toBe('limit');
    expect(card.text()).toContain('Damocles·Usage');
    expect(card.text()).toContain('Max 20x · 5-hour window');
    expect(card.get('.line-clamp-2').text()).toBe('Heads up: 85% used. Resets Friday 18:00.');
    expect(card.find('.project-avatar').exists()).toBe(false);
    expect(card.get('[data-toast-primary]').text()).toBe('View usage');
  });

  it('names the full window a rate limit paused the chat on and its reset, today by the clock and a later day with its weekday, and gives no time without a window (D55)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // A Friday.
    vi.setSystemTime(new Date(2026, 0, 2, 9, 0));
    const wrapper = mountNotifier();
    await flushPromises();
    api.toast(toast('today', { kind: 'error', chat: CHAT, reason: 'rateLimit', windowLabel: 'Session (5hr)', resetsAt: new Date(2026, 0, 2, 14, 5).getTime() }));
    api.toast(toast('later', { kind: 'error', chat: CHAT, reason: 'rateLimit', windowLabel: 'Weekly', resetsAt: new Date(2026, 0, 5, 18, 0).getTime() }));
    api.toast(toast('none', { kind: 'error', chat: CHAT, reason: 'rateLimit', resetsAt: new Date(2026, 0, 2, 14, 5).getTime() }));
    await flushPromises();

    const message = (id: string): string => wrapper.get(`[data-toast-id="${id}"] .line-clamp-2`).text();
    expect(message('today')).toBe('Paused: The Session (5hr) limit was reached. Resets at 14:05.');
    expect(message('later')).toBe('Paused: The Weekly limit was reached. Resets Monday 18:00.');
    expect(message('none')).toBe('Paused: The rate limit was reached.');

    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(message('today')).toBe('Σε παύση: Συμπληρώθηκε το όριο «Session (5hr)». Επαναφέρεται στις 14:05.');
    expect(message('later')).toBe('Σε παύση: Συμπληρώθηκε το όριο «Weekly». Επαναφέρεται Δευτέρα στις 18:00.');
  });
});

describe('popup sound', () => {
  it('plays main\'s chimes on the popup page and closes its audio context with the page', async () => {
    const contexts: Array<{ closed: number; gains: number }> = [];
    vi.stubGlobal('AudioContext', class {
      state = 'running';
      currentTime = 0;
      destination = {};
      readonly record = { closed: 0, gains: 0 };
      constructor() {
        contexts.push(this.record);
      }
      createGain() {
        this.record.gains++;
        return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node, disconnect() {} };
      }
      createOscillator() {
        return { type: '', frequency: { value: 0 }, onended: null, connect: (node: unknown) => node, disconnect() {}, start() {}, stop() {} };
      }
      async close() {
        this.record.closed++;
      }
    });
    const wrapper = mountNotifier();
    await flushPromises();
    expect(contexts).toHaveLength(0);

    api.chime('attention');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.gains).toBeGreaterThan(1);
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    expect(contexts[0]!.closed).toBe(1);
    // Unsubscribed with the page.
    api.chime('attention');
    expect(contexts).toHaveLength(1);
  });
});

describe('message dialog', () => {
  const SWITCH: OverlayRequest = {
    kind: 'message',
    severity: 'warning',
    message: 'Switch this panel to beta?',
    detail: 'This starts a new conversation.',
    actions: ['Start new conversation'],
    cancelLabel: 'Cancel',
    defaultAction: 0,
  };

  it('is an alertdialog on the modal layer that focuses its default action and answers its index', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'm1', SWITCH);

    const dialog = wrapper.get('[role="alertdialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('data-severity')).toBe('warning');
    // The severity is part of the name, so a screen reader says it.
    expect(referenced(wrapper, dialog.attributes('aria-labelledby'))).toBe('Warning Switch this panel to beta?');
    expect(referenced(wrapper, dialog.attributes('aria-describedby'))).toContain('This starts a new conversation.');
    expect((dialog.element.parentElement as HTMLElement).style.zIndex).toBe('60');
    const action = wrapper.get('[data-testid="overlay-message-action-0"]');
    expect(document.activeElement).toBe(action.element);

    await action.trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('m1', { kind: 'message', action: 0 }));
  });

  it('focuses Cancel without a default action, and Escape answers Cancel', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'm2', { kind: 'message', severity: 'danger', message: 'Reload?', actions: ['Reload Window'], cancelLabel: 'Cancel' });

    expect(document.activeElement).toBe(wrapper.get('[data-testid="overlay-message-cancel"]').element);
    expect(wrapper.get('[role="alertdialog"]').attributes('data-severity')).toBe('danger');
    press('Escape');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('m2', { kind: 'message', action: null }));
  });

  // The control that asked disables itself while the question is up and focus falls to the body. Each step awaits the
  // answer or the mutation itself, and the tests fake setTimeout, so the 5 s give-up runs only when a test advances it.
  async function askAndAnswer(wrapper: VueWrapper, id: string, control: HTMLButtonElement): Promise<void> {
    control.disabled = true;
    (document.activeElement as HTMLElement | null)?.blur();
    const answered = new Promise<void>((resolve) => {
      vi.mocked(api.answer).mockImplementation(() => resolve());
    });
    await open(wrapper, id, { kind: 'message', severity: 'warning', message: 'Switch?', actions: ['Switch'], cancelLabel: 'Cancel', defaultAction: 0 });
    press('Escape');
    await answered;
    await flushPromises();
    expect(api.answer).toHaveBeenCalledWith(id, { kind: 'message', action: null });
    expect(document.activeElement).not.toBe(control);
  }

  it('returns focus to the select that asked, once its row is enabled again, though it dropped focus while asking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const wrapper = mountOverlay();
    await flushPromises();
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-controls', 'listbox-1');
    const listbox = document.createElement('div');
    listbox.id = 'listbox-1';
    listbox.setAttribute('role', 'listbox');
    const option = document.createElement('button');
    listbox.append(option);
    document.body.append(trigger, listbox);
    // The user picks an option, and the listbox closes.
    option.focus();
    listbox.remove();

    await askAndAnswer(wrapper, 'm3', trigger);
    trigger.disabled = false;
    await flushPromises();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('returns focus to a switch in a panel another control merely controls, and finds a popup\'s opener among several ids', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const wrapper = mountOverlay();
    await flushPromises();
    // The settings search box controls the section panel every row sits in; it never asked anything.
    const search = document.createElement('input');
    search.setAttribute('aria-controls', 'panel-1');
    const panel = document.createElement('section');
    panel.id = 'panel-1';
    panel.setAttribute('role', 'tabpanel');
    const toggle = document.createElement('button');
    toggle.setAttribute('role', 'switch');
    panel.append(toggle);
    document.body.append(search, panel);
    toggle.focus();

    await askAndAnswer(wrapper, 'm4', toggle);
    toggle.disabled = false;
    await flushPromises();
    expect(document.activeElement).toBe(toggle);

    // A combobox naming its listbox among other ids.
    const combobox = document.createElement('button');
    combobox.setAttribute('aria-controls', 'hint-1 listbox-2');
    const listbox = document.createElement('div');
    listbox.id = 'listbox-2';
    listbox.setAttribute('role', 'listbox');
    const option = document.createElement('div');
    option.tabIndex = -1;
    listbox.append(option);
    panel.append(combobox, listbox);
    option.focus();
    listbox.remove();

    await askAndAnswer(wrapper, 'm5', combobox);
    combobox.disabled = false;
    await flushPromises();
    expect(document.activeElement).toBe(combobox);

    // Past the wait, a control enabled again no longer takes focus.
    await askAndAnswer(wrapper, 'm6', combobox);
    vi.advanceTimersByTime(5000);
    combobox.disabled = false;
    await flushPromises();
    expect(document.activeElement).not.toBe(combobox);
    search.remove();
    panel.remove();
  });
});

describe('notification center', () => {
  it('lists the entries newest first with unread dots, and opening a row answers it', async () => {
    api.center.state = {
      entries: [
        entry('n2', { kind: 'question', chat: CHAT, summary: 'Retry on 5xx too?' }),
        entry('n1', { kind: 'limit', reason: 'usage', windowLabel: '5-hour window', threshold: 80, utilization: 85, planName: 'Max 20x' }, true),
      ],
      doNotDisturb: false,
      popupsOff: false,
    };
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'c1', CENTER);
    await flushPromises();

    expect(wrapper.get('[data-testid="notification-count"]').text()).toBe('2');
    const rows = wrapper.findAll('[data-testid="notification-row"]');
    expect(rows.map((row) => row.attributes('data-entry-id'))).toEqual(['n2', 'n1']);
    expect(rows[0]!.text()).toContain('Asks: Retry on 5xx too?');
    expect(rows[0]!.text()).toContain('5m ago');
    expect(rows[0]!.text()).toContain('Unread');
    expect(rows[1]!.text()).toContain('Max 20x · 5-hour window');
    expect(rows[1]!.text()).not.toContain('Unread');
    expect(document.activeElement).toBe(rows[0]!.element);

    press('ArrowDown');
    expect(document.activeElement).toBe(rows[1]!.element);
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[0]!.element);

    await rows[1]!.trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'notifications', action: 'open', entryId: 'n1' }));
  });

  it('turns Do not disturb on, clears the log and says when the log is empty, with only its caption in the footer', async () => {
    api.center.state = { entries: [entry('n1', APPROVAL)], doNotDisturb: false, popupsOff: false };
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'c1', CENTER);
    await flushPromises();

    expect(wrapper.get('[data-testid="notification-dnd-subtitle"]').text()).toBe('Pop-ups show when a chat needs you');
    // Named by its heading alone, with the subtitle as its description rather than also in its name.
    const dnd = wrapper.get('[data-testid="notification-dnd"]');
    expect(referenced(wrapper, dnd.attributes('aria-labelledby'))).toBe('Do not disturb');
    expect(referenced(wrapper, dnd.attributes('aria-describedby'))).toBe('Pop-ups show when a chat needs you');
    await dnd.trigger('click');
    expect(api.setDoNotDisturb).toHaveBeenCalledWith(true);
    api.pushNotifications({ entries: [entry('n1', APPROVAL)], doNotDisturb: true, popupsOff: false });
    await flushPromises();
    expect(wrapper.get('[data-testid="notification-dnd-subtitle"]').text()).toBe('No pop-ups. They still collect here');
    expect(wrapper.get('[data-testid="notification-dnd"]').attributes('aria-checked')).toBe('true');

    const clear = wrapper.get('[data-testid="notification-clear"]');
    (clear.element as HTMLElement).focus();
    await clear.trigger('click');
    expect(api.clearNotifications).toHaveBeenCalled();
    api.pushNotifications({ entries: [], doNotDisturb: true, popupsOff: true });
    await flushPromises();
    expect(wrapper.get('[data-testid="notification-empty"]').text()).toBe('You’re all caught up');
    expect(wrapper.find('[data-testid="notification-clear"]').exists()).toBe(false);
    // Clear all went with the log while it had focus; focus stays in the center, on the switch.
    expect(document.activeElement).toBe(wrapper.get('[data-testid="notification-dnd"]').element);
    expect(wrapper.get('[data-testid="notification-dnd-subtitle"]').text()).toBe('Pop-ups are turned off in Settings');

    const footer = wrapper.get('[data-testid="notification-footer"]');
    expect(footer.text()).toBe('Approvals, plans, questions and finished chats');
    expect(footer.find('button').exists()).toBe(false);
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('ignores main refusing Clear all and Do not disturb once the center has closed', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      api.center.state = { entries: [entry('n1', APPROVAL)], doNotDisturb: false, popupsOff: false };
      // Plain functions: a vi.fn would itself handle the promise it returns.
      const refused: string[] = [];
      api.clearNotifications = () => {
        refused.push('clear');
        return Promise.reject(new Error('the center is not open'));
      };
      api.setDoNotDisturb = (on: boolean) => {
        refused.push(`dnd ${on}`);
        return Promise.reject(new Error('the center is not open'));
      };
      const wrapper = mountOverlay();
      await flushPromises();
      await open(wrapper, 'c1', CENTER);
      await flushPromises();

      await wrapper.get('[data-testid="notification-clear"]').trigger('click');
      await wrapper.get('[data-testid="notification-dnd"]').trigger('click');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(refused).toEqual(['clear', 'dnd true']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('colours a row\'s lead in its tone\'s text shade, which keeps AA on the hovered or focused row (D48), and names a rate limit\'s full window (D55)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 2, 9, 0));
    api.center.state = {
      entries: [
        entry('n3', { kind: 'error', chat: CHAT, reason: 'rateLimit', windowLabel: 'Weekly' }),
        entry('n2', { kind: 'question', chat: CHAT, summary: 'Retry on 5xx too?' }),
        entry('n1', APPROVAL),
      ],
      doNotDisturb: false,
      popupsOff: false,
    };
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'c1', CENTER);
    await flushPromises();

    const leads = wrapper.findAll('[data-testid="notification-row"] .line-clamp-2 > span');
    expect(leads.map((lead) => lead.classes().find((name) => name.startsWith('text-')))).toEqual([
      'text-(--d-danger-text)',
      'text-(--d-info-text)',
      'text-(--d-warning-text)',
    ]);
    expect(wrapper.findAll('[data-testid="notification-row"]')[0]!.text()).toContain('Paused: The Weekly limit was reached.');
    expect(wrapper.findAll('[data-testid="notification-row"]')[0]!.text()).not.toContain('Resets');
  });

  it('virtualizes a log past 200 entries', async () => {
    api.center.state = {
      entries: Array.from({ length: 250 }, (_, index) => entry(`n${index}`, { kind: 'done', chat: CHAT })),
      doNotDisturb: false,
      popupsOff: false,
    };
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'c1', CENTER);
    await flushPromises();

    expect(wrapper.get('[data-testid="notification-count"]').text()).toBe('250');
    const rendered = wrapper.findAll('[data-testid="notification-row"]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(250);
  });
});

describe('title bar bell', () => {
  it('shows the unseen count on a badge, rings for a new attention entry, keeps the pop-up state in its label and opens the center under the bell', async () => {
    const shell = fakeShellApi();
    const wrapper = mount(TitleBar, { props: { api: shell, state: STATE }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    const bell = wrapper.get('[data-testid="notification-bell"]');
    expect(bell.attributes('title')).toBe('Notifications');
    expect(wrapper.find('[data-testid="notification-badge"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="notification-bell-icon"]').classes()).not.toContain('bell-ring');

    await wrapper.setProps({ state: { ...STATE, notifications: { unseen: 3, doNotDisturb: false, popupsOff: false, attention: 1 } } });
    const badge = wrapper.get('[data-testid="notification-badge"]');
    expect(badge.text()).toBe('3');
    expect(badge.classes()).toEqual(expect.arrayContaining(['bg-(--d-warning)', 'text-(--d-on-warning)', 'bell-badge-pop']));
    expect(wrapper.get('[data-testid="notification-bell-icon"]').classes()).toContain('bell-ring');
    expect(bell.attributes('aria-label')).toBe('Notifications, 3 new');

    // The label keeps the state the title shows.
    await wrapper.setProps({ state: { ...STATE, notifications: { unseen: 3, doNotDisturb: true, popupsOff: false, attention: 1 } } });
    expect(bell.attributes('title')).toBe('Notifications · Do not disturb is on');
    expect(bell.attributes('aria-label')).toBe('Notifications, 3 new · Do not disturb is on');
    await wrapper.setProps({ state: { ...STATE, notifications: { unseen: 1, doNotDisturb: false, popupsOff: true, attention: 1 } } });
    expect(bell.attributes('title')).toBe('Notifications · Pop-ups are turned off in Settings');
    expect(bell.attributes('aria-label')).toBe('Notifications, 1 new · Pop-ups are turned off in Settings');

    vi.spyOn(bell.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(912, 6, 30, 28));
    await bell.trigger('click');
    expect(shell.overlayRequests).toEqual([{ kind: 'notifications', anchor: { x: 912, y: 6, width: 30, height: 28 } }]);
  });

  it('counts new entries in Greek in the singular and the plural', async () => {
    shellI18n.global.locale.value = 'el';
    const wrapper = mount(TitleBar, {
      props: { api: fakeShellApi(), state: { ...STATE, notifications: { unseen: 1, doNotDisturb: false, popupsOff: false, attention: 0 } } },
      global: { plugins: [shellI18n] },
    });
    mounted.push(wrapper);
    const bell = wrapper.get('[data-testid="notification-bell"]');
    expect(bell.attributes('aria-label')).toBe('Ειδοποιήσεις, 1 νέα');
    await wrapper.setProps({ state: { ...STATE, notifications: { unseen: 3, doNotDisturb: true, popupsOff: false, attention: 0 } } });
    expect(bell.attributes('aria-label')).toBe('Ειδοποιήσεις, 3 νέες · Η λειτουργία «Μην ενοχλείτε» είναι ενεργή');
  });
});
