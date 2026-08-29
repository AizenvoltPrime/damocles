// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import LiveOutputPane from '../LiveOutputPane.vue';
import { i18n } from '@/i18n';

/**
 * The one component in the group that renders bytes a model or a shell command chose.
 *
 * Every other suite stubs it out, so nothing anywhere proved that streamed output reaches the DOM as
 * text rather than as markup, that a reader scrolled up keeps their place, or that the escape
 * sequences a coloured command emits are gone before the tail slice can cut one in half.
 */

const TAIL_LINE_LIMIT = 400;
const TAIL_CHAR_LIMIT = 20_000;

const mounted: VueWrapper[] = [];

function open(output: string, truncated = false): VueWrapper {
  const wrapper = mount(LiveOutputPane, {
    props: { output, truncated, heightClass: 'h-40' },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function pane(wrapper: VueWrapper): HTMLPreElement {
  return wrapper.get('pre').element as HTMLPreElement;
}

/**
 * happy-dom reports every layout box as zero, so the tail-follow branch is unreachable without these.
 *
 * The watcher decides from `scrollHeight`, `scrollTop` and `clientHeight` read off the live element,
 * which is exactly the trio a headless DOM does not compute. Faking them on the prototype is what lets
 * the "scrolled up" and "sitting at the tail" cases differ at all.
 */
function fakeLayout(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

describe('untrusted bytes reaching the DOM', () => {
  it('renders an injected tag as text and never as markup', () => {
    const wrapper = open('<img src=x onerror=alert(1)>');

    expect(wrapper.html()).not.toContain('<img');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(pane(wrapper).textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('renders a script payload as text', () => {
    const payload = `<script>alert(1)</${'script'}>`;
    const wrapper = open(payload);

    expect(wrapper.find('script').exists()).toBe(false);
    expect(pane(wrapper).textContent).toBe(payload);
  });

  it('keeps ordinary output exactly as it arrived', () => {
    const wrapper = open('PASS src/a.test.ts\nPASS src/b.test.ts');

    expect(pane(wrapper).textContent).toBe('PASS src/a.test.ts\nPASS src/b.test.ts');
  });
});

describe('the empty state', () => {
  it('shows the waiting text before the first frame', () => {
    const wrapper = open('');

    expect(wrapper.find('pre').exists()).toBe(false);
    expect(wrapper.text()).toContain('Waiting for output');
  });

  it('gives way to the output pane on the first frame', async () => {
    const wrapper = open('');

    await wrapper.setProps({ output: 'first line' });

    expect(wrapper.find('pre').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Waiting for output');
  });
});

describe('the escape sequences a coloured command emits', () => {
  it('strips CSI colour codes rather than printing them', () => {
    const wrapper = open('\u001B[31mFAIL\u001B[0m src/a.test.ts');

    expect(pane(wrapper).textContent).toBe('FAIL src/a.test.ts');
  });

  it('strips cursor movement and erase-line codes', () => {
    const wrapper = open('\u001B[2K\u001B[1Gbuilding\u001B[?25l');

    expect(pane(wrapper).textContent).toBe('building');
  });

  it('collapses a carriage-return progress bar to its final state', () => {
    const wrapper = open('  0%\r 50%\r100% done\nnext line');

    expect(pane(wrapper).textContent).toBe('100% done\nnext line');
  });

  it('leaves CRLF output as plain lines', () => {
    const wrapper = open('one\r\ntwo\r\n');

    expect(pane(wrapper).textContent).toBe('one\ntwo\n');
  });

  it('strips before it slices, so a cut cannot leave half a sequence in the DOM', () => {
    // Sized so an unstripped tail window opens one character into the escape: the ESC falls outside
    // the window and `[31m` falls inside it, which is exactly the byte pattern that would reach the
    // DOM as visible text if the slice ran first.
    const head = 'x'.repeat(10);
    const escape = '\u001B[31m';
    const tail = 'y'.repeat(TAIL_CHAR_LIMIT - escape.length + 1);
    const raw = `${head}${escape}${tail}`;
    expect(raw.length - TAIL_CHAR_LIMIT).toBe(head.length + 1);

    const wrapper = open(raw);

    const text = pane(wrapper).textContent ?? '';
    expect(text).not.toContain('[31m');
    expect(text).not.toContain('\u001B');
    expect(text.endsWith('y')).toBe(true);
  });
});

describe('the tail cap', () => {
  it('renders only the tail window of a snapshot far past the line limit', () => {
    const lines = Array.from({ length: TAIL_LINE_LIMIT + 50 }, (_, i) => `line ${i}`);
    const wrapper = open(lines.join('\n'));

    const text = pane(wrapper).textContent ?? '';
    expect(text.split('\n')).toHaveLength(TAIL_LINE_LIMIT);
    expect(text.startsWith('line 50\n')).toBe(true);
    expect(text.endsWith(`line ${TAIL_LINE_LIMIT + 49}`)).toBe(true);
  });

  it('caps a single enormous line by characters', () => {
    const wrapper = open(`head${'y'.repeat(TAIL_CHAR_LIMIT)}`);

    const text = pane(wrapper).textContent ?? '';
    expect(text).toHaveLength(TAIL_CHAR_LIMIT);
    expect(text).not.toContain('head');
  });

  it('leaves a snapshot inside the window untouched', () => {
    const lines = Array.from({ length: TAIL_LINE_LIMIT }, (_, i) => `line ${i}`);
    const wrapper = open(lines.join('\n'));

    expect(pane(wrapper).textContent).toBe(lines.join('\n'));
  });
});

describe('the truncation hint', () => {
  it('appears when the producer says it dropped output', () => {
    const wrapper = open('tail of the log', true);

    expect(wrapper.text()).toContain('Earlier output dropped');
  });

  it('appears when the pane itself dropped the head, even with the producer flag clear', () => {
    const lines = Array.from({ length: TAIL_LINE_LIMIT + 1 }, (_, i) => `line ${i}`);
    const wrapper = open(lines.join('\n'), false);

    expect(wrapper.text()).toContain('Earlier output dropped');
  });

  it('stays away when nothing was dropped', () => {
    const wrapper = open('short', false);

    expect(wrapper.text()).not.toContain('Earlier output dropped');
  });
});

describe('the reader\'s scroll position', () => {
  it('is left alone when the reader has scrolled up', async () => {
    const wrapper = open('first frame');
    const el = pane(wrapper);
    fakeLayout(el, 1000, 100);
    el.scrollTop = 200;

    await wrapper.setProps({ output: 'first frame\nsecond frame' });
    await wrapper.vm.$nextTick();

    expect(el.scrollTop).toBe(200);
  });

  it('follows the tail when the reader is already sitting at the bottom', async () => {
    const wrapper = open('first frame');
    const el = pane(wrapper);
    fakeLayout(el, 1000, 100);
    el.scrollTop = 900;

    await wrapper.setProps({ output: 'first frame\nsecond frame' });
    await wrapper.vm.$nextTick();

    expect(el.scrollTop).toBe(1000);
  });

  it('jumps to the tail when it mounts over output that is already running', () => {
    // Opening the overlay over a long-running command mounts a pane whose output is already there.
    Object.defineProperty(HTMLPreElement.prototype, 'scrollHeight', { configurable: true, value: 4321 });
    try {
      const wrapper = open('a\nb\nc');

      expect(pane(wrapper).scrollTop).toBe(4321);
    } finally {
      Reflect.deleteProperty(HTMLPreElement.prototype, 'scrollHeight');
    }
  });
});

describe('the live region', () => {
  it('names the scrollable output region so focus lands on something announced', () => {
    const wrapper = open('some output');
    const el = pane(wrapper);

    expect(el.getAttribute('role')).toBe('log');
    expect(el.getAttribute('aria-label')).toBe('Live command output');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('does not re-announce the whole buffer on every frame', () => {
    const wrapper = open('some output');

    expect(pane(wrapper).getAttribute('aria-live')).toBe('off');
  });

  it('announces the waiting state politely', () => {
    const wrapper = open('');

    expect(wrapper.get('[role="status"]').text()).toContain('Waiting for output');
  });
});
