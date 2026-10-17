// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { Component } from 'vue';
import type { ToolCall } from '@shared/types/session';
import FormToolCard from '../FormToolCard.vue';
import QuestionToolCard from '../QuestionToolCard.vue';
import SkillToolCard from '../SkillToolCard.vue';
import EnterPlanModeToolCard from '../EnterPlanModeToolCard.vue';
import { i18n } from '@/i18n';

/** The prompt cards' notes for a call the runtime blocked and for one the Stop settled. */

const REASON = 'Only read-only tools run in plan mode.';

function render(component: Component, status: ToolCall['status'], feedback?: string): VueWrapper {
  const toolCall: ToolCall = { id: 't-1', name: 'AnyTool', input: { skill: 'demo', questions: [], fields: [] }, status, ...(feedback ? { feedback } : {}) };
  return mount(component, { props: { toolCall }, global: { plugins: [i18n] } });
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
});

describe.each<[string, Component]>([
  ['FormToolCard', FormToolCard],
  ['QuestionToolCard', QuestionToolCard],
  ['SkillToolCard', SkillToolCard],
  ['EnterPlanModeToolCard', EnterPlanModeToolCard],
])('%s blocked by the runtime', (_name, component) => {
  it('shows the Blocked badge and the reason core gave', () => {
    const wrapper = render(component, 'blocked', REASON);

    expect(wrapper.find('[data-testid="tool-card-blocked"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="tool-card-blocked-reason"]').text()).toBe(REASON);
  });

  it('never words the block as the user\'s rejection', () => {
    const text = render(component, 'blocked', REASON).text();

    expect(text).not.toMatch(/denied|declined|cancelled/i);
  });
});

describe('headers of a blocked request', () => {
  it('name the blocked skill', () => {
    expect(render(SkillToolCard, 'blocked', REASON).text()).toContain('Skill "demo" blocked');
  });

  it('say plan mode was blocked', () => {
    expect(render(EnterPlanModeToolCard, 'blocked', REASON).text()).toContain('Plan mode blocked');
  });
});

describe('a prompt the Stop settled', () => {
  it('says the question was cancelled', () => {
    expect(render(QuestionToolCard, 'cancelled').text()).toContain('Question cancelled');
  });

  it('says the form was cancelled', () => {
    expect(render(FormToolCard, 'cancelled').text()).toContain('Cancelled by user');
  });

  it('reads the same in Greek', () => {
    i18n.global.locale.value = 'el';

    expect(render(QuestionToolCard, 'cancelled').text()).toContain('Η ερώτηση ακυρώθηκε');
    expect(render(SkillToolCard, 'blocked', REASON).text()).toContain('Το skill "demo" αποκλείστηκε');
  });
});
