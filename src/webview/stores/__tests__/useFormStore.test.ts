import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useFormStore } from '../useFormStore';
import type { PendingFormInfo } from '../../../shared/types/forms';

const info = (id: string): PendingFormInfo => ({
  toolUseId: id,
  form: { fields: [{ id: 'a', label: 'A', type: 'text', selector: '#a' }] },
});

describe('useFormStore queue', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('shows the first form and queues concurrent ones FIFO', () => {
    const s = useFormStore();
    s.setForm(info('t1'));
    s.setForm(info('t2'));
    s.setForm(info('t3'));
    expect(s.pendingForm?.toolUseId).toBe('t1');
    expect(s.queue.map((q) => q.toolUseId)).toEqual(['t2', 't3']);
  });

  it('advances to the next queued form on clear, in order', () => {
    const s = useFormStore();
    s.setForm(info('t1'));
    s.setForm(info('t2'));
    s.clearForm();
    expect(s.pendingForm?.toolUseId).toBe('t2');
    expect(s.queue).toHaveLength(0);
    s.clearForm();
    expect(s.pendingForm).toBeNull();
  });

  it('clear with an empty queue nulls the pending form', () => {
    const s = useFormStore();
    s.setForm(info('t1'));
    s.clearForm();
    expect(s.pendingForm).toBeNull();
  });

  it('$reset clears both the pending form and the queue', () => {
    const s = useFormStore();
    s.setForm(info('t1'));
    s.setForm(info('t2'));
    s.$reset();
    expect(s.pendingForm).toBeNull();
    expect(s.queue).toHaveLength(0);
  });
});
