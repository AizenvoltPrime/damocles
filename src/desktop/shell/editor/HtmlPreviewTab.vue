<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, CloudOff, ExternalLink, LoaderCircle, RotateCw, ShieldAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { BANNER_TONE } from '@/components/banner-tone';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import type { ContentBounds, DamoclesShellApi, HtmlPreviewActionRequest, ShellEditorTab, ShellHtmlPreview } from '../../preload/shell-channels';
import { watchContentBounds } from '../content-bounds';
import { TOOLBAR_BUTTON } from './design-toolbar';
import PageStandIn from './PageStandIn.vue';

type Action = HtmlPreviewActionRequest['action'];

const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab & { htmlPreview: ShellHtmlPreview } }>();
const { t } = useI18n();

const preview = computed(() => props.tab.htmlPreview);
const stage = ref<HTMLElement | null>(null);
const card = ref<HTMLElement | null>(null);

// A request in flight keeps its button focusable (aria-disabled) and refuses a second click, so Trust Folder... asks once.
const pending = ref<ReadonlySet<Action>>(new Set());
// Whole turns of the Reload glyph, one per click; a growing angle, so each click turns it forward again.
const turns = ref(0);

async function run(action: Action): Promise<void> {
  if (pending.value.has(action)) return;
  if (action === 'reload' && !prefersReducedMotion()) turns.value += 1;
  pending.value = new Set([...pending.value, action]);
  try {
    await props.api.htmlPreviewAction({ tabId: props.tab.id, action });
  } catch (error) {
    // Main toasts a failure the user should see.
    console.error(`[html preview] main refused ${action}`, error);
  } finally {
    pending.value = new Set([...pending.value].filter((other) => other !== action));
  }
}

const statusText = computed(() => {
  switch (preview.value.status) {
    case 'loading': return t('editor.htmlPreview.loading');
    case 'offline': return t('editor.htmlPreview.offline', { host: preview.value.hostName });
    case 'failed': return t('editor.htmlPreview.failed');
    default: return '';
  }
});

// The card's corner radius inside its border, in CSS px, which main rounds the page view's corners to.
function cardInnerRadius(): number {
  const element = card.value;
  if (!element) return 0;
  const style = getComputedStyle(element);
  return Math.max(0, (Number.parseFloat(style.borderTopLeftRadius) || 0) - (Number.parseFloat(style.borderTopWidth) || 0));
}

// Main covers the stage with the page's view only while the page is ready and the stage has room; otherwise the shell's state
// shows in the card, and a hidden editor pane (display: none) measures empty.
let lastBounds: ContentBounds | undefined;
function report(): void {
  const bounds = lastBounds;
  const shown = bounds !== undefined && bounds.width > 0 && bounds.height > 0 && preview.value.status === 'ready';
  props.api.reportHtmlPreviewBounds(shown ? { tabId: props.tab.id, ...bounds, radius: cardInnerRadius() } : null);
}
watch(() => preview.value.status, report);

let stopBounds: (() => void) | undefined;
onMounted(() => {
  const element = stage.value;
  if (!element) return;
  const neighbours = [...document.querySelectorAll<HTMLElement>('[data-testid="title-bar"], [data-testid="layout-grid"], [data-testid^="grid-pane-"]')];
  stopBounds = watchContentBounds(element, neighbours, (bounds) => {
    lastBounds = bounds;
    report();
  });
});
onBeforeUnmount(() => {
  stopBounds?.();
  props.api.reportHtmlPreviewBounds(null);
});

const busy = (action: Action): true | undefined => (pending.value.has(action) ? true : undefined);
</script>

<template>
  <div
    data-testid="html-preview-tab"
    role="group"
    :aria-label="t('editor.htmlPreview.label')"
    class="@container/preview absolute inset-0 flex flex-col"
  >
    <div
      role="group"
      :aria-label="t('editor.htmlPreview.toolbar')"
      data-testid="html-preview-toolbar"
      class="relative flex h-8.5 shrink-0 items-center gap-1 border-b border-(--d-border) bg-(--d-panel) px-1.5"
    >
      <Button
        variant="ghost"
        data-testid="html-preview-reload"
        :class="TOOLBAR_BUTTON"
        :aria-label="t('editor.htmlPreview.reload')"
        :title="t('editor.htmlPreview.reloadTitle')"
        :aria-disabled="busy('reload')"
        :aria-busy="busy('reload')"
        @click="run('reload')"
      >
        <RotateCw
          aria-hidden="true"
          class="transition-transform duration-500 ease-(--ease-spring)"
          :style="{ transform: `rotate(${turns * 360}deg)` }"
        /><span class="@max-[22rem]/preview:sr-only">{{ t('editor.htmlPreview.reload') }}</span>
      </Button>
      <Button
        variant="ghost"
        data-testid="html-preview-open-in-browser"
        :class="cn(TOOLBAR_BUTTON, 'ms-auto')"
        :aria-label="t('editor.htmlPreview.openInBrowser')"
        :title="t('editor.htmlPreview.openInBrowserTitle')"
        :aria-disabled="busy('openInBrowser')"
        :aria-busy="busy('openInBrowser')"
        @click="run('openInBrowser')"
      >
        <ExternalLink aria-hidden="true" /><span class="@max-[22rem]/preview:sr-only">{{ t('editor.htmlPreview.openInBrowser') }}</span>
      </Button>
      <!-- The load line under the toolbar while the first load runs; d-sweep-bar rests still under reduced motion. -->
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
      >
        <Transition name="t-fade">
          <div
            v-if="preview.status === 'loading'"
            data-testid="html-preview-progress"
            class="d-sweep-bar size-full text-(--d-accent)"
          />
        </Transition>
      </div>
    </div>
    <!-- Shell DOM, never part of the page: an untrusted project's page runs no script, the page's own included. -->
    <Transition name="t-fade">
      <div
        v-if="!preview.trusted"
        role="status"
        data-testid="html-preview-untrusted"
        :class="cn('@container/banner flex min-h-8 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3.5 py-1 text-12', BANNER_TONE.warning)"
      >
        <ShieldAlert
          aria-hidden="true"
          class="size-3.5 shrink-0"
        />
        <span class="min-w-0 flex-1 @max-[24rem]/banner:basis-[calc(100%-1.5rem)]">{{ t('editor.htmlPreview.untrusted') }}</span>
        <Button
          variant="outline"
          size="sm"
          data-testid="html-preview-trust"
          class="d-press h-6 shrink-0 rounded-7 border-(--d-warning)/40 bg-transparent px-2.5 text-12 font-semibold text-current hover:border-(--d-warning)/70 hover:bg-(--d-warning)/12 hover:text-current focus-visible:ring-1 focus-visible:ring-(--d-warning) focus-visible:ring-offset-0 aria-disabled:cursor-default aria-disabled:opacity-(--d-opacity-disabled)"
          :aria-disabled="busy('trustFolder')"
          :aria-busy="busy('trustFolder')"
          @click="run('trustFolder')"
        >
          {{ t('editor.htmlPreview.trustFolder') }}
        </Button>
      </div>
    </Transition>
    <!-- The page sits in a rounded card inset from the pane, so no square corner of its view covers a rounded corner of the pane. -->
    <div class="min-h-0 flex-1 bg-(--d-bg) p-3.5">
      <div
        ref="card"
        data-testid="html-preview-card"
        :data-status="preview.status"
        class="relative size-full overflow-hidden rounded-10 border border-(--d-border) bg-(--d-panel) shadow-[0_0.75rem_2rem_-1.25rem_var(--d-scrim)]"
      >
        <!-- Main lays the page's view over exactly this element and rounds its corners to the card's; the states below show
             only while main shows no view. -->
        <div
          ref="stage"
          data-testid="html-preview-stage"
          class="absolute inset-0 rounded-[inherit]"
        >
          <PageStandIn
            :api="api"
            :tab-id="tab.id"
            :shows="preview.status === 'ready'"
          />
          <!-- One live region for the tab's life, since screen readers skip a region inserted with its text; the state card is hidden from them. -->
          <p
            role="status"
            data-testid="html-preview-announcer"
            class="sr-only"
          >
            {{ statusText }}
          </p>
          <Transition
            name="t-fade"
            mode="out-in"
          >
            <div
              v-if="preview.status !== 'ready'"
              :key="preview.status"
              aria-hidden="true"
              data-testid="html-preview-status"
              :data-status="preview.status"
              class="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center"
            >
              <span class="d-state-icon flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-bg) text-(--d-faint-text)">
                <LoaderCircle
                  v-if="preview.status === 'loading'"
                  aria-hidden="true"
                  class="d-spinning size-5"
                />
                <CloudOff
                  v-else-if="preview.status === 'offline'"
                  aria-hidden="true"
                  class="size-5 text-(--d-warning-text)"
                />
                <CircleAlert
                  v-else
                  aria-hidden="true"
                  class="size-5 text-(--d-danger-text)"
                />
              </span>
              <p class="max-w-80 text-12.5 text-pretty text-(--d-muted)">
                {{ statusText }}
              </p>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  </div>
</template>
