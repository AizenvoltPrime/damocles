<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowLeft, ArrowRight, CircleAlert, ExternalLink, Globe, LoaderCircle, Lock, RotateCw, SquareCode, SquareMousePointer, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { isNotSecurePage, MAX_BROWSER_URL_LENGTH } from '@shared/typed-address';
import type { BrowserAction, DamoclesShellApi, ShellEditorTab } from '../../preload/shell-channels';
import { watchContentBounds } from '../content-bounds';
import { EDITOR_STORE } from './editor-store';
import { isBlankPage, isSecurePage, isSendableAddress, isWebUrl, pageText, pageTitle } from './browser-page';

const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab & { browser: NonNullable<ShellEditorTab['browser']> } }>();
const { t } = useI18n();
const store = inject(EDITOR_STORE)!;

const page = computed(() => props.tab.browser);
const input = ref<InstanceType<typeof Input> | null>(null);
const stage = ref<HTMLElement | null>(null);
const card = ref<HTMLElement | null>(null);

const address = ref('');
const editing = ref(false);
const refused = ref(false);
// A sent address stays in the field until the page leaves `fromUrl`, or a load starts and ends without leaving it.
const pending = ref<{ tabId: string; fromUrl: string; sawLoading: boolean } | null>(null);

const shownAddress = (): string => (isBlankPage(page.value.url) ? '' : pageText(page.value.url));
const canOpenExternally = computed(() => isWebUrl(page.value.url));
const notSecure = computed(() => isNotSecurePage(page.value.url));
const title = computed(() => pageTitle(props.tab, t('editor.browser.newPage')));

// The field shows the page's address except while the user is typing over it.
watch(() => props.tab.id, () => {
  editing.value = false;
  refused.value = false;
  pending.value = null;
});
watch(() => [props.tab.id, page.value.url, page.value.loading] as const, ([tabId, url, loading]) => {
  const sent = pending.value;
  if (sent) {
    const settledInPlace = sent.sawLoading && !loading;
    if (tabId === sent.tabId && url === sent.fromUrl && !settledInPlace) {
      if (loading) sent.sawLoading = true;
      return;
    }
    pending.value = null;
  }
  if (!editing.value) address.value = shownAddress();
}, { immediate: true });

function field(): HTMLInputElement | undefined {
  return (input.value?.$el as HTMLInputElement | undefined) ?? undefined;
}

async function navigate(): Promise<void> {
  const tabId = props.tab.id;
  const fromUrl = page.value.url;
  const typed = address.value.trim();
  if (typed === '') return;
  // Main also refuses a tab that is no longer the selected chat's.
  const accepted = typed.length <= MAX_BROWSER_URL_LENGTH && isSendableAddress(typed) && await props.api.navigateBrowser({ tabId, url: typed }).catch(() => false);
  refused.value = !accepted;
  if (!accepted) return;
  editing.value = false;
  if (props.tab.id === tabId) pending.value = { tabId, fromUrl, sawLoading: false };
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    void navigate();
    return;
  }
  // Escape reverts an edit first; with nothing to revert it reaches the pane, which may leave the focus overlay.
  if (event.key === 'Escape' && (editing.value || refused.value || pending.value)) {
    event.stopPropagation();
    editing.value = false;
    refused.value = false;
    pending.value = null;
    address.value = shownAddress();
  }
}

function onInput(): void {
  editing.value = true;
  refused.value = false;
}

// A click that focuses the field selects the whole address, as a browser's address bar does; the next click places the caret.
let selectOnMouseUp = false;
function onPointerDown(): void {
  selectOnMouseUp = document.activeElement !== field();
}
function onMouseUp(event: MouseEvent): void {
  if (!selectOnMouseUp) return;
  selectOnMouseUp = false;
  event.preventDefault();
  field()?.select();
}

// Main tells the user of a failure they should see; a refusal for a tab that is no longer the selected chat's leaves nothing to update.
function run(action: BrowserAction): void {
  props.api.browserAction({ tabId: props.tab.id, action }).catch(() => undefined);
}

// The tab a user opened (New Browser Page, F6, Ctrl+Tab) takes focus in its address field, ready for typing.
function takeFocus(): void {
  if (!store.takeFocus(props.tab.id)) return;
  void nextTick(() => {
    field()?.focus();
    field()?.select();
  });
}
watch(store.focusRequest, takeFocus);
watch(() => props.tab.id, takeFocus);

// The load line trickles toward the end while the page loads, completes, then fades (transform and opacity only).
const progress = ref<'idle' | 'start' | 'loading' | 'done'>('idle');
let frame = 0;
watch([() => props.tab.id, () => page.value.loading], ([, loading], previous) => {
  cancelAnimationFrame(frame);
  const switched = previous !== undefined && previous[0] !== props.tab.id;
  if (loading) {
    progress.value = 'start';
    // Two frames, so the start position paints before the trickle's transition begins.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        progress.value = 'loading';
      });
    });
  } else {
    progress.value = switched || progress.value === 'idle' ? 'idle' : 'done';
  }
}, { immediate: true });
function onProgressEnd(event: TransitionEvent): void {
  if (event.propertyName === 'opacity' && progress.value === 'done') progress.value = 'idle';
}

// The card's corner radius inside its border, in CSS px, which main rounds the page view's corners to.
function cardInnerRadius(): number {
  const element = card.value;
  if (!element) return 0;
  const style = getComputedStyle(element);
  return Math.max(0, (Number.parseFloat(style.borderTopLeftRadius) || 0) - (Number.parseFloat(style.borderTopWidth) || 0));
}

// Main covers exactly this element with the page's view, so the grid and the title bar are its layout neighbours.
let stopBounds: (() => void) | undefined;
onMounted(() => {
  const element = stage.value;
  if (!element) return;
  const neighbours = [...document.querySelectorAll<HTMLElement>('[data-testid="title-bar"], [data-testid="layout-grid"], [data-testid^="grid-pane-"]')];
  stopBounds = watchContentBounds(element, neighbours, (bounds) => props.api.reportBrowserBounds({ ...bounds, radius: cardInnerRadius() }));
  takeFocus();
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  stopBounds?.();
  props.api.reportBrowserBounds(null);
});

const BUTTON = 'd-press size-6.5 shrink-0 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5';
</script>

<template>
  <div
    data-testid="browser-tab"
    class="absolute inset-0 flex flex-col"
  >
    <div
      role="group"
      :aria-label="t('editor.browser.navigation')"
      data-testid="browser-nav"
      class="relative flex h-8.5 shrink-0 items-center gap-0.5 border-b border-(--d-border) bg-(--d-panel) px-1.5"
    >
      <Button
        variant="ghost"
        size="icon"
        data-testid="browser-back"
        :class="BUTTON"
        :disabled="!page.canGoBack"
        :aria-label="t('editor.browser.back')"
        :title="t('editor.browser.back')"
        @click="run('back')"
      >
        <ArrowLeft aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        data-testid="browser-forward"
        :class="BUTTON"
        :disabled="!page.canGoForward"
        :aria-label="t('editor.browser.forward')"
        :title="t('editor.browser.forward')"
        @click="run('forward')"
      >
        <ArrowRight aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        data-testid="browser-reload"
        :class="BUTTON"
        :aria-label="t('editor.browser.reload')"
        :title="t('editor.browser.reload')"
        @click="run('reload')"
      >
        <RotateCw aria-hidden="true" />
      </Button>
      <!-- The field's frame, since an input cannot hold the not secure notice beside the address it marks. -->
      <div
        data-testid="browser-address-field"
        :class="cn(
          'mx-1 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-7 border bg-(--d-input) pr-2.5 transition-[border-color,box-shadow] duration-150',
          notSecure && !refused ? 'pl-0.75' : 'pl-2.25',
          refused
            ? 'border-(--d-danger) focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--d-danger)_22%,transparent)]'
            : 'border-(--d-border) hover:border-(--d-border2) focus-within:border-(--d-accent) focus-within:shadow-[0_0_0_3px_var(--d-accent-soft)]',
        )"
      >
        <Transition
          name="t-chip"
          mode="out-in"
        >
          <CircleAlert
            v-if="refused"
            key="refused"
            aria-hidden="true"
            class="pointer-events-none size-3 shrink-0 text-(--d-danger-text)"
          />
          <!-- A label, so a click on the notice puts the caret in the address as a click on the rest of the field does. -->
          <label
            v-else-if="notSecure"
            id="browser-address-security"
            key="not-secure"
            for="browser-address"
            data-testid="browser-not-secure"
            :title="t('editor.browser.notSecureDetail')"
            class="d-tone-warning flex h-4.5 shrink-0 cursor-text items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--tone)_14%,transparent)] px-1.5 text-10.5 font-medium whitespace-nowrap"
          >
            <TriangleAlert
              aria-hidden="true"
              class="size-2.75"
            />
            {{ t('editor.browser.notSecure') }}
          </label>
          <Lock
            v-else-if="isSecurePage(page.url)"
            key="secure"
            aria-hidden="true"
            class="pointer-events-none size-2.75 shrink-0 text-(--d-faint-text)"
          />
          <Globe
            v-else
            key="page"
            aria-hidden="true"
            class="pointer-events-none size-2.75 shrink-0 text-(--d-faint-text)"
          />
        </Transition>
        <Input
          id="browser-address"
          ref="input"
          v-model="address"
          type="text"
          inputmode="url"
          spellcheck="false"
          autocomplete="off"
          data-testid="browser-address"
          :placeholder="t('editor.browser.addressPlaceholder')"
          :aria-label="t('editor.browser.address')"
          :aria-invalid="refused || undefined"
          :aria-describedby="refused ? 'browser-address-error' : notSecure ? 'browser-address-security' : undefined"
          :title="refused ? t('editor.browser.addressRefused') : undefined"
          class="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 font-mono text-11.5 text-(--d-text) shadow-none ring-offset-0 placeholder:font-sans placeholder:text-(--d-faint-text) focus-visible:ring-0 focus-visible:ring-offset-0"
          @pointerdown="onPointerDown"
          @mouseup="onMouseUp"
          @input="onInput"
          @keydown="onKeydown"
        />
        <span
          id="browser-address-error"
          role="status"
          class="sr-only"
        >{{ refused ? t('editor.browser.addressRefused') : '' }}</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        data-testid="browser-pick"
        :class="cn(BUTTON, page.picking && 'bg-(--d-accent-soft) text-(--d-accent-text) hover:bg-(--d-accent-soft) hover:text-(--d-accent-text)')"
        :aria-label="t('editor.browser.pickElement')"
        :aria-pressed="page.picking"
        :title="t('editor.browser.pickElement')"
        @click="run('pickElement')"
      >
        <SquareMousePointer aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        data-testid="browser-devtools"
        :class="BUTTON"
        :aria-label="t('editor.browser.devTools')"
        :title="t('editor.browser.devTools')"
        @click="run('devTools')"
      >
        <SquareCode aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        data-testid="browser-open-external"
        :class="BUTTON"
        :disabled="!canOpenExternally"
        :aria-label="t('editor.browser.openExternal')"
        :title="canOpenExternally ? t('editor.browser.openExternal') : t('editor.browser.openExternalUnavailable')"
        @click="run('openExternal')"
      >
        <ExternalLink aria-hidden="true" />
      </Button>
      <!-- The load line: no shadcn part draws an indeterminate line that trickles, completes and fades. -->
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
      >
        <div
          data-testid="browser-progress"
          class="browser-progress h-full bg-(--d-accent)"
          :data-phase="progress"
          @transitionend="onProgressEnd"
        />
      </div>
    </div>
    <!-- The page sits in a rounded card inset from the pane, as the reference draws it, so no square corner of its view
         covers a rounded corner of the pane. -->
    <div class="min-h-0 flex-1 bg-(--d-bg) p-3.5">
      <div
        ref="card"
        data-testid="browser-card"
        class="relative size-full overflow-hidden rounded-10 border border-(--d-border) bg-(--d-panel)"
      >
        <!-- Main lays the page's view over exactly this element and rounds its corners to the card's; what it draws shows
             only until the view covers it. -->
        <div
          ref="stage"
          data-testid="browser-stage"
          class="absolute inset-0"
        >
          <div
            :key="tab.id"
            class="pane-empty d-fade-in absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center"
          >
            <span class="flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-bg) text-(--d-faint-text)">
              <LoaderCircle
                v-if="page.loading"
                aria-hidden="true"
                class="d-spinning size-5"
              />
              <Globe
                v-else
                aria-hidden="true"
                class="size-5"
              />
            </span>
            <p class="max-w-80 truncate text-12.5 text-(--d-muted)">
              {{ title }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
