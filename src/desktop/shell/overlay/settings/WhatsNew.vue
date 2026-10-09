<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { ChevronRight } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useSettingsTarget } from '@/components/settings/settings-view';
import { remPx } from '@/composables/useRemPx';
import type { ReleaseIndex, ReleaseIndexEntry } from '../../../preload/updates';
import { useDesktopPrefs } from './desktop-prefs';
import ReleaseNotes from './ReleaseNotes.vue';

// rem: a version row's fixed height (.whats-new-button), and an open notes panel's height until it is measured.
const ROW_REM = 2.375;
const NOTES_ESTIMATE_REM = 7.5;

const props = defineProps<{
  // the update main offers (ready, or available on macOS), listed first with the feed's notes
  pending: { readonly version: string; readonly notes: string } | null;
}>();

// Main logs why a read failed; the renderer only says that it did.
type Notes = { readonly status: 'loading' } | { readonly status: 'ready'; readonly markdown: string } | { readonly status: 'failed' };

const { t, locale } = useI18n();
const { api } = useDesktopPrefs();
const target = useSettingsTarget();

const index = shallowRef<ReleaseIndex | null>(null);
const indexFailed = ref(false);
const notes = shallowRef<ReadonlyMap<string, Notes>>(new Map());
const expanded = shallowRef<ReadonlySet<string>>(new Set());
// Each open notes panel's measured height in px; a version's virtual item is its fixed row plus that panel.
const heights = shallowRef<ReadonlyMap<string, number>>(new Map());
const box = ref<HTMLElement | null>(null);

const versions = computed<readonly ReleaseIndexEntry[]>(() => {
  const listed = index.value?.versions ?? [];
  const update = props.pending;
  return update && !listed.some((entry) => entry.version === update.version) ? [{ version: update.version, date: '' }, ...listed] : listed;
});
const noteOf = (version: string): Notes | undefined => (version === props.pending?.version
  ? { status: 'ready', markdown: props.pending.notes }
  : notes.value.get(version));

function itemHeight(at: number): number {
  const version = versions.value[at]?.version;
  const row = remPx(ROW_REM);
  if (version === undefined || !expanded.value.has(version)) return row;
  return row + (heights.value.get(version) ?? remPx(NOTES_ESTIMATE_REM));
}

const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(versions, { itemHeight, overscan: 6 });
const rows = computed(() => list.value.map(({ data, index: position }) => ({ entry: data, position, note: noteOf(data.version) })));

const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeZone: 'UTC' }));
function formatDate(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return dateFormat.value.format(Date.UTC(year, month - 1, day));
}

async function load(version: string): Promise<void> {
  if (version === props.pending?.version) return;
  const known = notes.value.get(version);
  if (known && known.status !== 'failed') return;
  notes.value = new Map(notes.value).set(version, { status: 'loading' });
  let next: Notes;
  try {
    next = { status: 'ready', markdown: (await api.getReleaseNotes(version)).markdown };
  } catch {
    next = { status: 'failed' };
  }
  notes.value = new Map(notes.value).set(version, next);
}

function setOpen(version: string, open: boolean): void {
  if (expanded.value.has(version) === open) return;
  const next = new Set(expanded.value);
  if (open) next.add(version);
  else next.delete(version);
  expanded.value = next;
  if (open) void load(version);
}

const positionOf = (version: string): number => versions.value.findIndex((entry) => entry.version === version);

// A requested release (Help › Release Notes, "See what's new") opens and scrolls into view.
async function reveal(version: string): Promise<void> {
  if (positionOf(version) < 0) return;
  setOpen(version, true);
  await nextTick();
  scrollTo(positionOf(version));
}

const panels = new Map<Element, string>();
const resize = new ResizeObserver((entries) => {
  let next: Map<string, number> | undefined;
  for (const entry of entries) {
    const version = panels.get(entry.target);
    const height = (entry.target as HTMLElement).offsetHeight;
    if (version === undefined || heights.value.get(version) === height) continue;
    next ??= new Map(heights.value);
    next.set(version, height);
  }
  if (!next) return;
  heights.value = next;
  // A height change moves every later item; the range is recomputed as a scroll would.
  containerProps.onScroll();
});

function measure(version: string, element: Element | ComponentPublicInstance | null): void {
  for (const [known, value] of panels) {
    if (value !== version || known === element) continue;
    resize.unobserve(known);
    panels.delete(known);
  }
  if (!(element instanceof Element) || panels.has(element)) return;
  panels.set(element, version);
  resize.observe(element);
}

onBeforeUnmount(() => resize.disconnect());

// Opening or closing a version changes its item's height but not the list, which is all useVirtualList watches.
watch(expanded, () => containerProps.onScroll(), { flush: 'post' });

// Arrow keys, Home and End move between version rows; a row off screen is scrolled in before it takes focus.
async function focusRow(position: number): Promise<void> {
  const count = versions.value.length;
  if (count === 0) return;
  const wrapped = (position + count) % count;
  const version = versions.value[wrapped]!.version;
  const find = (): HTMLElement | null => box.value?.querySelector<HTMLElement>(`[data-version-row="${CSS.escape(version)}"]`) ?? null;
  if (!find()) {
    scrollTo(wrapped);
    await nextTick();
    await nextTick();
  }
  find()?.focus();
}

function onKeydown(event: KeyboardEvent, position: number): void {
  const moves: Record<string, number | undefined> = {
    ArrowDown: position + 1,
    ArrowUp: position - 1,
    Home: 0,
    End: versions.value.length - 1,
  };
  const next = moves[event.key];
  if (next === undefined) return;
  event.preventDefault();
  void focusRow(next);
}

void api.getReleaseIndex().then(async (loaded) => {
  index.value = loaded;
  setOpen(loaded.current, true);
  const requested = target.value?.release;
  if (requested !== undefined) await reveal(requested);
}, () => {
  indexFailed.value = true;
});

// An update main offers opens at the top of the list.
watch(() => props.pending?.version, (version) => {
  if (version === undefined) return;
  setOpen(version, true);
  scrollTo(0);
}, { immediate: true });

watch(() => target.value?.release, (release) => {
  if (release !== undefined && index.value) void reveal(release);
});
</script>

<template>
  <div
    ref="box"
    class="whats-new"
    data-testid="whats-new"
  >
    <p
      v-if="indexFailed"
      class="whats-new-message whats-new-failed px-3.5 py-3"
      role="alert"
      data-testid="whats-new-failed"
    >
      {{ t('settingsHost.whatsNew.listFailed') }}
    </p>
    <div
      v-bind="containerProps"
      class="whats-new-scroll"
    >
      <div
        v-bind="wrapperProps"
        role="list"
        :aria-label="t('settingsHost.whatsNew.listLabel')"
      >
        <Collapsible
          v-for="{ entry, position, note } in rows"
          :key="entry.version"
          role="listitem"
          class="whats-new-item"
          :open="expanded.has(entry.version)"
          @update:open="(open: boolean) => setOpen(entry.version, open)"
        >
          <CollapsibleTrigger
            class="whats-new-button"
            data-testid="whats-new-row"
            :data-version-row="entry.version"
            @keydown="onKeydown($event, position)"
          >
            <ChevronRight
              aria-hidden="true"
              class="whats-new-chevron size-3.5"
            />
            <span class="whats-new-version">{{ entry.version }}</span>
            <Badge
              v-if="entry.version === index?.current"
              variant="tone"
              class="whats-new-chip d-tone-accent"
              data-testid="whats-new-current"
            >
              {{ t('settingsHost.whatsNew.current') }}
            </Badge>
            <Badge
              v-else-if="entry.version === pending?.version"
              variant="tone"
              class="whats-new-chip d-tone-success"
              data-testid="whats-new-update"
            >
              {{ t('settingsHost.whatsNew.update') }}
            </Badge>
            <time
              v-if="entry.date"
              class="whats-new-date"
              :datetime="entry.date"
            >{{ formatDate(entry.date) }}</time>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div
              :ref="(element) => measure(entry.version, element)"
              class="whats-new-notes"
              data-testid="whats-new-notes"
              :data-version="entry.version"
            >
              <template v-if="note?.status === 'ready'">
                <ReleaseNotes
                  v-if="note.markdown.trim()"
                  :source="note.markdown"
                />
                <p
                  v-else
                  class="whats-new-message"
                >
                  {{ t('settingsHost.whatsNew.empty') }}
                </p>
              </template>
              <p
                v-else-if="note?.status === 'failed'"
                class="whats-new-message whats-new-failed"
                role="alert"
              >
                {{ t('settingsHost.whatsNew.failed') }}
              </p>
              <div
                v-else
                class="whats-new-skeleton"
                role="status"
                data-testid="whats-new-skeleton"
                :aria-label="t('settingsHost.whatsNew.loading', { version: entry.version })"
              >
                <span class="w-[22%]" />
                <span class="w-[94%]" />
                <span class="w-[86%]" />
                <span class="w-[58%]" />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  </div>
</template>
