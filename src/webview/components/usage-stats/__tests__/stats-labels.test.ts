// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import type { BridgeHostName } from '@shared/damocles-bridge';

type Names = Readonly<Record<string, BridgeHostName>>;

// A local chat's page whose init has not carried this computer's host names yet.
const page = vi.hoisted(() => ({ listener: undefined as ((names: Names) => void) | undefined }));

window.damoclesBridge = {
  postMessage: () => undefined,
  onMessage: () => () => undefined,
  getState: () => undefined,
  setState: () => undefined,
  getHost: () => undefined,
  onHost: () => () => undefined,
  getHostNames: () => undefined,
  onHostNames: (listener) => {
    page.listener = listener;
    return () => undefined;
  },
  getOffline: () => undefined,
  hostAction: () => undefined,
  getConnection: () => undefined,
  onConnection: () => () => undefined,
  allowYolo: async () => false,
  queueAction: () => undefined,
};

const { useStatsLabels } = await import('../stats-labels');
const { i18n } = await import('@/i18n');

describe('the /stats host label', () => {
  it('names no host before main sends the names, and a forgotten host only once it has', async () => {
    let labels!: ReturnType<typeof useStatsLabels>;
    mount(defineComponent({
      setup() {
        labels = useStatsLabels();
        return () => null;
      },
    }), { global: { plugins: [i18n] } });

    expect(labels.host('h1')).toBeUndefined();
    expect(labels.host('h9')).toBeUndefined();
    expect(labels.projectOnHost('remote:h1|/srv/api', '/srv/api', 'h1')).toBe('api');

    page.listener!({ h1: { name: 'prod-1', color: 'danger' } });
    expect(labels.host('h1')).toEqual({ name: 'prod-1', color: 'danger' });
    expect(labels.host('h9')).toEqual({ name: 'Removed host' });
    expect(labels.host(undefined)).toBeUndefined();
  });
});
