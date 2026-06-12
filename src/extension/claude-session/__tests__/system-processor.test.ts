import { describe, it, expect, vi } from 'vitest';
import { createSystemProcessors } from '../streaming-manager/processors/system-processor';
import type { ProcessorContext, ProcessorDependencies } from '../streaming-manager/types';

function makeContext() {
  const onMessage = vi.fn();
  const ctx = {
    state: {},
    deps: { callbacks: { onMessage } },
    flushPendingAssistant: () => {},
  } as unknown as ProcessorContext;
  return { ctx, onMessage };
}

function getProcessor() {
  const processors = createSystemProcessors({} as ProcessorDependencies);
  const processor = processors['system:model_fallback'];
  expect(processor).toBeTypeOf('function');
  return processor!;
}

const WIRE_MESSAGE: Record<string, unknown> = {
  type: 'system',
  subtype: 'model_fallback',
  trigger: 'overloaded',
  original_model: 'claude-opus-4-8',
  fallback_model: 'claude-sonnet-4-6',
  content: 'Model fell back due to overload',
  uuid: 'wire-uuid-1',
  session_id: 's1',
};

describe('system:model_fallback live wire contract', () => {
  it('maps the snake_case live wire shape to a modelFallback message', () => {
    const { ctx, onMessage } = makeContext();

    void getProcessor()(WIRE_MESSAGE, ctx);

    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload).toMatchObject({
      type: 'modelFallback',
      id: 'wire-uuid-1',
      fromModel: 'claude-opus-4-8',
      toModel: 'claude-sonnet-4-6',
      trigger: 'overloaded',
    });
    expect(typeof payload.timestamp).toBe('number');
  });

  it('passes unknown trigger values through as raw strings', () => {
    const { ctx, onMessage } = makeContext();

    void getProcessor()({ ...WIRE_MESSAGE, trigger: 'brand_new_trigger' }, ctx);

    expect(onMessage.mock.calls[0][0].trigger).toBe('brand_new_trigger');
  });

  it('generates unique synthetic ids when uuid is missing', () => {
    const { ctx, onMessage } = makeContext();
    const processor = getProcessor();
    const malformed = { ...WIRE_MESSAGE };
    delete malformed['uuid'];

    void processor(malformed, ctx);
    void processor(malformed, ctx);

    const first = onMessage.mock.calls[0][0].id as string;
    const second = onMessage.mock.calls[1][0].id as string;
    expect(first).toMatch(/^fallback-/);
    expect(second).toMatch(/^fallback-/);
    expect(first).not.toBe(second);
  });
});
