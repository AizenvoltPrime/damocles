// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { OFFLINE_GRACE_MS, RECONNECTED_MS } from '@shared/host-connection';
import HostStatusDot from '../components/HostStatusDot.vue';
import LatencySparkline from '../overlay/components/LatencySparkline.vue';
import { hostStateLabel } from '../host-label';
import { shellI18n } from '../i18n';

const t = (key: string, params?: Record<string, unknown>): string => shellI18n.global.t(key, params ?? {});
const mounted: VueWrapper[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(2_000_000);
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

function dot(props: InstanceType<typeof HostStatusDot>['$props']): VueWrapper {
  const wrapper = mount(HostStatusDot, { props });
  mounted.push(wrapper);
  return wrapper;
}

describe('host latency in the shell', () => {
  it('names a connected host with its latency, and a slow one as slow', () => {
    expect(hostStateLabel({ name: 'prod-1', connection: 'connected', latency: { latencyMs: 38.4, slow: false, history: [38], measurements: 1 } }, t)).toBe('prod-1 · 38 ms');
    expect(hostStateLabel({ name: 'prod-1', connection: 'connected', latency: { latencyMs: 620, slow: true, history: [40, 620], measurements: 2 } }, t)).toBe('Slow connection to prod-1 (620 ms)');
    expect(hostStateLabel({ name: 'prod-1', connection: 'connected' }, t)).toBe('prod-1, Connected');
    expect(hostStateLabel({ name: 'prod-1', connection: 'offline', reconnect: { phase: 'failed', since: 1, code: 'hostRemoved' } }, t)).toBe("prod-1, Couldn't reconnect");
  });

  it('keeps the green center and adds a warning ring while slow, read out as slow', () => {
    const slow = dot({ connection: 'connected', slow: true, label: 'Slow connection to prod-1 (620 ms)' });
    const root = slow.get('[data-testid="host-status-dot"]');
    expect(root.attributes()).toMatchObject({ 'data-shape': 'slow', 'aria-label': 'Slow connection to prod-1 (620 ms)', role: 'img' });
    expect(root.classes()).toContain('text-(--d-success)');
    const circles = slow.findAll('circle');
    expect(circles.map((circle) => circle.attributes('r'))).toEqual(['2.5', '4.2']);
    expect(circles[1]!.classes()).toContain('stroke-(--d-warning)');
    expect(dot({ connection: 'connected', label: 'prod-1 · 38 ms' }).findAll('circle').map((circle) => circle.attributes('r'))).toEqual(['4']);
  });

  it('changes nothing for a drop inside the grace, pulses amber after it, and flashes green once the host is back', async () => {
    const since = Date.now();
    const wrapper = dot({ connection: 'offline', reconnect: { phase: 'running', since }, label: 'prod-1' });
    expect(wrapper.get('[data-testid="host-status-dot"]').attributes('data-shape')).toBe('connected');
    vi.advanceTimersByTime(OFFLINE_GRACE_MS);
    await nextTick();
    const root = wrapper.get('[data-testid="host-status-dot"]');
    expect(root.attributes('data-shape')).toBe('connecting');
    expect(root.classes()).toEqual(expect.arrayContaining(['d-pulsing', 'text-(--d-warning)', 'transition-colors', 'duration-200']));
    await wrapper.setProps({ connection: 'connected', reconnect: undefined });
    expect(wrapper.get('[data-testid="host-status-flash"]').classes()).toContain('d-flash-once');
    vi.advanceTimersByTime(RECONNECTED_MS);
    await nextTick();
    expect(wrapper.find('[data-testid="host-status-flash"]').exists()).toBe(false);
  });

  it('draws the last measurements as a hidden line that draws itself again for each new one, in the warning tone while slow', async () => {
    const wrapper = mount(LatencySparkline, { props: { history: [38, 40, 36], slow: false, measurements: 3 } });
    mounted.push(wrapper);
    const svg = wrapper.get('[data-testid="host-latency-sparkline"]');
    expect(svg.attributes('aria-hidden')).toBe('true');
    expect(svg.classes()).toEqual(expect.arrayContaining(['h-5', 'w-19']));
    const first = wrapper.get('path');
    expect(first.classes()).toEqual(expect.arrayContaining(['d-draw', 'stroke-(--d-accent)']));
    expect(first.attributes('d')?.split('L')).toHaveLength(3);
    await wrapper.setProps({ history: [38, 40, 36, 640], slow: true, measurements: 4 });
    const next = wrapper.get('path');
    expect(next.element).not.toBe(first.element);
    expect(next.classes()).toContain('stroke-(--d-warning)');
    // a reading that leaves a full history unchanged still draws again
    await wrapper.setProps({ measurements: 5 });
    expect(wrapper.get('path').element).not.toBe(next.element);
    expect(wrapper.get('path').classes()).toContain('d-draw');
  });
});
