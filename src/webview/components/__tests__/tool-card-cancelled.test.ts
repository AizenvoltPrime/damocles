// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import type { Component } from 'vue';
import FormToolCard from '../FormToolCard.vue';
import QuestionToolCard from '../QuestionToolCard.vue';
import SkillToolCard from '../SkillToolCard.vue';
import EnterPlanModeToolCard from '../EnterPlanModeToolCard.vue';
import ExitPlanModeToolCard from '../ExitPlanModeToolCard.vue';
import { IconBan, IconCheckCircle } from '../icons';
import { i18n } from '@/i18n';

/**
 * The five specialised cards share one status mapping. `cancelled` is in the status union every card
 * receives, so a card that falls through to the default renders a live-looking gear on a stopped call.
 * The glyphs are compared by path data, because a card that renders no icon at all would pass an
 * assertion that only checks the wrong glyph is absent.
 */

function pathOf(icon: { render?: unknown } | ((...args: never[]) => unknown)): string {
  const vnode = (icon as (props: object) => { children: { props: { d: string } }[] })({});
  const first = vnode.children[0];
  if (!first) throw new Error('icon rendered no path');
  return first.props.d;
}

const BAN_PATH = pathOf(IconBan);
const CHECK_CIRCLE_PATH = pathOf(IconCheckCircle);

const CARDS: Array<[string, Component]> = [
  ['FormToolCard', FormToolCard],
  ['QuestionToolCard', QuestionToolCard],
  ['SkillToolCard', SkillToolCard],
  ['EnterPlanModeToolCard', EnterPlanModeToolCard],
  ['ExitPlanModeToolCard', ExitPlanModeToolCard],
];

function call(status: ToolCall['status']): ToolCall {
  return { id: 't-1', name: 'AnyTool', input: { skill: 'demo', questions: [], fields: [] }, status };
}

function render(component: Component, status: ToolCall['status']): VueWrapper {
  return mount(component, {
    props: { toolCall: call(status) },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
  });
}

function headerPaths(wrapper: VueWrapper): string[] {
  return wrapper.findAll('svg path').map((p) => p.attributes('d') ?? '');
}

beforeEach(() => setActivePinia(createPinia()));

describe.each(CARDS)('%s on a cancelled call', (_name, component) => {
  it('renders the neutral ban glyph', () => {
    expect(headerPaths(render(component, 'cancelled'))).toContain(BAN_PATH);
  });

  it('renders the success glyph for the status it must not be confused with', () => {
    // Pins the contrast: a card rendering no status glyph at all would pass the case above.
    const paths = headerPaths(render(component, 'completed'));

    expect(paths).toContain(CHECK_CIRCLE_PATH);
    expect(paths).not.toContain(BAN_PATH);
  });

  it('dims the card the way it dims an abandoned one', () => {
    expect(render(component, 'cancelled').html()).toContain('opacity-60');
    expect(render(component, 'completed').html()).not.toContain('opacity-60');
  });

  it('takes neither success nor error colouring', () => {
    const html = render(component, 'cancelled').html();

    expect(html).not.toContain('text-success');
    expect(html).not.toContain('text-error');
  });

  it('shows no spinner, so a stopped call does not read as still running', () => {
    expect(render(component, 'cancelled').find('.animate-spin').exists()).toBe(false);
  });
});
