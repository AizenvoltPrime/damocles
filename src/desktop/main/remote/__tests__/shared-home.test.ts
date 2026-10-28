import { describe, expect, it, vi } from 'vitest';
import { INVALID } from '../../../core-protocol/schema';
import { CLIENT_TO_CONTROL } from '../../../daemon/control-messages';
import { createSharedHomes, SHARED_HOME_FEATURE, type SharedHomeConnection } from '../shared-home';

const KEY = 'ssh+h1';

function homes() {
  const notified: Array<[string, readonly string[]]> = [];
  const changed: string[] = [];
  const sharedHomes = createSharedHomes({
    notify: (authorityKey, hosts) => notified.push([authorityKey, hosts]),
    changed: (authorityKey) => changed.push(authorityKey),
    log: () => undefined,
  });
  return { sharedHomes, notified, changed };
}

function connection(hosts: readonly string[], features: readonly string[] = [SHARED_HOME_FEATURE]): SharedHomeConnection & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => ({ hosts }));
  return { features, control: { request } as unknown as SharedHomeConnection['control'], request };
}

const answered = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('another machine running Damocles in the host\'s home', () => {
  it('asks each connection once, notifies once, and shows the card\'s notice for that connection only', async () => {
    const { sharedHomes, notified, changed } = homes();
    const first = connection(['lab-03', 'lab-04']);
    sharedHomes.ask(KEY, first);
    sharedHomes.ask(KEY, first);
    await answered();
    expect(first.request).toHaveBeenCalledTimes(1);
    expect(first.request).toHaveBeenCalledWith('sharedHome', {});
    expect(notified).toEqual([[KEY, ['lab-03', 'lab-04']]]);
    expect(changed).toEqual([KEY]);
    expect(sharedHomes.notice(KEY, first)).toEqual({ code: 'sharedHome', params: { hosts: 'lab-03\nlab-04' } });
    expect(sharedHomes.notice(KEY, {})).toBeUndefined();
    expect(sharedHomes.notice(KEY, undefined)).toBeUndefined();

    const second = connection(['lab-03']);
    sharedHomes.ask(KEY, second);
    await answered();
    expect(notified).toEqual([[KEY, ['lab-03', 'lab-04']], [KEY, ['lab-03']]]);
    expect(sharedHomes.notice(KEY, first)).toBeUndefined();
    expect(sharedHomes.notice(KEY, second)).toEqual({ code: 'sharedHome', params: { hosts: 'lab-03' } });
  });

  it('asks nothing of a daemon without the feature', async () => {
    const { sharedHomes, notified } = homes();
    const old = connection(['lab-03'], []);
    sharedHomes.ask(KEY, old);
    await answered();
    expect(old.request).not.toHaveBeenCalled();
    expect(notified).toEqual([]);
    expect(sharedHomes.notice(KEY, old)).toBeUndefined();
  });

  it('tells nothing when no other machine uses the home', async () => {
    const { sharedHomes, notified, changed } = homes();
    const alone = connection([]);
    sharedHomes.ask(KEY, alone);
    await answered();
    expect(alone.request).toHaveBeenCalledTimes(1);
    expect(notified).toEqual([]);
    expect(changed).toEqual([]);
    expect(sharedHomes.notice(KEY, alone)).toBeUndefined();
  });

  it('takes from the wire only hostnames of DNS characters within their bound, at most 16 of them', () => {
    const parse = CLIENT_TO_CONTROL.requests.sharedHome.result;
    expect(parse({ hosts: ['lab-03', 'LAB_04.example.org'] })).toEqual({ hosts: ['lab-03', 'LAB_04.example.org'] });
    for (const bad of ['', 'lab 03', 'lab-03\nlab-04', '-lab', '<b>lab</b>', 'lab\u202E03', 'x'.repeat(254)]) expect(parse({ hosts: [bad] })).toBe(INVALID);
    expect(parse({ hosts: Array.from({ length: 17 }, (_, i) => `lab-${i}`) })).toBe(INVALID);
  });

  it('drops an answer that arrives after a newer connection replaced the one asked', async () => {
    const { sharedHomes, notified } = homes();
    let answer!: (value: { hosts: readonly string[] }) => void;
    const slow = connection([]);
    slow.request.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    sharedHomes.ask(KEY, slow);
    const fresh = connection([]);
    sharedHomes.ask(KEY, fresh);
    answer({ hosts: ['lab-03'] });
    await answered();
    expect(notified).toEqual([]);
    expect(sharedHomes.notice(KEY, slow)).toBeUndefined();
  });
});
