<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Globe, Maximize2, Minimize2, PanelRightClose, Plus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PANE_CHROME_HEIGHT, PANE_DIVIDER_WIDTH, type DamoclesPaneApi, type PaneState } from '../../preload/pane-channels';
import { applyShellLocale } from '../i18n';
import PaneDivider from './components/PaneDivider.vue';
import PageTabStrip from './components/PageTabStrip.vue';
import PaneNavBar from './components/PaneNavBar.vue';
import { PAGE_PANEL_ID, pageDomId } from './page-ids';

const props = defineProps<{ api: DamoclesPaneApi }>();
const { t } = useI18n();

const PANE_ID = 'browser-pane';

const state = shallowRef<PaneState | null>(null);
// Bumped each time the pane opens from collapsed, which remounts it so its entry animation plays.
const openCount = ref(0);

const activePage = computed(() => state.value?.pages.find((page) => page.id === state.value?.activePageId));
const overlay = computed(() => state.value?.mode === 'overlay');
const maximized = computed(() => state.value?.mode === 'maximized');
const collapseLabel = computed(() => t('pane.collapse', { shortcut: state.value?.toggleShortcutLabel ?? '' }));
const maximizeLabel = computed(() => (maximized.value ? t('pane.restore') : t('pane.maximize')));

function applyState(next: PaneState): void {
  state.value = next;
  applyShellLocale(next.locale);
}

watch(() => state.value?.mode, (mode, previous) => {
  if (previous === 'collapsed' && mode !== 'collapsed') openCount.value += 1;
});

function collapse(): void {
  void props.api.setCollapsed(true);
}

// A page the user asked for is blank until they type where to go, so its address field takes focus once main selects it.
let focusAddressOnNewPage = false;
function newPage(): void {
  focusAddressOnNewPage = true;
  void props.api.newPage();
}
watch(() => state.value?.activePageId, async (id, previous) => {
  if (!focusAddressOnNewPage || id === undefined || id === previous) return;
  focusAddressOnNewPage = false;
  await nextTick();
  document.getElementById('pane-address')?.focus();
});

function requestWidth(width: number, commit: boolean): void {
  props.api.requestWidth(width, commit);
}

// Bubble phase on document, so a control that keeps Escape for itself (the address field reverting an edit) stops it first.
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && overlay.value && !event.defaultPrevented) {
    event.preventDefault();
    collapse();
  }
}

// Main focuses this view for F6 and then asks for a target: the active page tab, else the first control.
function focusPane(): void {
  const pane = document.getElementById(PANE_ID);
  const tab = state.value?.activePageId !== undefined ? document.getElementById(pageDomId(state.value.activePageId)) : null;
  (tab ?? pane?.querySelector<HTMLElement>('[role="tab"], button:not(:disabled), [tabindex="0"]'))?.focus();
}

let stopState: (() => void) | undefined;
let stopFocus: (() => void) | undefined;
onMounted(async () => {
  document.addEventListener('keydown', onDocumentKeydown);
  stopFocus = props.api.onFocusRequest(focusPane);
  // Subscribed before the first read, so a change between the two is not lost.
  stopState = props.api.onState(applyState);
  applyState(await props.api.getState());
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeydown);
  stopState?.();
  stopFocus?.();
});

const ACTION_BUTTON = 'size-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted-foreground/20 focus-visible:ring-offset-0';
</script>

<template>
  <div
    v-if="state"
    class="flex h-full min-h-0"
  >
    <!-- Overlay mode: the pane view spans the chat area, and this part shows the chat through a scrim. -->
    <div
      v-if="overlay"
      aria-hidden="true"
      class="h-full min-w-0 flex-1 d-fade-in bg-black/25"
      @click="collapse"
    />
    <section
      :id="PANE_ID"
      :key="openCount"
      :aria-label="t('pane.label')"
      :class="cn(
        'flex h-full min-w-0 bg-background text-foreground d-enter-from-end',
        overlay ? 'shrink-0 shadow-[-12px_0_32px_rgb(0_0_0/0.35)]' : 'flex-1',
      )"
      :style="overlay ? { width: `${state.width}px` } : undefined"
    >
      <PaneDivider
        v-if="!maximized"
        :style="{ width: `${PANE_DIVIDER_WIDTH}px` }"
        :width="state.width"
        :min-width="state.minWidth"
        :max-width="state.maxWidth"
        :controls="PANE_ID"
        @resize="requestWidth"
      />
      <div class="flex min-w-0 flex-1 flex-col">
        <!-- Main lays the page view out below exactly this height (PANE_CHROME_HEIGHT). -->
        <div
          class="flex shrink-0 flex-col"
          :style="{ height: `${PANE_CHROME_HEIGHT}px` }"
        >
          <!-- The strip's bottom rule is an inset shadow, which the active tab's own background paints over. -->
          <div class="flex h-9 shrink-0 items-stretch bg-card shadow-[inset_0_-1px_0_var(--border)]">
            <PageTabStrip
              :pages="state.pages"
              :active-page-id="state.activePageId"
              :mac="state.platform === 'darwin'"
              @select="api.selectPage"
              @close="api.closePage"
            />
            <div class="flex shrink-0 items-center gap-0.5 border-l border-border px-1">
              <Button
                v-if="state.browserEnabled"
                variant="ghost"
                size="icon-sm"
                :class="ACTION_BUTTON"
                :aria-label="t('pane.newPage')"
                :title="t('pane.newPage')"
                @click="newPage"
              >
                <Plus aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                :class="ACTION_BUTTON"
                :aria-label="maximizeLabel"
                :title="maximizeLabel"
                @click="api.setMaximized(!maximized)"
              >
                <Minimize2
                  v-if="maximized"
                  aria-hidden="true"
                />
                <Maximize2
                  v-else
                  aria-hidden="true"
                />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                :class="ACTION_BUTTON"
                :aria-label="t('pane.collapseName')"
                :title="collapseLabel"
                @click="collapse"
              >
                <PanelRightClose aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div class="relative min-h-0 flex-1 border-b border-border bg-background">
            <PaneNavBar
              :api="api"
              :page="activePage"
            />
            <div
              v-if="activePage?.loading"
              class="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
              aria-hidden="true"
            >
              <div class="d-sweep-bar h-full text-info" />
            </div>
          </div>
        </div>
        <!-- Main lays the active page's view over exactly this element. -->
        <div
          v-if="activePage"
          :id="PAGE_PANEL_ID"
          role="tabpanel"
          :aria-labelledby="pageDomId(activePage.id)"
          class="min-h-0 flex-1 bg-background"
        />
        <div
          v-else
          class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <div class="flex size-12 items-center justify-center rounded-full bg-muted-foreground/10 text-muted-foreground">
            <Globe
              class="size-6"
              aria-hidden="true"
            />
          </div>
          <p class="max-w-64 text-sm text-muted-foreground">
            {{ t('pane.empty') }}
          </p>
          <Button
            v-if="state.browserEnabled"
            size="sm"
            class="h-8 px-3 text-xs"
            @click="newPage"
          >
            <Plus aria-hidden="true" />
            {{ t('pane.newPage') }}
          </Button>
        </div>
      </div>
    </section>
  </div>
</template>
