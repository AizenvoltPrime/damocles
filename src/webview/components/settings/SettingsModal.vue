<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { onKeyStroke, useWindowSize } from '@vueuse/core';
import {
  AppWindow,
  Blocks,
  ChevronLeft,
  CopyPlus,
  ExternalLink,
  FileJson,
  FolderCog,
  KeyRound,
  MessageSquare,
  Mic,
  Search,
  Settings,
  Users,
  X,
} from 'lucide-vue-next';
import type { SettingsSectionId, SettingsTarget } from '@shared/settings-sections';
import type { SettingsFileScope } from '@shared/types/messages';
import { useOverlayDialog } from '@/composables/useOverlayDialog';
import { remPx } from '@/composables/useRemPx';
import { isMac } from '@/composables/usePlatformKey';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_CONTENT, MENU_ITEM } from '@/components/chat-header/menuStyles';
import SettingsNav from './SettingsNav.vue';
import SettingsPage from './SettingsPage.vue';
import SettingButton from './controls/SettingButton.vue';
import { normalizeQuery, SETTINGS_ROWS, type HostSettings, type SettingsRowMeta, type SettingsSectionMeta } from './settings-rows';
import { provideSettingsBanner, provideSettingsFiles, provideSettingsTarget, type SettingsBanner } from './settings-view';
import './settings.css';

/** How the footer reaches the full settings: the host's own Settings UI, or the chat's settings.json editor. */
export type SettingsFooter = { readonly kind: 'hostSettings' } | { readonly kind: 'settingsFiles' };

const props = defineProps<{
  host: HostSettings;
  footer: SettingsFooter;
  /** The scrim blurs what is behind it only where the modal shares that document (VS Code); desktop only dims. */
  backdrop: 'blur' | 'dim';
  /** Where to open; a new object while the modal shows goes there. */
  target?: SettingsTarget | undefined;
  /** A new value remounts the page, dropping anything typed into it, and asks for the state again (the desktop view re-attached to another chat). */
  pageKey?: number | undefined;
}>();

const emit = defineEmits<{
  /** After the exit animation, or at once under reduced motion; unmount the modal on it. */
  (e: 'closed'): void;
  (e: 'openHostSettings'): void;
  (e: 'editSettingsFile', scope: SettingsFileScope): void;
}>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const editorStore = useEditorStore();
const { voiceControlsAvailable } = storeToRefs(settingsStore);
const { postMessage } = usePlatformBridge();

const SHARED_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: 'chat', label: 'settingsModal.sectionsMeta.chat.label', subtitle: 'settingsModal.sectionsMeta.chat.subtitle', icon: MessageSquare },
  { id: 'defaults', label: 'settingsModal.sectionsMeta.defaults.label', subtitle: 'settingsModal.sectionsMeta.defaults.subtitle', icon: CopyPlus },
  { id: 'accounts', label: 'settingsModal.sectionsMeta.accounts.label', subtitle: 'settingsModal.sectionsMeta.accounts.subtitle', icon: KeyRound },
  { id: 'teams', label: 'settingsModal.sectionsMeta.teams.label', subtitle: 'settingsModal.sectionsMeta.teams.subtitle', icon: Users },
  { id: 'workspace', label: 'settingsModal.sectionsMeta.workspace.label', subtitle: 'settingsModal.sectionsMeta.workspace.subtitle', icon: FolderCog },
  { id: 'application', label: 'settingsModal.sectionsMeta.application.label', subtitle: 'settingsModal.sectionsMeta.application.subtitle', icon: AppWindow },
  { id: 'integrations', label: 'settingsModal.sectionsMeta.integrations.label', subtitle: 'settingsModal.sectionsMeta.integrations.subtitle', icon: Blocks },
  { id: 'voice', label: 'settingsModal.sectionsMeta.voice.label', subtitle: 'settingsModal.sectionsMeta.voice.subtitle', icon: Mic },
];

const sections = computed<readonly SettingsSectionMeta[]>(() => [
  ...SHARED_SECTIONS.filter((section) => section.id !== 'voice' || voiceControlsAvailable.value),
  ...props.host.sections,
]);

const rows = computed<ReadonlyMap<string, SettingsRowMeta>>(() => {
  const all = [...SETTINGS_ROWS, ...props.host.sections.flatMap((section) => section.rows), ...props.host.rows.flatMap((entry) => entry.rows)];
  return new Map(all.map((row) => [row.id, row]));
});

// A row in a hidden section (Voice without a voice path) shows nothing, so its keys' file values are listed instead.
const rowKeys = computed<ReadonlySet<string>>(() => new Set([...rows.value.values()]
  .filter((row) => sections.value.some((section) => section.id === row.section))
  .flatMap((row) => row.keys ?? [])));
provideSettingsFiles({ rowKeys, open: (scope) => emit('editSettingsFile', scope) });

const { width: windowWidth } = useWindowSize();
const narrow = computed(() => windowWidth.value < remPx(45));
const active = ref<SettingsSectionId>(props.target?.section ?? 'chat');
// The list layout opens on the nav unless the caller asked for a section.
const narrowPage = ref<'nav' | 'section'>(props.target?.section ? 'section' : 'nav');
const request = shallowRef<SettingsTarget | null>(props.target ?? null);
provideSettingsTarget(request);
const typed = ref('');
const query = computed(() => normalizeQuery(typed.value));
const matches = ref(0);

const activeMeta = computed(() => sections.value.find((section) => section.id === active.value) ?? sections.value[0]!);
const pageSections = computed(() => (query.value ? sections.value : [activeMeta.value]));
const contentKey = computed(() => `${active.value}\0${props.pageKey ?? 0}`);
const showNav = computed(() => !narrow.value || narrowPage.value === 'nav');
const showMain = computed(() => !narrow.value || narrowPage.value === 'section' || query.value !== '');
const panelId = useId();

const leaving = ref(false);
const { zIndex, isTop, root } = useOverlayDialog(() => (typed.value !== '' ? clearSearch() : close()));

const searchInput = shallowRef<HTMLInputElement | null>(null);

function clearSearch(): void {
  typed.value = '';
}

function goTo(section: SettingsSectionId): void {
  typed.value = '';
  active.value = section;
  narrowPage.value = 'section';
}

// The user's own choice drops the request, so returning to Accounts does not expand its row again.
function select(section: SettingsSectionId): void {
  request.value = null;
  goTo(section);
}

watch(() => props.target, (next) => {
  if (!next) return;
  request.value = next;
  if (next.section) goTo(next.section);
});

function back(): void {
  narrowPage.value = 'nav';
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-testid="settings-nav-${active.value}"]`)?.focus());
}

function reducedMotion(): boolean {
  return document.documentElement.hasAttribute('data-reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const scrim = shallowRef<HTMLElement | null>(null);
const EXIT = { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' } as const;

// The exit's `finished` is the end signal: a CSS transition that never starts fires no transitionend, and the overlay would never answer main.
async function close(): Promise<void> {
  if (leaving.value) return;
  leaving.value = true;
  const panel = root.value;
  if (reducedMotion() || !panel) {
    emit('closed');
    return;
  }
  scrim.value?.animate([{ opacity: 1 }, { opacity: 0 }], EXIT);
  // A cancelled animation rejects `finished` with an AbortError; the exit has ended all the same.
  await panel.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.98)' }], EXIT).finished.catch(() => undefined);
  emit('closed');
}

onKeyStroke((event) => event.key.toLowerCase() === 'f' && (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey, (event) => {
  if (!isTop.value) return;
  event.preventDefault();
  narrowPage.value = 'nav';
  void nextTick(() => {
    searchInput.value?.focus();
    searchInput.value?.select();
  });
}, { target: document });

const banner = shallowRef<SettingsBanner | null>(null);
provideSettingsBanner({
  show: (next) => (banner.value = next),
  dismiss: () => (banner.value = null),
});

const heading = computed(() => (query.value
  ? { title: t('settingsModal.searchResults'), subtitle: t('settingsModal.matching', { n: matches.value }, matches.value) }
  : { title: t(activeMeta.value.label), subtitle: t(activeMeta.value.subtitle) }));

// Editing settings.json: the three files, offered where the host can edit them in the chat.
const FILE_SCOPES: readonly SettingsFileScope[] = ['user', 'project', 'local'];
function fileUnavailable(scope: SettingsFileScope): string | null {
  const availability = editorStore.settingsFileAvailability?.[scope];
  if (availability === undefined || availability.available) return null;
  return availability.reason === 'noProject' ? t('settings.jsonFiles.noProject') : t('settings.jsonFiles.untrusted');
}

// The one request a settings view sends; its sections render what core answers and the changes it pushes after.
watch(() => props.pageKey, () => postMessage({ type: 'requestSettingsState' }), { immediate: true });

watch(narrow, (isNarrow) => {
  if (!isNarrow) narrowPage.value = 'section';
});

defineExpose({ close });
</script>

<template>
  <div
    class="sm-root"
    :class="{ 'sm-leaving': leaving, 'sm-narrow': narrow }"
    :style="{ zIndex }"
  >
    <div
      ref="scrim"
      class="sm-scrim"
      :class="{ 'sm-scrim-blur': backdrop === 'blur' }"
      aria-hidden="true"
      data-testid="settings-scrim"
      @click="close"
    />
    <div
      ref="root"
      class="sm-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settingsModal.title')"
      tabindex="-1"
      data-testid="settings-modal"
      :data-leaving="leaving ? '' : undefined"
    >
      <aside
        v-if="showNav"
        class="sm-nav"
        :class="{ 'sm-nav-compact': narrow && showMain }"
      >
        <div class="sm-brand">
          <Settings
            class="size-4"
            aria-hidden="true"
          />
          <span class="flex-1">{{ t('settingsModal.title') }}</span>
          <button
            v-if="narrow"
            type="button"
            class="sm-icon-button"
            :aria-label="t('settingsModal.close')"
            :title="t('settingsModal.close')"
            @click="close"
          >
            <X
              class="size-4"
              aria-hidden="true"
            />
          </button>
        </div>
        <div class="sm-search">
          <Search
            class="size-3.25"
            aria-hidden="true"
          />
          <input
            ref="searchInput"
            v-model="typed"
            type="search"
            spellcheck="false"
            autocomplete="off"
            data-testid="settings-search"
            :placeholder="t('settingsModal.search')"
            :aria-label="t('settingsModal.search')"
            :aria-controls="panelId"
          >
          <button
            v-if="typed"
            type="button"
            class="sm-search-clear"
            :aria-label="t('settingsModal.clearSearch')"
            @click="clearSearch"
          >
            <X
              class="size-3"
              aria-hidden="true"
            />
          </button>
        </div>
        <SettingsNav
          v-if="!narrow || !query"
          :sections="sections"
          :active="active"
          :searching="query !== ''"
          :list="narrow"
          :panel-id="panelId"
          @select="select"
        />
        <span
          v-if="!narrow"
          class="flex-1"
        />
        <template v-if="!narrow || !query">
          <DropdownMenu v-if="footer.kind === 'settingsFiles'">
            <DropdownMenuTrigger
              class="sm-footer-link w-full"
              data-testid="settings-footer"
            >
              <FileJson
                class="size-3.25"
                aria-hidden="true"
              />
              {{ t('settingsModal.editSettingsJson') }}
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              :class="['w-(--reka-dropdown-menu-trigger-width)', MENU_CONTENT]"
            >
              <DropdownMenuItem
                v-for="scope in FILE_SCOPES"
                :key="scope"
                :class="MENU_ITEM"
                :disabled="fileUnavailable(scope) !== null"
                :data-testid="`settings-edit-json-${scope}`"
                @select="emit('editSettingsFile', scope)"
              >
                <span class="sm-option-text">
                  {{ t(`settings.jsonFiles.edit.${scope}`) }}
                  <span
                    v-if="fileUnavailable(scope)"
                    class="sm-option-hint"
                  >{{ fileUnavailable(scope) }}</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            v-else
            type="button"
            class="sm-footer-link w-full"
            data-testid="settings-footer"
            @click="emit('openHostSettings')"
          >
            <ExternalLink
              class="size-3.25"
              aria-hidden="true"
            />
            {{ t('settings.openVsCodeSettings') }}
          </button>
        </template>
      </aside>

      <section
        v-if="showMain"
        :id="panelId"
        class="sm-main"
        :class="{ 'sm-page-in': narrow }"
        role="tabpanel"
      >
        <header class="sm-header">
          <button
            v-if="narrow && !query"
            type="button"
            class="sm-icon-button"
            :aria-label="t('settingsModal.back')"
            :title="t('settingsModal.back')"
            @click="back"
          >
            <ChevronLeft
              class="size-4"
              aria-hidden="true"
            />
          </button>
          <div
            :key="heading.title"
            class="sm-heading"
          >
            <h2 class="sm-title">
              {{ heading.title }}
            </h2>
            <div class="sm-subtitle">
              {{ heading.subtitle }}
            </div>
          </div>
          <button
            type="button"
            class="sm-icon-button"
            :aria-label="t('settingsModal.close')"
            :title="t('settingsModal.close')"
            @click="close"
          >
            <X
              class="size-4"
              aria-hidden="true"
            />
          </button>
        </header>
        <div
          :key="contentKey"
          class="sm-content"
        >
          <div
            v-if="banner"
            class="sm-banner"
            role="status"
            :data-testid="banner.testId"
          >
            <span class="sm-banner-text">{{ banner.text }}</span>
            <SettingButton
              v-for="action in banner.actions"
              :key="action.label"
              :variant="action.primary ? 'primary' : 'default'"
              @click="action.run"
            >
              {{ action.label }}
            </SettingButton>
          </div>
          <SettingsPage
            :sections="pageSections"
            :query="query"
            :typed="typed"
            :host="host"
            :rows="rows"
            @matches="(count) => (matches = count)"
          />
        </div>
      </section>
    </div>
  </div>
</template>
