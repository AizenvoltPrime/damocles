// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ErrorMessageText from '../ErrorMessageText.vue';
import { i18n } from '@/i18n';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => posted.push(m),
    onMessage: () => () => {},
    getState: () => undefined,
    setState: () => {},
  }),
}));

const USAGE_URL = 'https://chatgpt.com/settings/usage';
// The shape pi gives a ChatGPT usage-limit error: provider error, newline, then the appended URL.
const USAGE_LIMIT_ERROR =
  `OpenAI API error (429): {"error":{"code":"subscription_sharing_usage_limit_exceeded"}}\nCheck your ChatGPT usage: ${USAGE_URL}`;

function mountText(text: string) {
  return mount(ErrorMessageText, { props: { text }, global: { plugins: [i18n] } });
}

beforeEach(() => {
  posted.length = 0;
});

describe('ErrorMessageText', () => {
  it('renders the ChatGPT usage URL as a button that opens it externally, with no retry', async () => {
    const wrapper = mountText(USAGE_LIMIT_ERROR);

    expect(wrapper.text()).toContain('subscription_sharing_usage_limit_exceeded');
    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.text()).toBe(USAGE_URL);

    await buttons[0]!.trigger('click');
    expect(posted).toEqual([{ type: 'openExternalUrl', url: USAGE_URL }]);
  });

  it('keeps the error text around the link intact', () => {
    const wrapper = mountText(USAGE_LIMIT_ERROR);
    expect(wrapper.text().replace(/\s+/g, ' ')).toBe(USAGE_LIMIT_ERROR.replace(/\s+/g, ' '));
  });

  it('links nothing in an error without the usage URL', () => {
    const wrapper = mountText('OpenAI API error (500): see https://status.openai.com for details');
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.text()).toBe('OpenAI API error (500): see https://status.openai.com for details');
  });

  it('leaves a longer URL that starts with the usage URL as plain text', () => {
    const text = `see ${USAGE_URL}/../../evil?x=1`;
    const wrapper = mountText(text);
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.text()).toBe(text);
  });

  it('leaves a URL that carries the usage URL inside it as plain text', () => {
    const text = `see https://evil.example/?u=${USAGE_URL}`;
    const wrapper = mountText(text);
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.text()).toBe(text);
  });

  it('links the usage URL at the end of a sentence', async () => {
    const wrapper = mountText(`Limit reached, check ${USAGE_URL}.`);
    const button = wrapper.get('button');
    expect(button.text()).toBe(USAGE_URL);
    expect(wrapper.text()).toMatch(/\.$/);
  });
});
