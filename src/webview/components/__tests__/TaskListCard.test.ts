// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import TaskListCard from '../TaskListCard.vue';
import type { Task } from '@shared/types/subagents';
import { i18n } from '@/i18n';

enableAutoUnmount(afterEach);

afterEach(() => {
  i18n.global.locale.value = 'en';
});

const task = (id: string, status: Task['status']): Task => ({ id, subject: `Task ${id}`, status });

describe('the task list progress tooltip', () => {
  it('is one translated sentence, so each language orders its own words', () => {
    i18n.global.locale.value = 'el';
    const wrapper = mount(TaskListCard, {
      props: { tasks: [task('1', 'completed'), task('2', 'pending'), task('3', 'in_progress')] },
      global: { plugins: [i18n] },
    });

    expect(wrapper.get('[data-testid="task-list-progress"]').attributes('title')).toBe('Ολοκληρωμένες: 1, ανοιχτές: 2');
  });
});

describe('the blocked-by chip', () => {
  const blocked = (blockedBy: string[]): string => {
    i18n.global.locale.value = 'el';
    const wrapper = mount(TaskListCard, {
      props: { tasks: [{ ...task('4', 'pending'), blockedBy }] },
      global: { plugins: [i18n] },
    });
    return wrapper.get('[data-testid="task-blocked-by"]').text();
  };

  it('is one Greek sentence whose article agrees with a single blocking task', () => {
    expect(blocked(['2'])).toBe('μπλοκάρεται από την εργασία #2');
  });

  it('is one Greek sentence that lists several blocking tasks as Greek words join them', () => {
    expect(blocked(['1', '2', '3'])).toBe('μπλοκάρεται από τις εργασίες #1, #2 και #3');
  });
});
