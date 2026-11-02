// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import FilesTransferRow from '../components/FilesTransferRow.vue';
import { shellI18n } from '../i18n';
import type { FilesTransferProgress } from '../../preload/shell-channels';
import { fakeShellApi, type FakeShellApi } from './fakes';

const MIB = 1024 * 1024;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

// transitions: run the real <Transition>s, whose leave hooks hand focus back, rather than test-utils' stubs
function mountRow(projectKey = 'home', transitions = false): { wrapper: VueWrapper; api: FakeShellApi } {
  const api = fakeShellApi();
  const wrapper = mount(FilesTransferRow, {
    props: { api, projectKey },
    global: { plugins: [shellI18n], ...(transitions ? { stubs: { transition: false } } : {}) },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return { wrapper, api };
}

const progress = (state: FilesTransferProgress['state'], filesDone: number, bytesDone: number, more: Partial<FilesTransferProgress> = {}): FilesTransferProgress => ({
  transferId: 7,
  projectKey: 'home',
  op: 'copy',
  state,
  filesDone,
  filesTotal: 40,
  bytesDone,
  bytesTotal: Math.round(9.8 * MIB),
  ...more,
});

const card = (wrapper: VueWrapper) => wrapper.find('[data-testid="files-transfer"]');
const status = (wrapper: VueWrapper) => wrapper.get('[data-testid="files-transfer-status"]').text();

async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await flushPromises();
}

describe('Files transfer row', () => {
  it('shows only once a transfer has run 150 ms, so a quick copy never flashes a row or an announcement', async () => {
    const { wrapper, api } = mountRow();
    api.filesTransferProgress(progress('running', 0, 0));
    await advance(149);
    expect(card(wrapper).exists()).toBe(false);
    api.filesTransferProgress(progress('done', 40, Math.round(9.8 * MIB)));
    await advance(1000);
    expect(card(wrapper).exists()).toBe(false);
    expect(status(wrapper)).toBe('');

    api.filesTransferProgress(progress('running', 0, 0, { transferId: 8 }));
    await advance(150);
    expect(card(wrapper).exists()).toBe(true);
  });

  it('reads items over the bar and bytes under it, and its progressbar carries both in its value text', async () => {
    const { wrapper, api } = mountRow();
    api.filesTransferProgress(progress('running', 0, 0));
    await advance(150);
    api.filesTransferProgress(progress('running', 12, Math.round(3.1 * MIB)));
    await flushPromises();
    expect(wrapper.get('[data-testid="files-transfer-label"]').text()).toBe('Copying 12 of 40');
    expect(wrapper.get('[data-testid="files-transfer-bytes"]').text()).toBe('3.1 MB of 9.8 MB');
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes('aria-valuetext')).toBe('12 of 40 items, 3.1 MB of 9.8 MB');
    expect(bar.attributes('aria-valuenow')).toBe('32');
    expect(bar.attributes('aria-labelledby')).toBe(wrapper.get('[data-testid="files-transfer-label"]').attributes('id'));
    expect((bar.element.firstElementChild as HTMLElement).style.transform).toBe(`scaleX(${Math.round(3.1 * MIB) / Math.round(9.8 * MIB)})`);
    api.filesTransferProgress(progress('running', 2, 0, { op: 'move', transferId: 7, bytesTotal: 0 }));
    await flushPromises();
    expect(wrapper.get('[data-testid="files-transfer-label"]').text()).toBe('Moving 2 of 40');
    expect(wrapper.find('[data-testid="files-transfer-bytes"]').exists()).toBe(false);
  });

  it('holds a check for 900 ms on success, then leaves', async () => {
    const { wrapper, api } = mountRow();
    api.filesTransferProgress(progress('running', 0, 0));
    await advance(150);
    api.filesTransferProgress(progress('done', 40, Math.round(9.8 * MIB)));
    await flushPromises();
    expect(card(wrapper).attributes('data-phase')).toBe('done');
    expect(wrapper.find('[data-testid="files-transfer-check"]').exists()).toBe(true);
    // the bytes line stays, so the row keeps its height under the check
    expect(wrapper.get('[data-testid="files-transfer-bytes"]').text()).toBe('9.8 MB of 9.8 MB');
    expect(wrapper.find('[data-testid="files-transfer-cancel"]').exists()).toBe(false);
    await advance(899);
    expect(card(wrapper).exists()).toBe(true);
    await advance(1);
    expect(card(wrapper).exists()).toBe(false);
  });

  it('announces the start and the finish only, never each file', async () => {
    const { wrapper, api } = mountRow();
    api.filesTransferProgress(progress('running', 0, 0));
    await advance(150);
    expect(wrapper.get('[data-testid="files-transfer-status"]').attributes('aria-live')).toBe('polite');
    expect(status(wrapper)).toBe('Copying 40 items');
    for (let done = 1; done < 40; done += 10) {
      api.filesTransferProgress(progress('running', done, done * 1000));
      await flushPromises();
      expect(status(wrapper)).toBe('Copying 40 items');
    }
    api.filesTransferProgress(progress('done', 40, Math.round(9.8 * MIB)));
    await flushPromises();
    expect(status(wrapper)).toBe('Copied 40 items');
  });

  it('cancels through main, keeps focus on a Cancel that waits, and hands focus back as the row leaves', async () => {
    const { wrapper, api } = mountRow('home', true);
    api.filesTransferProgress(progress('running', 3, 1000));
    await advance(150);
    const cancel = wrapper.get('[data-testid="files-transfer-cancel"]');
    expect(cancel.element.tagName).toBe('BUTTON');
    (cancel.element as HTMLElement).focus();
    await cancel.trigger('click');
    await cancel.trigger('click');
    expect(api.cancelFilesTransfer).toHaveBeenCalledOnce();
    expect(api.cancelFilesTransfer).toHaveBeenCalledWith(7);
    expect(cancel.attributes('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(cancel.element);
    api.filesTransferProgress(progress('cancelled', 3, 1000));
    await flushPromises();
    expect(wrapper.find('.t-banner-leave-active').exists()).toBe(true);
    expect(wrapper.emitted('releaseFocus')).toHaveLength(1);
    expect(status(wrapper)).toBe('Copy cancelled');
  });

  it('shows a transfer main is still planning as Preparing with the items found so far, over a sweeping bar with no value', async () => {
    const { wrapper, api } = mountRow();
    api.filesTransferProgress(progress('preparing', 0, 0, { filesTotal: 0, bytesTotal: 0 }));
    await advance(150);
    expect(card(wrapper).attributes('data-phase')).toBe('preparing');
    expect(wrapper.get('[data-testid="files-transfer-label"]').text()).toBe('Preparing (0 items)');
    expect(status(wrapper)).toBe('Preparing to copy');
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.classes()).toContain('d-sweep-bar');
    expect(bar.attributes('aria-valuenow')).toBeUndefined();
    expect(bar.attributes('aria-valuetext')).toBeUndefined();
    expect(bar.element.firstElementChild).toBeNull();
    expect(wrapper.find('[data-testid="files-transfer-bytes"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="files-transfer-cancel"]').exists()).toBe(true);

    api.filesTransferProgress(progress('preparing', 0, 0, { filesTotal: 1, bytesTotal: 3 * MIB }));
    await flushPromises();
    expect(wrapper.get('[data-testid="files-transfer-label"]').text()).toBe('Preparing (1 item)');
    expect(wrapper.get('[data-testid="files-transfer-bytes"]').text()).toBe('3 MB so far');
    api.filesTransferProgress(progress('preparing', 0, 0, { filesTotal: 120, bytesTotal: Math.round(4.2 * MIB) }));
    await flushPromises();
    expect(wrapper.get('[data-testid="files-transfer-label"]').text()).toBe('Preparing (120 items)');
    expect(status(wrapper)).toBe('Preparing to copy');

    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(wrapper.get('[data-testid="files-transfer-label"]').text()).toBe('Προετοιμασία (120 στοιχεία)');
    expect(wrapper.get('[data-testid="files-transfer-bytes"]').text()).toBe('4,2 MB μέχρι στιγμής');
  });

  it('flows from Preparing into the progress row once planning ends, telling the start again with the totals', async () => {
    const { wrapper, api } = mountRow();
    api.filesTransferProgress(progress('preparing', 0, 0, { op: 'download', filesTotal: 25 }));
    await advance(150);
    const shown = card(wrapper).element;
    api.filesTransferProgress(progress('running', 0, 0, { op: 'download' }));
    await flushPromises();
    // the same card carries on: no leave and enter between the phases
    expect(card(wrapper).element).toBe(shown);
    expect(card(wrapper).attributes('data-phase')).toBe('running');
    expect(wrapper.get('[data-testid="files-transfer-label"]').text()).toBe('Downloading 0 of 40');
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.classes()).not.toContain('d-sweep-bar');
    expect(bar.attributes('aria-valuenow')).toBe('0');
    expect(bar.attributes('aria-valuetext')).toBe('0 of 40 items, 0 bytes of 9.8 MB');
    expect(status(wrapper)).toBe('Downloading 40 items');
    api.filesTransferProgress(progress('running', 4, MIB, { op: 'download' }));
    await flushPromises();
    expect(status(wrapper)).toBe('Downloading 40 items');
    expect(wrapper.get('[data-testid="files-transfer-label"]').text()).toBe('Downloading 4 of 40');
  });

  it('cancels while preparing through the same call, and leaves at once when main ends it', async () => {
    const { wrapper, api } = mountRow('home', true);
    api.filesTransferProgress(progress('preparing', 0, 0, { op: 'move', filesTotal: 300 }));
    await advance(150);
    const cancel = wrapper.get('[data-testid="files-transfer-cancel"]');
    (cancel.element as HTMLElement).focus();
    await cancel.trigger('click');
    expect(api.cancelFilesTransfer).toHaveBeenCalledWith(7);
    expect(cancel.attributes('aria-disabled')).toBe('true');
    // a last planning update before main's end keeps the cancel under way
    api.filesTransferProgress(progress('preparing', 0, 0, { op: 'move', filesTotal: 320 }));
    await flushPromises();
    expect(cancel.attributes('aria-disabled')).toBe('true');
    expect(status(wrapper)).toBe('Preparing to move');
    api.filesTransferProgress(progress('cancelled', 0, 0, { op: 'move', filesTotal: 320 }));
    await flushPromises();
    expect(wrapper.find('.t-banner-leave-active').exists()).toBe(true);
    expect(wrapper.emitted('releaseFocus')).toHaveLength(1);
    expect(status(wrapper)).toBe('Move cancelled');
  });

  it('shows the shown project\'s transfers only, and one that waited in line once the row before it leaves', async () => {
    const { wrapper, api } = mountRow();
    api.filesTransferProgress(progress('running', 0, 0, { projectKey: 'other' }));
    await advance(500);
    expect(card(wrapper).exists()).toBe(false);
    await wrapper.setProps({ projectKey: 'other' });
    await advance(150);
    expect(card(wrapper).exists()).toBe(true);

    api.filesTransferProgress(progress('queued', 0, 0, { transferId: 9, projectKey: 'other', op: 'download' }));
    api.filesTransferProgress(progress('done', 40, 100, { projectKey: 'other' }));
    await advance(900);
    expect(card(wrapper).exists()).toBe(false);
    await advance(150);
    expect(card(wrapper).attributes('data-op')).toBe('download');
  });
});
