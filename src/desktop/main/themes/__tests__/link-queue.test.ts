import { describe, expect, it } from 'vitest';
import { MAX_WAITING_LINKS, ThemeLinkQueue, type LinkQueueDeps } from '../link-queue';

interface Preview {
  readonly installId: string;
  readonly url: string;
}

// a macrotask lets every settled prepare run its callbacks
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(options: { failFor?: ReadonlySet<string>; holdPrepare?: boolean } = {}) {
  const prepared: string[] = [];
  const shown: Preview[] = [];
  const cancelled: string[] = [];
  const refused: string[] = [];
  const failed: string[] = [];
  const pending: Array<() => void> = [];
  let next = 0;
  const deps: LinkQueueDeps<Preview> = {
    prepare: (url) => {
      prepared.push(url);
      const installId = `install-${++next}`;
      if (options.failFor?.has(url)) return Promise.reject(new Error('download refused'));
      if (options.holdPrepare) return new Promise((resolve) => pending.push(() => resolve({ installId, url })));
      return Promise.resolve({ installId, url });
    },
    show: (preview) => shown.push(preview),
    cancel: async (installId) => {
      cancelled.push(installId);
    },
    refused: (url) => refused.push(url),
    failed: (url) => failed.push(url),
    log: () => undefined,
  };
  return { queue: new ThemeLinkQueue(deps), prepared, shown, cancelled, refused, failed, pending };
}

const url = (n: number): string => `https://themes.example.com/${n}.damocles-theme`;

describe('theme link queue', () => {
  it('opens one card for a storm, keeps three waiting and refuses the rest with one notice', async () => {
    const { queue, prepared, shown, refused } = harness();
    queue.markReady();
    const offers = Array.from({ length: 10 }, (_, n) => queue.offer(url(n)));
    expect(MAX_WAITING_LINKS).toBe(3);
    expect(offers).toEqual(['opening', 'waiting', 'waiting', 'waiting', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused']);
    await settle();
    // only the first link reached core; the waiting ones are not even downloaded
    expect(prepared).toEqual([url(0)]);
    expect(shown.map((preview) => preview.url)).toEqual([url(0)]);
    // one notice for the storm, not one per link
    expect(refused).toEqual([url(4)]);
  });

  it('drops a repeat of the shown or a waiting URL', async () => {
    const { queue, prepared, refused } = harness();
    queue.markReady();
    expect(queue.offer(url(0))).toBe('opening');
    expect(queue.offer(url(0))).toBe('dropped');
    expect(queue.offer(url(1))).toBe('waiting');
    expect(queue.offer(url(1))).toBe('dropped');
    await settle();
    expect(queue.offer(url(0))).toBe('dropped');
    expect(prepared).toEqual([url(0)]);
    expect(refused).toEqual([]);
  });

  it('installs nothing on its own: a link only prepares and shows the card, and nothing advances until it closes', async () => {
    const { queue, prepared, shown, cancelled } = harness();
    queue.markReady();
    queue.offer(url(0));
    queue.offer(url(1));
    await settle();
    await settle();
    // core is reached only through prepare and cancel: the deps carry no commit, so the card's Install is the only way in
    expect(shown.map((preview) => preview.installId)).toEqual(['install-1']);
    expect(prepared).toEqual([url(0)]);
    expect(cancelled).toEqual([]);
    expect(queue.isOpen('install-1')).toBe(true);
  });

  it('opens the next waiting link once the card closes, and frees a place for new links', async () => {
    const { queue, shown, refused } = harness();
    queue.markReady();
    for (let n = 0; n < 5; n++) queue.offer(url(n));
    await settle();
    expect(refused).toEqual([url(4)]);
    // a stale or foreign id changes nothing
    expect(queue.closed('install-9')).toBe(false);
    expect(queue.closed(shown[0]!.installId)).toBe(true);
    await settle();
    expect(shown.map((preview) => preview.url)).toEqual([url(0), url(1)]);
    // a place freed, and the notice may show again for the next storm
    expect(queue.offer(url(5))).toBe('waiting');
    expect(queue.offer(url(6))).toBe('refused');
    expect(refused).toEqual([url(4), url(6)]);
    for (const expected of [url(2), url(3), url(5)]) {
      expect(queue.closed(shown.at(-1)!.installId)).toBe(true);
      await settle();
      expect(shown.at(-1)!.url).toBe(expected);
    }
    expect(queue.closed(shown.at(-1)!.installId)).toBe(true);
    expect(queue.openInstall()).toBeUndefined();
  });

  it('holds a link that launched the app until the window and core are ready', async () => {
    const { queue, prepared, shown } = harness();
    expect(queue.offer(url(0))).toBe('waiting');
    expect(queue.offer(url(1))).toBe('waiting');
    await settle();
    expect(prepared).toEqual([]);
    expect(shown).toEqual([]);
    queue.markReady();
    await settle();
    expect(prepared).toEqual([url(0)]);
    expect(shown.map((preview) => preview.url)).toEqual([url(0)]);
    // a second ready changes nothing
    queue.markReady();
    await settle();
    expect(prepared).toEqual([url(0)]);
  });

  it('refuses past three waiting before ready too', () => {
    const { queue, refused } = harness();
    expect([0, 1, 2, 3].map((n) => queue.offer(url(n)))).toEqual(['waiting', 'waiting', 'waiting', 'refused']);
    expect(refused).toEqual([url(3)]);
  });

  it('tells the user of a link whose preview failed and opens the next one', async () => {
    const { queue, shown, failed } = harness({ failFor: new Set([url(0)]) });
    queue.markReady();
    queue.offer(url(0));
    queue.offer(url(1));
    await settle();
    await settle();
    expect(failed).toEqual([url(0)]);
    expect(shown.map((preview) => preview.url)).toEqual([url(1)]);
  });

  it('frees the slot and tells the user when showing the card throws, with nothing left unhandled', async () => {
    const failed: string[] = [];
    const cancelled: string[] = [];
    const queue = new ThemeLinkQueue<Preview>({
      prepare: async (target) => ({ installId: `for-${target.length}`, url: target }),
      show: () => {
        throw new Error('the overlay is gone');
      },
      cancel: async (installId) => {
        cancelled.push(installId);
      },
      refused: () => undefined,
      failed: (target) => failed.push(target),
      log: () => undefined,
    });
    queue.markReady();
    queue.offer(url(0));
    await settle();
    expect(failed).toEqual([url(0)]);
    expect(cancelled).toEqual([`for-${url(0).length}`]);
    expect(queue.openInstall()).toBeUndefined();
    expect(queue.offer(url(1))).toBe('opening');
  });

  it('shares the one card with Settings: a claim waits for no link, and links wait behind it', async () => {
    const { queue, shown, prepared } = harness();
    queue.markReady();
    const claim = queue.claim(url(7));
    expect(claim).toBeDefined();
    // a second Settings install while one prepares is refused
    expect(queue.claim()).toBeUndefined();
    // the Settings card's own URL as a link is a repeat
    expect(queue.offer(url(7))).toBe('dropped');
    expect(queue.offer(url(0))).toBe('waiting');
    claim!.opened('settings-1');
    expect(queue.isOpen('settings-1')).toBe(true);
    await settle();
    expect(prepared).toEqual([]);
    expect(queue.closed('settings-1')).toBe(true);
    await settle();
    expect(shown.map((preview) => preview.url)).toEqual([url(0)]);
  });

  it('frees the slot when a Settings pick is cancelled or its prepare failed', async () => {
    const { queue, shown } = harness();
    queue.markReady();
    const claim = queue.claim();
    queue.offer(url(0));
    claim!.release();
    await settle();
    expect(shown.map((preview) => preview.url)).toEqual([url(0)]);
    // a late release of a finished claim changes nothing
    claim!.release();
    expect(queue.isOpen(shown[0]!.installId)).toBe(true);
  });

  it('cancels in core an install whose card can no longer show', async () => {
    const { queue, cancelled, shown, pending } = harness({ holdPrepare: true });
    queue.markReady();
    queue.offer(url(0));
    queue.offer(url(1));
    expect(queue.dispose()).toBeUndefined();
    pending[0]!();
    await settle();
    expect(shown).toEqual([]);
    expect(cancelled).toEqual(['install-1']);
    expect(queue.offer(url(2))).toBe('dropped');
  });

  it('hands back the open card at dispose so main cancels it', async () => {
    const { queue } = harness();
    queue.markReady();
    queue.offer(url(0));
    queue.offer(url(1));
    await settle();
    expect(queue.dispose()).toBe('install-1');
    expect(queue.openInstall()).toBeUndefined();
  });
});
