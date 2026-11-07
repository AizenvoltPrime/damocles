// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ImageThumbnailStrip from '../ImageThumbnailStrip.vue';
import { applyLocale, i18n } from '@/i18n';
import type { ImageAttachment } from '@/composables/useImageAttachments';

const SCREENSHOT: ImageAttachment = { id: 'img-1', dataUrl: 'data:image/png;base64,CCCC', base64Data: 'CCCC', mediaType: 'image/png', width: 1280, height: 900, origin: 'designPreview' };

afterEach(async () => {
  await applyLocale('en');
});

describe('a preview screenshot in the composer', () => {
  it('is named by its origin in the language shown now, not the one it was captured in', async () => {
    const wrapper = mount(ImageThumbnailStrip, { props: { attachments: [SCREENSHOT] }, global: { plugins: [i18n], stubs: { ImageLightbox: true } } });
    const remove = () => wrapper.get('[data-testid="composer-image-attachment"] button[aria-label]');
    expect(wrapper.text()).toContain('Preview screenshot');
    expect(remove().attributes('aria-label')).toContain('Preview screenshot');

    await applyLocale('el');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Στιγμιότυπο προεπισκόπησης');
    expect(remove().attributes('aria-label')).toContain('Στιγμιότυπο προεπισκόπησης');
    wrapper.unmount();
  });
});
