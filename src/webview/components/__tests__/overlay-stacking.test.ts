// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, markRaw } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import type { TeamAgent, TeamState } from '@shared/types/team';
import ToolOverlay from '../ToolOverlay.vue';
import TeamAgentOverlay from '../TeamAgentOverlay.vue';
import SubagentOverlay from '../SubagentOverlay.vue';
import MemoryPanel from '../MemoryPanel.vue';
import OverlayShell from '../OverlayShell.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { MODAL_Z_INDEX } from '@/composables/useOverlayEscape';
import { i18n } from '@/i18n';
import { at } from '@/__tests__/helpers';

/**
 * Two full-screen overlays open at once must paint in the order the user opened them.
 *
 * They used to share one hardcoded z-index, so the winner was whichever sibling `App.vue` happened to
 * write last. That put the tool overlay behind a team agent overlay and in front of a subagent one,
 * from nothing but the order of two lines in a template. These tests mount the real components in the
 * order the user opens them and read the z-index off the rendered root, so a fix that only reordered
 * the mounts would not satisfy them.
 */

const BASE_Z = 50;

const mounted: VueWrapper[] = [];

function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}

/**
 * The rendered z-index of an overlay's root element, which is what actually decides what paints on top.
 *
 * Only the inline style counts. A `z-50` utility class reads as 50 too, so accepting one would let an
 * overlay that went back to a hardcoded z-index pass every case below that expects the base value.
 */
function zIndexOf(wrapper: VueWrapper): number {
  const root = wrapper.element as HTMLElement;
  const inline = root.style.zIndex;
  if (inline === '') {
    throw new Error(`overlay root has no derived z-index, only classes: ${root.className}`);
  }
  return Number(inline);
}

const TOOL_CALL: ToolCall = { id: 't-1', name: 'Bash', input: { command: 'ls' }, status: 'completed', result: 'a' };
const RUNNING_TOOL_CALL: ToolCall = { id: 't-run', name: 'Bash', input: { command: 'sleep 60' }, status: 'running' };

function openToolOverlay(tool: ToolCall = TOOL_CALL): VueWrapper {
  return track(mount(ToolOverlay, {
    props: { tool },
    global: { plugins: [i18n], stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true } },
    attachTo: document.body,
  }));
}

function teamAgent(): TeamAgent {
  return {
    agentId: 'agent-1', name: 'worker', role: 'specialist', specialization: 'do it', model: 'sonnet',
    profileId: null, attempt: 0, status: 'running', startTime: 1, endTime: null, toolCount: 1, lastToolName: 'Bash',
    totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    dollarBilled: true, progressSummary: null, result: null, logFilePath: null,
  };
}

function team(): TeamState {
  return {
    teamId: 'team-1', toolUseId: 'toolu_1', title: 'Team', status: 'running', phase: 'working',
    agents: [teamAgent()], messages: [], scratchpad: [], result: null, startTime: 1, endTime: null,
    totalToolCount: 1,
  };
}

function openTeamAgentOverlay(): VueWrapper {
  const store = useTeamStore();
  store.restoreTeamFromHistory(team());
  store.openOverlay('team-1');
  store.openAgentOverlay('agent-1');
  store.agentMessages = {
    'agent-1': [{ id: 'msg-1', role: 'assistant', content: 'working', toolCalls: [TOOL_CALL], timestamp: 1 }],
  };

  return track(mount(TeamAgentOverlay, {
    global: { plugins: [i18n], stubs: { ToolCallCard: true, MarkdownRenderer: true, LoadingSpinner: true } },
    attachTo: document.body,
  }));
}

function subagent(): SubagentState {
  return {
    id: 'sub-1', sdkAgentId: 'agent-9', agentType: 'Explore', description: 'find', prompt: 'find things',
    status: 'running', startTime: 1, toolCalls: [], messages: [],
    isBackground: false, messagesSealed: false,
  };
}

function openSubagentOverlay(): VueWrapper {
  return track(mount(SubagentOverlay, {
    props: { subagent: subagent() },
    global: { plugins: [i18n], stubs: { ToolCallCard: true, MarkdownRenderer: true, LoadingSpinner: true } },
    attachTo: document.body,
  }));
}

function openMemoryPanel(): VueWrapper {
  return track(mount(MemoryPanel, {
    props: { notes: [], observations: [], searchResults: [], hasMoreObservations: false, loadingObservations: false },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  }));
}

function pressEscape(): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

const StubIcon = markRaw({ render: () => h('span', { class: 'stub-icon' }) });

/** A bare `OverlayShell` with a known set of focusable children, so Tab order is decided by the test. */
function openShell(title: string, buttonLabels: readonly string[] = []): VueWrapper {
  return track(mount(OverlayShell, {
    props: { title, icon: StubIcon },
    slots: { default: () => buttonLabels.map((label) => h('button', { class: 'body-btn' }, label)) },
    global: { plugins: [i18n] },
    attachTo: document.body,
  }));
}

function closeButtonOf(wrapper: VueWrapper): HTMLElement {
  return wrapper.get('[aria-label="Close"]').element as HTMLElement;
}

function focusablesOf(wrapper: VueWrapper): HTMLElement[] {
  return wrapper.findAll('button').map((b) => b.element as HTMLElement);
}

/** Mirrors the selector the dialog itself uses, for panels whose focusables are not all buttons. */
function focusableWithin(wrapper: VueWrapper): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from((wrapper.element as HTMLElement).querySelectorAll<HTMLElement>(selector));
}

/** Dispatched from whatever currently holds focus, which is what a real Tab press does. */
function pressTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function unmountTracked(wrapper: VueWrapper): void {
  wrapper.unmount();
  const index = mounted.indexOf(wrapper);
  if (index !== -1) mounted.splice(index, 1);
}

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  // The overlay stack lives at module scope, so an overlay left mounted leaks into the next test.
  while (mounted.length > 0) mounted.pop()?.unmount();
});

describe('a tool overlay opened from a team agent overlay', () => {
  it('paints above the overlay it was opened from', () => {
    const teamOverlay = openTeamAgentOverlay();
    const toolOverlay = openToolOverlay();

    expect(zIndexOf(toolOverlay)).toBeGreaterThan(zIndexOf(teamOverlay));
  });

  it('takes Escape while the team overlay beneath it keeps its own', () => {
    const teamOverlay = openTeamAgentOverlay();
    const toolOverlay = openToolOverlay();

    pressEscape();

    expect(toolOverlay.emitted('close')).toHaveLength(1);
    expect(teamOverlay.emitted('close')).toBeUndefined();
  });

  it('hands the stacking back when it closes, so the next one opened rises again', async () => {
    const teamOverlay = openTeamAgentOverlay();
    const first = openToolOverlay();
    const raised = zIndexOf(first);

    first.unmount();
    mounted.splice(mounted.indexOf(first), 1);
    await teamOverlay.vm.$nextTick();

    expect(zIndexOf(teamOverlay)).toBe(BASE_Z);

    const second = openToolOverlay();
    expect(zIndexOf(second)).toBe(raised);
  });
});

describe('a tool overlay opened from a subagent overlay', () => {
  it('still paints above it, which it did before only by accident of mount order', () => {
    const subagentOverlay = openSubagentOverlay();
    const toolOverlay = openToolOverlay();

    expect(zIndexOf(toolOverlay)).toBeGreaterThan(zIndexOf(subagentOverlay));
  });

  it('takes Escape rather than closing the subagent overlay underneath', () => {
    const subagentOverlay = openSubagentOverlay();
    const toolOverlay = openToolOverlay();

    pressEscape();

    expect(toolOverlay.emitted('close')).toHaveLength(1);
    expect(subagentOverlay.emitted('close')).toBeUndefined();
  });
});

describe('the overlay opened on its own', () => {
  it.each([
    ['tool overlay', openToolOverlay],
    ['team agent overlay', openTeamAgentOverlay],
    ['subagent overlay', openSubagentOverlay],
    ['memory panel', openMemoryPanel],
  ])('renders %s at the base of the stack', (_name, open) => {
    expect(zIndexOf(open())).toBe(BASE_Z);
  });

  it('closes the memory panel on Escape', () => {
    const panel = openMemoryPanel();

    pressEscape();

    expect(panel.emitted('close')).toHaveLength(1);
  });

  it('leaves the memory panel alone while a tool overlay sits above it', () => {
    const panel = openMemoryPanel();
    const toolOverlay = openToolOverlay();

    expect(zIndexOf(toolOverlay)).toBeGreaterThan(zIndexOf(panel));

    pressEscape();

    expect(toolOverlay.emitted('close')).toHaveLength(1);
    expect(panel.emitted('close')).toBeUndefined();
  });

  it('raises the memory panel when it is the one opened second', () => {
    // Today nothing opens it over another overlay, but that is a property of the call sites rather
    // than of the component, and it is the property that stops holding first.
    const beneath = openSubagentOverlay();
    const panel = openMemoryPanel();

    expect(zIndexOf(panel)).toBe(zIndexOf(beneath) + 1);

    pressEscape();

    expect(panel.emitted('close')).toHaveLength(1);
    expect(beneath.emitted('close')).toBeUndefined();
  });
});

describe('the stacking source', () => {
  it('follows the order the user opened them, not the order they appear in the template', () => {
    // ToolOverlay is written ahead of TeamAgentOverlay in App.vue, so DOM sibling order ranks it lower.
    // Mounting in that same template order and still getting the opened-last overlay on top is the
    // whole point; a mount reorder would leave this red.
    const first = openToolOverlay();
    const second = openTeamAgentOverlay();

    expect(zIndexOf(second)).toBeGreaterThan(zIndexOf(first));
  });

  it('ranks three overlays in the order they were opened', () => {
    const wrappers = [openSubagentOverlay(), openTeamAgentOverlay(), openToolOverlay()];
    const zIndexes = wrappers.map(zIndexOf);

    expect(zIndexes).toEqual([BASE_Z, BASE_Z + 1, BASE_Z + 2]);
    expect(at(zIndexes, 2)).toBeGreaterThan(at(zIndexes, 1));
  });

  it('does not raise an overlay above the global modal layer for any realistic nesting', () => {
    const wrappers = [openSubagentOverlay(), openTeamAgentOverlay(), openToolOverlay()];

    for (const wrapper of wrappers) expect(zIndexOf(wrapper)).toBeLessThan(MODAL_Z_INDEX);
  });

  it('clamps below the modal layer however deep the nesting goes', () => {
    // Depth alone used to decide the number, so the eleventh overlay reached the modal layer and the
    // twelfth covered it. Nothing today opens eleven, which is why the arithmetic needs pinning here.
    const deep = Array.from({ length: 20 }, () => openShell('deep'));

    for (const wrapper of deep) expect(zIndexOf(wrapper)).toBeLessThan(MODAL_Z_INDEX);
    expect(zIndexOf(at(deep, deep.length - 1))).toBe(MODAL_Z_INDEX - 1);
  });
});

describe('the dialog an overlay presents to a screen reader', () => {
  it('is a modal dialog named by the heading it already renders', () => {
    const overlay = openSubagentOverlay();
    const root = overlay.element as HTMLElement;

    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');

    const labelId = root.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const heading = root.querySelector(`#${labelId}`);
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('find');
  });

  it('gives every overlay in the group the same dialog semantics', () => {
    for (const open of [openToolOverlay, openTeamAgentOverlay, openSubagentOverlay]) {
      const root = open().element as HTMLElement;
      expect(root.getAttribute('role')).toBe('dialog');
      expect(root.getAttribute('aria-modal')).toBe('true');
      const heading = root.querySelector(`#${root.getAttribute('aria-labelledby')}`);
      expect(heading?.textContent?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('names the close button, which is otherwise an unlabelled arrow glyph', () => {
    const overlay = openSubagentOverlay();

    expect(closeButtonOf(overlay).tagName).toBe('BUTTON');
  });

  it('gives two overlays in the same app distinct heading ids, so neither steals the other name', () => {
    // Both shells under one root, because ids are minted per app: two `mount` calls are two apps and
    // would collide here while the real webview, which has one app, would not.
    const both = track(mount(
      defineComponent({
        setup: () => () => [
          h(OverlayShell, { title: 'beneath', icon: StubIcon }),
          h(OverlayShell, { title: 'top', icon: StubIcon }),
        ],
      }),
      { global: { plugins: [i18n] }, attachTo: document.body },
    ));

    const ids = both.findAllComponents(OverlayShell)
      .map((shell) => (shell.element as HTMLElement).getAttribute('aria-labelledby'));

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
  });
});

describe('where focus sits while an overlay is open', () => {
  it('moves to the close button when the overlay opens', () => {
    const overlay = openSubagentOverlay();

    expect(document.activeElement).toBe(closeButtonOf(overlay));
  });

  it('returns to the element that was focused before the overlay mounted', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const overlay = openSubagentOverlay();
    expect(document.activeElement).not.toBe(trigger);

    unmountTracked(overlay);

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('lands on the transcript region when the control that opened it was recycled away', () => {
    // The message list is virtualized, so the row a tool overlay was opened from can be unmounted
    // while the overlay is up. Focusing a detached element is a no-op and focus falls to the body.
    const region = document.createElement('div');
    region.setAttribute('data-overlay-return-focus', '');
    region.tabIndex = -1;
    document.body.appendChild(region);

    const row = document.createElement('div');
    const opener = document.createElement('button');
    row.appendChild(opener);
    document.body.appendChild(row);
    opener.focus();

    const overlay = openSubagentOverlay();
    row.remove();
    expect(opener.isConnected).toBe(false);

    unmountTracked(overlay);

    expect(document.activeElement).toBe(region);
    expect(document.activeElement).not.toBe(document.body);

    region.remove();
  });

  it('prefers the opener over the fallback region while the opener is still on screen', () => {
    const region = document.createElement('div');
    region.setAttribute('data-overlay-return-focus', '');
    region.tabIndex = -1;
    document.body.appendChild(region);

    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const overlay = openSubagentOverlay();
    unmountTracked(overlay);

    expect(document.activeElement).toBe(opener);

    opener.remove();
    region.remove();
  });

  it('returns to the overlay beneath when a nested overlay closes', () => {
    const beneath = openSubagentOverlay();
    const beneathClose = closeButtonOf(beneath);
    const top = openToolOverlay();

    expect(document.activeElement).toBe(closeButtonOf(top));

    unmountTracked(top);

    expect(document.activeElement).toBe(beneathClose);
  });
});

describe('the memory panel as a dialog', () => {
  it('is a modal dialog named by the heading it already renders', () => {
    const panel = openMemoryPanel();
    const root = panel.element as HTMLElement;

    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');

    const heading = root.querySelector(`#${root.getAttribute('aria-labelledby')}`);
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent?.trim()).toBe('Memory');
  });

  it('moves focus to its named close button on open', () => {
    const panel = openMemoryPanel();

    expect(document.activeElement).toBe(closeButtonOf(panel));
  });

  it('hands focus back to the control that opened it', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const panel = openMemoryPanel();
    expect(document.activeElement).not.toBe(trigger);

    unmountTracked(panel);

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('contains Tab while it is the top of the stack', () => {
    const panel = openMemoryPanel();
    const items = focusableWithin(panel);
    expect(items.length).toBeGreaterThan(1);

    at(items, items.length - 1).focus();
    const event = pressTab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(at(items, 0));
    expect(at(items, 0)).toBe(closeButtonOf(panel));
  });

  it('still closes from Escape and from the named close button', () => {
    const panel = openMemoryPanel();

    pressEscape();
    expect(panel.emitted('close')).toHaveLength(1);

    closeButtonOf(panel).click();
    expect(panel.emitted('close')).toHaveLength(2);
  });
});

describe('Tab containment', () => {
  it('wraps from the last focusable back to the first, inside the top overlay', () => {
    const top = openShell('top', ['one', 'two']);
    const items = focusablesOf(top);
    at(items, items.length - 1).focus();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(at(items, 0));
  });

  it('wraps backwards from the first focusable to the last', () => {
    const top = openShell('top', ['one', 'two']);
    const items = focusablesOf(top);
    at(items, 0).focus();

    const event = pressTab(true);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(at(items, items.length - 1));
  });

  it('leaves Tab alone in the middle of the overlay, so ordinary order still works', () => {
    const top = openShell('top', ['one', 'two']);
    const items = focusablesOf(top);
    at(items, 0).focus();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves focus alone where another overlay in the stack holds it, rather than fighting over it', () => {
    // Both overlays listen on `document`. A dialog recovers focus that has been lost, it does not
    // reach into another widget and take focus that was deliberately placed there.
    const beneath = openShell('beneath', ['beneath body']);
    const top = openShell('top', ['top body']);
    const inBeneath = at(focusablesOf(beneath), 1);
    inBeneath.focus();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(inBeneath);
    expect(top.element.contains(document.activeElement)).toBe(false);
  });

  it('leaves Tab to a modal that portals itself outside the overlay root', () => {
    // The memory panel's version history dialog renders through a portal on `document.body`, and the
    // extension UI dialog sits above the whole stack. Trapping Tab back would break both.
    const top = openShell('top', ['one']);
    const portal = document.createElement('div');
    const inPortal = document.createElement('button');
    portal.appendChild(inPortal);
    document.body.appendChild(portal);
    inPortal.focus();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(inPortal);
    expect(top.element.contains(document.activeElement)).toBe(false);

    portal.remove();
  });

  it('pulls focus back when it has escaped to the document body', () => {
    const top = openShell('top', ['one']);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(top.element.contains(document.activeElement)).toBe(false);

    pressTab();

    expect(document.activeElement).toBe(closeButtonOf(top));
  });

  it('does not trap Tab while a different kind of overlay sits above it', () => {
    // A shell beneath the top of the stack that still trapped would hold Tab inside a panel the user
    // has left, and the two document listeners would take turns moving focus on every press.
    const shell = openShell('beneath', ['beneath body']);
    openMemoryPanel();
    const items = focusablesOf(shell);
    at(items, items.length - 1).focus();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(at(items, items.length - 1));
  });

  it('keeps the cancel note textarea reachable and leaves its own Escape alone', async () => {
    // The note textarea stops Escape itself so a half-typed note is not thrown away by closing the
    // overlay around it. The shell listens on `document` in the bubble phase, which is what lets that
    // work; a capture-phase listener on the shell would fire first and close the overlay instead.
    const overlay = openToolOverlay(RUNNING_TOOL_CALL);
    // Named by the key rather than by `aria-busy`, which the shell could start carrying too.
    const trigger = overlay.get(`[aria-label="${i18n.global.t('toolCall.stopWithNote')}"]`);
    await trigger.trigger('click');
    await overlay.vm.$nextTick();

    const textarea = overlay.get('textarea');
    expect(document.activeElement).toBe(textarea.element);

    await textarea.trigger('keydown', { key: 'Escape' });

    expect(overlay.emitted('close')).toBeUndefined();

    // The same key from anywhere else still closes the overlay, so the case above is the textarea
    // stopping the event rather than the shell having lost its handler.
    pressEscape();
    expect(overlay.emitted('close')).toHaveLength(1);
  });

  it('counts an aria-disabled cancel trigger as focusable, so stopping does not strand the user', async () => {
    // The trigger is the last focusable in this overlay and is exactly the element focus was just
    // restored to. A trap that filtered on `aria-disabled` would let Tab walk out of the dialog.
    const overlay = openToolOverlay({ ...RUNNING_TOOL_CALL, cancelRequested: true });
    await overlay.vm.$nextTick();

    const items = focusablesOf(overlay);
    const trigger = overlay.get('[aria-disabled="true"]').element as HTMLElement;
    expect(at(items, items.length - 1)).toBe(trigger);

    trigger.focus();
    const event = pressTab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(at(items, 0));
  });

  it('takes the trap back when the overlay above it closes', () => {
    const shell = openShell('beneath', ['beneath body']);
    const above = openMemoryPanel();
    unmountTracked(above);
    const items = focusablesOf(shell);
    at(items, items.length - 1).focus();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(at(items, 0));
  });
});
