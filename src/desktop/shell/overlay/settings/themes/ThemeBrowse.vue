<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Code, Film, Ghost, LayoutDashboard, Link, RefreshCw, Search, ShieldAlert, ShieldCheck, Store, TriangleAlert } from 'lucide-vue-next';
import ThemeMiniature from '@/components/theme/ThemeMiniature.vue';
import { Input } from '@/components/ui/input';
import { useSettingWritesStore } from '@/components/settings/settings-writes';
import type { Look, ThemeFile } from '@shared/themes/schema';
import { LOOK_KINDS, type LookKind } from '@shared/themes/tokens';
import { DEFAULT_PANEL_LOOK } from '@shared/themes/wallpapers';
import { THEMES_STORE_SETTING } from '../../../../local-services/desktop-configuration';
import type { OverlayStoreEntry, OverlayStoreView } from '../../../../preload/overlay-channels';
import { answerOf } from '../../popup-answer';
import { useDesktopPrefs } from '../desktop-prefs';

// The community store's Browse tab: the signed list core verified, each entry drawn from its own colors. Entry texts come from
// outside this computer, so they render as plain text only.
const props = defineProps<{
  // the entry whose download main is fetching for the install dialog
  installing: string | undefined;
}>();
const emit = defineEmits<{
  (e: 'install', entryId: string): void;
  (e: 'cancelInstall'): void;
  (e: 'installFromLink'): void;
}>();

type Filter = 'dark' | 'light' | 'characters' | 'moving';
const FILTERS: readonly Filter[] = ['dark', 'light', 'characters', 'moving'];
const SKELETONS = 3;

const { t, locale } = useI18n();
const prefs = useDesktopPrefs();
const writes = useSettingWritesStore();
const uid = useId();
const view = shallowRef<OverlayStoreView>();
const failure = ref<string>();
// refreshing: the user asked for a check; busy: any list request is in flight
const refreshing = ref(false);
const busy = ref(false);
// the newest request wins: a slower answer to an older one never replaces it
let asked = 0;

async function load(refresh: boolean): Promise<void> {
  const request = ++asked;
  failure.value = undefined;
  refreshing.value = refresh;
  busy.value = true;
  try {
    const answer = await answerOf(prefs.api.storeList(refresh));
    if (request !== asked || !answer) return;
    if (answer.ok) view.value = answer.view;
    else failure.value = answer.error;
  } catch (err) {
    if (request === asked) failure.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (request === asked) {
      refreshing.value = false;
      busy.value = false;
    }
  }
}
onMounted(() => void load(false));
// a push during a request is older than the answer that request brings
onScopeDispose(prefs.api.onStoreUpdated((next) => {
  if (!busy.value) view.value = next;
}));
// Turning the store on or off lists again once main wrote the setting, so core reads the new value.
watch(() => writes.latest([THEMES_STORE_SETTING]), (written) => {
  if (written?.kind === 'saved') void load(false);
});

const state = computed(() => (view.value === undefined ? (failure.value ? 'failed' : 'loading') : view.value.state));
const listed = computed(() => state.value === 'ok' || state.value === 'cached');
const loading = computed(() => state.value === 'loading' || (busy.value && !listed.value));
const formatTime = (at: number): string => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
const fetchedText = computed(() => (view.value?.fetchedAt === undefined ? '' : formatTime(view.value.fetchedAt)));

// Search and filters
const query = ref('');
const filters = ref<ReadonlySet<Filter>>(new Set());
function toggle(filter: Filter): void {
  const next = new Set(filters.value);
  if (next.has(filter)) next.delete(filter);
  else next.add(filter);
  filters.value = next;
}
function clearSearch(): void {
  query.value = '';
  filters.value = new Set();
}
const matchesFilter = (entry: OverlayStoreEntry, filter: Filter): boolean => {
  if (filter === 'characters') return entry.hasCharacters;
  if (filter === 'moving') return entry.hasMoving;
  return entry.kinds.includes(filter);
};
const searchText = (entry: OverlayStoreEntry): string => [entry.name, entry.author, entry.description, ...LOOK_KINDS.flatMap((kind) => Object.values(entry.colors[kind] ?? {}))].join('\n').toLocaleLowerCase(locale.value);
const shown = computed(() => {
  const words = query.value.trim().toLocaleLowerCase(locale.value);
  return (view.value?.entries ?? []).filter((entry) => (words === '' || searchText(entry).includes(words)) && [...filters.value].every((filter) => matchesFilter(entry, filter)));
});
const noneTitle = computed(() => (query.value.trim() !== '' ? t('settingsHost.themes.browse.none.query', { query: query.value.trim() }) : t('settingsHost.themes.browse.none.filters')));

// Cards
const lookOf = (entry: OverlayStoreEntry, kind: LookKind): Look | undefined => {
  const colors = entry.colors[kind];
  if (!colors) return undefined;
  const thumbs = entry.thumbnails[kind] ?? [];
  if (thumbs.length === 0) return { colors };
  // the asset key is the app:// URL main supplied, which the miniature draws as it is
  return { colors, wallpapers: [{ panels: Object.fromEntries(thumbs.map((thumb) => [thumb.panel, { asset: thumb.url, fit: 'fill', ...DEFAULT_PANEL_LOOK }])) }] };
};
function themeOf(entry: OverlayStoreEntry): ThemeFile {
  const dark = lookOf(entry, 'dark');
  const light = lookOf(entry, 'light');
  return { schemaVersion: 1, id: entry.id, name: entry.name, looks: { ...(dark ? { dark } : {}), ...(light ? { light } : {}) } };
}
const thumbAsUrl = (asset: string): string => asset;
const looksKey = (entry: OverlayStoreEntry): 'both' | LookKind => (entry.kinds.includes('dark') && entry.kinds.includes('light') ? 'both' : entry.kinds.includes('dark') ? 'dark' : 'light');
const miniMode = (entry: OverlayStoreEntry): 'split' | LookKind => {
  const key = looksKey(entry);
  return key === 'both' ? 'split' : key;
};
const flagsOf = (entry: OverlayStoreEntry): { key: string; icon: typeof Code; text: string }[] => [
  ...(entry.hasCss ? [{ key: 'css', icon: Code, text: t('settingsHost.themes.browse.flag.css') }] : []),
  ...(entry.hasLayout ? [{ key: 'layout', icon: LayoutDashboard, text: t('settingsHost.themes.browse.flag.layout') }] : []),
  ...(entry.hasCharacters ? [{ key: 'characters', icon: Ghost, text: t('settingsHost.themes.browse.flag.characters') }] : []),
  ...(entry.hasMoving ? [{ key: 'moving', icon: Film, text: t('settingsHost.themes.browse.flag.moving') }] : []),
];
const licensesOf = (entry: OverlayStoreEntry): string => entry.licenses.join(' · ');
function install(entry: OverlayStoreEntry): void {
  if (props.installing !== undefined || entry.status === 'needsNewerApp' || entry.status === 'installed') return;
  emit('install', entry.id);
}
</script>

<template>
  <div
    class="flex flex-col gap-2"
    data-testid="theme-browse"
    :data-state="state"
  >
    <p
      v-if="failure && view"
      class="sm-feedback sm-feedback-error"
      role="alert"
      data-testid="theme-browse-error"
    >
      {{ failure }}
    </p>
    <template v-if="listed">
      <div class="flex flex-wrap items-center gap-2">
        <label
          class="relative flex min-w-0 flex-[1_1_14rem] items-center"
          :for="`${uid}-search`"
        >
          <Search
            class="pointer-events-none absolute inset-s-2.5 size-3.5 text-(--d-faint-text)"
            aria-hidden="true"
          />
          <span class="sr-only">{{ t('settingsHost.themes.browse.search') }}</span>
          <Input
            :id="`${uid}-search`"
            v-model="query"
            type="search"
            class="h-8 ps-8 text-12.5"
            autocomplete="off"
            :placeholder="t('settingsHost.themes.browse.searchPlaceholder')"
          />
        </label>
        <div
          class="flex flex-wrap gap-1"
          role="group"
          :aria-label="t('settingsHost.themes.browse.filters')"
        >
          <button
            v-for="filter in FILTERS"
            :key="filter"
            type="button"
            class="rounded-full border px-2 py-0.5 text-11 focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
            :class="filters.has(filter) ? 'border-(--d-accent-fill) bg-(--d-accent-soft) text-(--d-accent-text)' : 'border-(--d-border2) text-(--d-muted) hover:border-(--d-accent-fill)'"
            :aria-pressed="filters.has(filter)"
            @click="toggle(filter)"
          >
            {{ t(`settingsHost.themes.browse.filter.${filter}`) }}
          </button>
        </div>
        <div
          v-if="state === 'ok'"
          class="flex basis-full flex-wrap items-center gap-2 text-11 text-(--d-faint-text)"
          data-testid="theme-browse-checked"
        >
          <ShieldCheck
            class="size-3.5"
            aria-hidden="true"
          />
          <span>{{ t('settingsHost.themes.browse.checked', { time: fetchedText }) }}</span>
          <button
            type="button"
            class="sm-button"
            :disabled="refreshing"
            :aria-busy="refreshing || undefined"
            @click="load(true)"
          >
            <RefreshCw
              class="size-3"
              :class="refreshing ? 'd-spinning' : ''"
              aria-hidden="true"
            />{{ t('settingsHost.themes.browse.checkUpdates') }}
          </button>
        </div>
      </div>
      <div
        v-if="state === 'cached'"
        class="sm-banner sm-banner-warning"
        role="status"
        data-testid="theme-browse-cached"
      >
        <TriangleAlert
          class="size-4 flex-none text-(--d-warning-text)"
          aria-hidden="true"
        />
        <span class="sm-banner-text wrap-anywhere"><strong>{{ t('settingsHost.themes.browse.cached.title') }}</strong> <span data-testid="theme-browse-cached-reason">{{ view?.refusedReason }}</span> {{ t('settingsHost.themes.browse.cached.body', { time: fetchedText }) }}</span>
        <button
          type="button"
          class="sm-button"
          :disabled="refreshing"
          :aria-busy="refreshing || undefined"
          @click="load(true)"
        >
          <RefreshCw
            class="size-3"
            aria-hidden="true"
          />{{ t('settingsHost.themes.browse.tryAgain') }}
        </button>
      </div>
      <div
        v-show="shown.length > 0"
        class="grid grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] gap-3"
        role="list"
        :aria-label="t('settingsHost.themes.browse.grid')"
        :aria-busy="refreshing || undefined"
      >
        <article
          v-for="(entry, index) in shown"
          :key="entry.id"
          role="listitem"
          class="flex min-w-0 flex-col gap-1.5 rounded-11 border border-(--d-border) bg-(--d-panel) p-1.5 [content-visibility:auto] [contain-intrinsic-size:auto_17rem]"
          :aria-labelledby="`${uid}-name-${index}`"
          data-testid="theme-browse-entry"
          :data-status="entry.status"
        >
          <ThemeMiniature
            :theme="themeOf(entry)"
            :mode="miniMode(entry)"
            :thumbs="thumbAsUrl"
            :label="t(`settingsHost.themes.miniature.${looksKey(entry)}`, { name: entry.name })"
          />
          <div class="flex min-w-0 items-center gap-1.5 px-1">
            <h3
              :id="`${uid}-name-${index}`"
              class="min-w-0 flex-1 truncate text-13 font-semibold"
              :title="entry.name"
            >
              <bdi>{{ entry.name }}</bdi>
            </h3>
            <span
              v-if="entry.status === 'update'"
              class="d-tone-info flex-none rounded-full bg-(--tone)/15 px-1.5 text-10.5 font-semibold"
            >{{ t('settingsHost.themes.browse.updateBadge', { version: entry.version }) }}</span>
          </div>
          <p class="px-1 text-11 text-(--d-faint-text) wrap-anywhere">
            {{ t('settingsHost.themes.browse.by', { author: entry.author, looks: t(`settingsHost.themes.browse.looks.${looksKey(entry)}`) }) }}
          </p>
          <p
            v-if="entry.description"
            class="line-clamp-2 px-1 text-12 text-(--d-muted) wrap-anywhere"
          >
            {{ entry.description }}
          </p>
          <div
            v-if="flagsOf(entry).length > 0"
            class="flex flex-wrap gap-1 px-1"
          >
            <span
              v-for="flag in flagsOf(entry)"
              :key="flag.key"
              class="inline-flex items-center gap-1 rounded-full border border-(--d-border) px-1.5 text-10.5 text-(--d-muted)"
            >
              <component
                :is="flag.icon"
                class="size-3"
                aria-hidden="true"
              />{{ flag.text }}
            </span>
          </div>
          <div class="mt-auto flex flex-wrap items-center gap-1.5 px-1 pb-1">
            <span
              class="min-w-0 flex-1 truncate text-11 text-(--d-faint-text)"
              :title="licensesOf(entry)"
            >{{ licensesOf(entry) }}</span>
            <span
              v-if="entry.status === 'installed'"
              class="d-tone-success inline-flex items-center gap-1 rounded-full bg-(--tone)/15 px-2 py-0.5 text-11 font-semibold"
              data-testid="theme-browse-installed"
            >
              <Check
                class="size-3"
                aria-hidden="true"
              />{{ t('settingsHost.themes.browse.installed') }}
            </span>
            <template v-else-if="entry.status === 'needsNewerApp'">
              <button
                type="button"
                class="sm-button"
                aria-disabled="true"
                :aria-describedby="`${uid}-newer-${index}`"
                :title="t('settingsHost.themes.browse.needsNewerHint', { version: entry.minAppVersion })"
                data-testid="theme-browse-needs-newer"
              >
                {{ t('settingsHost.themes.browse.needsNewer') }}
              </button>
              <span
                :id="`${uid}-newer-${index}`"
                class="sr-only"
              >{{ t('settingsHost.themes.browse.needsNewerHint', { version: entry.minAppVersion }) }}</span>
            </template>
            <button
              v-else-if="installing === entry.id"
              type="button"
              class="sm-button"
              :aria-label="t('settingsHost.themes.browse.cancelDownloadNamed', { name: entry.name })"
              data-testid="theme-browse-cancel"
              @click="emit('cancelInstall')"
            >
              <RefreshCw
                class="size-3 d-spinning"
                aria-hidden="true"
              />{{ t('settingsHost.themes.browse.cancelDownload') }}
            </button>
            <button
              v-else
              type="button"
              class="sm-button"
              :class="entry.status === 'available' ? 'sm-button-primary' : ''"
              aria-haspopup="dialog"
              :aria-label="t(`settingsHost.themes.browse.${entry.status === 'update' ? 'updateNamed' : 'installNamed'}`, { name: entry.name })"
              :aria-disabled="installing !== undefined ? 'true' : undefined"
              :aria-describedby="installing !== undefined ? `${uid}-install-busy` : undefined"
              @click="install(entry)"
            >
              {{ t(`settingsHost.themes.browse.${entry.status === 'update' ? 'update' : 'install'}`) }}
            </button>
          </div>
        </article>
      </div>
      <p
        v-if="installing !== undefined"
        :id="`${uid}-install-busy`"
        class="sr-only"
      >
        {{ t('settingsHost.themes.browse.installBusy') }}
      </p>
      <div
        v-if="view?.entries.length === 0"
        class="flex flex-col items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-4 py-8 text-center"
        data-testid="theme-browse-empty"
      >
        <Store
          class="size-6 text-(--d-faint-text)"
          aria-hidden="true"
        />
        <h3 class="text-13 font-semibold">
          {{ t('settingsHost.themes.browse.empty.title') }}
        </h3>
        <p class="max-w-md text-12 text-(--d-muted)">
          {{ t('settingsHost.themes.browse.empty.body') }}
        </p>
      </div>
      <div
        v-else-if="shown.length === 0"
        class="flex flex-col items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-4 py-8 text-center"
        data-testid="theme-browse-none"
      >
        <Search
          class="size-6 text-(--d-faint-text)"
          aria-hidden="true"
        />
        <h3 class="text-13 font-semibold wrap-anywhere">
          {{ noneTitle }}
        </h3>
        <p class="max-w-md text-12 text-(--d-muted)">
          {{ t('settingsHost.themes.browse.none.body') }}
        </p>
        <button
          type="button"
          class="sm-button"
          @click="clearSearch"
        >
          {{ t('settingsHost.themes.browse.none.clear') }}
        </button>
      </div>
    </template>

    <div
      v-else-if="loading"
      class="grid grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] gap-3"
      aria-busy="true"
      :aria-label="t('settingsHost.themes.browse.loading')"
      data-testid="theme-browse-loading"
    >
      <div
        v-for="n in SKELETONS"
        :key="n"
        class="flex flex-col gap-2 rounded-11 border border-(--d-border) bg-(--d-panel) p-1.5"
        aria-hidden="true"
      >
        <span class="aspect-16/10 rounded-8 bg-(--d-hover) d-pulsing" />
        <span class="h-3 w-1/2 rounded-6 bg-(--d-hover) d-pulsing" />
        <span class="h-2.5 w-4/5 rounded-6 bg-(--d-hover) d-pulsing" />
        <span class="h-6.5 w-1/3 rounded-6 bg-(--d-hover) d-pulsing" />
      </div>
      <p
        class="sr-only"
        role="status"
      >
        {{ t('settingsHost.themes.browse.loadingStatus') }}
      </p>
    </div>

    <div
      v-else-if="state === 'refused'"
      class="flex flex-col items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-4 py-8 text-center"
      role="alert"
      data-testid="theme-browse-refused"
    >
      <ShieldAlert
        class="size-6 text-(--d-danger-text)"
        aria-hidden="true"
      />
      <h3 class="text-13 font-semibold">
        {{ t('settingsHost.themes.browse.refused.title') }}
      </h3>
      <p
        class="max-w-md text-12 font-medium text-(--d-danger-text) wrap-anywhere"
        data-testid="theme-browse-refused-reason"
      >
        {{ view?.refusedReason }}
      </p>
      <p class="max-w-md text-12 text-(--d-muted)">
        {{ t('settingsHost.themes.browse.refused.body') }}
      </p>
      <button
        type="button"
        class="sm-button"
        @click="load(true)"
      >
        <RefreshCw
          class="size-3"
          aria-hidden="true"
        />{{ t('settingsHost.themes.browse.tryAgain') }}
      </button>
    </div>

    <div
      v-else-if="state === 'unreachable'"
      class="flex flex-col items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-4 py-8 text-center"
      role="status"
      data-testid="theme-browse-unreachable"
    >
      <TriangleAlert
        class="size-6 text-(--d-warning-text)"
        aria-hidden="true"
      />
      <h3 class="text-13 font-semibold">
        {{ t('settingsHost.themes.browse.unreachable.title') }}
      </h3>
      <p
        class="max-w-md text-12 text-(--d-muted) wrap-anywhere"
        data-testid="theme-browse-unreachable-reason"
      >
        {{ view?.refusedReason }}
      </p>
      <p class="max-w-md text-12 text-(--d-muted)">
        {{ t('settingsHost.themes.browse.unreachable.body') }}
      </p>
      <button
        type="button"
        class="sm-button"
        @click="load(true)"
      >
        <RefreshCw
          class="size-3"
          aria-hidden="true"
        />{{ t('settingsHost.themes.browse.tryAgain') }}
      </button>
    </div>

    <div
      v-else-if="state === 'off'"
      class="flex flex-col items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-4 py-8 text-center"
      data-testid="theme-browse-off"
    >
      <Store
        class="size-6 text-(--d-faint-text)"
        aria-hidden="true"
      />
      <h3 class="text-13 font-semibold">
        {{ t('settingsHost.themes.browse.off.title') }}
      </h3>
      <p class="max-w-md text-12 text-(--d-muted)">
        {{ t('settingsHost.themes.browse.off.body') }}
      </p>
      <div class="flex flex-wrap justify-center gap-1.5">
        <button
          type="button"
          class="sm-button sm-button-primary"
          @click="prefs.set(THEMES_STORE_SETTING, true)"
        >
          {{ t('settingsHost.themes.browse.off.turnOn') }}
        </button>
        <button
          type="button"
          class="sm-button"
          aria-haspopup="dialog"
          @click="emit('installFromLink')"
        >
          <Link
            class="size-3"
            aria-hidden="true"
          />{{ t('settingsHost.themes.link.open') }}
        </button>
      </div>
    </div>

    <div
      v-else-if="state === 'empty'"
      class="flex flex-col items-center gap-2 rounded-11 border border-dashed border-(--d-border2) px-4 py-8 text-center"
      data-testid="theme-browse-empty"
    >
      <Store
        class="size-6 text-(--d-faint-text)"
        aria-hidden="true"
      />
      <h3 class="text-13 font-semibold">
        {{ t('settingsHost.themes.browse.empty.title') }}
      </h3>
      <p class="max-w-md text-12 text-(--d-muted)">
        {{ t('settingsHost.themes.browse.empty.body') }}
      </p>
      <button
        type="button"
        class="sm-button"
        @click="load(true)"
      >
        <RefreshCw
          class="size-3"
          aria-hidden="true"
        />{{ t('settingsHost.themes.browse.checkUpdates') }}
      </button>
    </div>

    <div
      v-else-if="state === 'failed'"
      class="flex flex-col items-start gap-2"
    >
      <p
        class="sm-feedback sm-feedback-error"
        role="alert"
        data-testid="theme-browse-error"
      >
        {{ failure }}
      </p>
      <button
        type="button"
        class="sm-button"
        @click="load(false)"
      >
        <RefreshCw
          class="size-3"
          aria-hidden="true"
        />{{ t('settingsHost.themes.browse.tryAgain') }}
      </button>
    </div>
  </div>
</template>
