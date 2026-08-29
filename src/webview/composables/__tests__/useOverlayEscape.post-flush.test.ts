// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createApp, onMounted, type Component } from 'vue';
import { hasOpenOverlay, useOverlayEscape } from '../useOverlayEscape';

/**
 * An overlay must still de-register after Vue's post-flush queue has stopped running callbacks.
 *
 * `onUnmounted` is queued post-flush. Vue's `render` wraps that flush in `isFlushing = true` with no
 * `try`/`finally`, and the flush loop itself has no per-callback `try`/`catch`, so one throw leaves
 * both flags set and every post-flush callback queued afterwards is silently dropped. From then on an
 * overlay de-registering in `onUnmounted` would leave its entry in the module-scoped stack, and Escape
 * would be a silent no-op for every overlay opened later, until the webview reloads.
 *
 * These mounts use `createApp` rather than `@vue/test-utils`, which installs an `app.config`
 * `errorHandler` during mount that swallows the throw and re-raises it after the flush has finished.
 * That handler is a test-harness convenience the real webview does not have.
 *
 * The flush flags are module state inside Vue and there is no way to clear them, so this file holds
 * exactly one case; vitest gives each file its own module registry.
 */

interface BareMount {
  readonly unmount: () => void;
}

function mountBare(component: Component): BareMount {
  const app = createApp(component);
  const el = document.createElement('div');
  document.body.appendChild(el);
  app.mount(el);
  return {
    unmount: () => {
      app.unmount();
      el.remove();
    },
  };
}

function overlayComponent(onClose: () => void): Component {
  return {
    setup() {
      useOverlayEscape(onClose);
      return () => null;
    },
  };
}

function mountedHookProbe(onMountedHook: () => void): Component {
  return {
    setup() {
      onMounted(onMountedHook);
      return () => null;
    },
  };
}

function pressEscape(): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

describe('an overlay torn down after the post-flush queue has stopped running', () => {
  it('still leaves the stack, so Escape keeps reaching the next overlay opened', () => {
    const thrower = mountedHookProbe(() => {
      throw new Error('a post-flush callback threw');
    });
    expect(() => mountBare(thrower)).toThrow('a post-flush callback threw');

    // The dropped queue is the whole premise, so prove it took hold before relying on it.
    const laterMount = vi.fn();
    mountBare(mountedHookProbe(laterMount));
    expect(laterMount).not.toHaveBeenCalled();

    const stranded = vi.fn();
    const first = mountBare(overlayComponent(stranded));
    expect(hasOpenOverlay()).toBe(true);

    first.unmount();

    expect(hasOpenOverlay()).toBe(false);

    const later = vi.fn();
    const second = mountBare(overlayComponent(later));
    pressEscape();

    expect(later).toHaveBeenCalledTimes(1);
    expect(stranded).not.toHaveBeenCalled();

    second.unmount();
  });
});
