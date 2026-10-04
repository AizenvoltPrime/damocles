// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import QuestionPrompt from '../QuestionPrompt.vue';
import SkillApprovalPrompt from '../SkillApprovalPrompt.vue';
import { useQuestionStore } from '@/stores/useQuestionStore';
import { i18n } from '@/i18n';

/** A docked prompt's options take focus as it appears, so arrow keys and Enter answer it without a click. */

const mounted: VueWrapper[] = [];

async function show(wrapper: VueWrapper): Promise<VueWrapper> {
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const permissionCard = (): Promise<VueWrapper> => show(mount(PermissionPrompt, {
  props: { visible: true, toolUseId: 'p-1', toolName: 'Bash', command: 'rm -rf build' },
  global: { plugins: [i18n], stubs: { PermissionDestinationPicker: true } },
  attachTo: document.body,
}));

function questionCard(visible = true): Promise<VueWrapper> {
  useQuestionStore().setQuestion({
    toolUseId: 'q-1',
    questions: [{ question: 'Which branch?', header: 'Branch', multiSelect: false, options: [{ label: 'main', description: '' }, { label: 'dev', description: '' }] }],
  });
  return show(mount(QuestionPrompt, { props: { visible }, global: { plugins: [i18n] }, attachTo: document.body }));
}

const skillCard = (): Promise<VueWrapper> => show(mount(SkillApprovalPrompt, {
  props: { visible: true, skillName: 'deploy' },
  global: { plugins: [i18n] },
  attachTo: document.body,
}));

function focusedListbox(): HTMLElement | null {
  return document.activeElement?.closest<HTMLElement>('[role="listbox"]') ?? null;
}

function composer(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  textarea.focus();
  return textarea;
}

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('a docked prompt as it appears', () => {
  it('focuses the options of a question card, named by the question', async () => {
    const card = await questionCard();

    expect(focusedListbox()?.getAttribute('aria-label')).toBe('Which branch?');
    expect(card.element.contains(document.activeElement)).toBe(true);
  });

  it('focuses the options of a skill card, named by its title', async () => {
    const card = await skillCard();

    expect(focusedListbox()?.getAttribute('aria-label')).toBe('Use skill "deploy"?');
    expect(card.element.contains(document.activeElement)).toBe(true);
  });

  it('focuses the options of a permission card, named by its title', async () => {
    const card = await permissionCard();

    expect(focusedListbox()?.getAttribute('aria-label')).toBe('Run this command?');
    expect(card.element.contains(document.activeElement)).toBe(true);
  });

  it('leaves focus in the composer the user is typing in', async () => {
    const textarea = composer();

    await questionCard();
    await skillCard();

    expect(document.activeElement).toBe(textarea);
  });

  it('leaves focus with the dock prompt the user is answering', async () => {
    const permission = await permissionCard();

    await questionCard();

    expect(permission.element.contains(document.activeElement)).toBe(true);
  });

  it('focuses the next question\'s options when the user picks its tab', async () => {
    useQuestionStore().setQuestion({
      toolUseId: 'q-2',
      questions: [
        { question: 'Which branch?', header: 'Branch', multiSelect: false, options: [{ label: 'main', description: '' }] },
        { question: 'Which remote?', header: 'Remote', multiSelect: false, options: [{ label: 'origin', description: '' }] },
      ],
    });
    const card = await show(mount(QuestionPrompt, { props: { visible: true }, global: { plugins: [i18n] }, attachTo: document.body }));

    const tab = card.findAll('[data-question-tab]')[1]!;
    (tab.element as HTMLElement).focus();
    await tab.trigger('click');
    await flushPromises();

    expect(focusedListbox()?.getAttribute('aria-label')).toBe('Which remote?');
  });

  it('moves no focus while the prompt is not visible', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    await questionCard(false);

    expect(document.activeElement).toBe(button);
  });
});
