// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { closeWhenSettingsBusy, provideSettingsBusy } from '../settings-view';

enableAutoUnmount(afterEach);

// The settings page tests also move focus out of the closing layer, which in happy-dom dismisses it too; this checks the close alone.
describe('a layer opened from the settings page', () => {
  it('closes when the page turns busy, and stays closed when the page is no longer', async () => {
    const busy = ref(false);
    const open = ref(true);
    const Layer = defineComponent({
      setup() {
        closeWhenSettingsBusy(open);
        return () => null;
      },
    });
    mount(defineComponent({
      setup() {
        provideSettingsBusy(() => busy.value);
        return () => h(Layer);
      },
    }));
    busy.value = true;
    await nextTick();
    expect(open.value).toBe(false);
    busy.value = false;
    await nextTick();
    expect(open.value).toBe(false);
  });
});
