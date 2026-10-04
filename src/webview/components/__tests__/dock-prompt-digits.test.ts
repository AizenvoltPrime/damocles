// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import QuestionPrompt from '../QuestionPrompt.vue';
import SkillApprovalPrompt from '../SkillApprovalPrompt.vue';
import { useQuestionStore } from '@/stores/useQuestionStore';
import { i18n } from '@/i18n';

/**
 * One batch can dock a question card beside a permission card. A digit answers the card that holds focus,
 * and with focus outside every card it answers only a card that is alone, so "1" meant for the question
 * never approves the command.
 */

const mounted: VueWrapper[] = [];

function keep(wrapper: VueWrapper): VueWrapper {
  mounted.push(wrapper);
  return wrapper;
}

function permissionCard(): VueWrapper {
  return keep(mount(PermissionPrompt, {
    props: { visible: true, toolUseId: 'p-1', toolName: 'Bash', command: 'rm -rf build' },
    global: { plugins: [i18n], stubs: { PermissionDestinationPicker: true } },
    attachTo: document.body,
  }));
}

function questionCard(): VueWrapper {
  useQuestionStore().setQuestion({
    toolUseId: 'q-1',
    questions: [{ question: 'Which branch?', header: 'Branch', multiSelect: false, options: [{ label: 'main', description: '' }, { label: 'dev', description: '' }] }],
  });
  return keep(mount(QuestionPrompt, { props: { visible: true }, global: { plugins: [i18n] }, attachTo: document.body }));
}

function skillCard(): VueWrapper {
  return keep(mount(SkillApprovalPrompt, { props: { visible: true, skillName: 'deploy' }, global: { plugins: [i18n] }, attachTo: document.body }));
}

function press(key: string, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const answered = (): string[] => [...(useQuestionStore().selectedOptions.get('Which branch?') ?? [])];

beforeEach(() => setActivePinia(createPinia()));

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('digits with a question card docked beside a permission card', () => {
  it('answer the question, never the permission, while focus is on a question tab', () => {
    const permission = permissionCard();
    const question = questionCard();
    const tab = question.get('[data-question-tab]').element as HTMLElement;
    tab.focus();

    press('1', tab);

    expect(permission.emitted('approve')).toBeUndefined();
    expect(answered()).toEqual(['main']);
  });

  it('answer the permission card, never the question, while focus is in the permission card', () => {
    const permission = permissionCard();
    questionCard();

    press('1', permission.get('[data-testid="permission-options"]').element);

    expect(permission.emitted('approve')).toEqual([[true]]);
    expect(answered()).toEqual([]);
  });

  it('answer neither card while focus is outside both', () => {
    const permission = permissionCard();
    questionCard();

    press('1');

    expect(permission.emitted('approve')).toBeUndefined();
    expect(answered()).toEqual([]);
  });
});

describe('digits on a lone card', () => {
  it('pick the numbered option of a question from anywhere outside a text field', () => {
    questionCard();

    press('2');

    expect(answered()).toEqual(['dev']);
  });

  it('answer a skill approval from anywhere outside a text field', () => {
    const skill = skillCard();

    press('3');

    expect(skill.emitted('approve')).toEqual([[false]]);
  });
});
