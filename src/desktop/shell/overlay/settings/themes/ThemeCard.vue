<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, Check, Copy, Download, Eye, Info, Lock, Moon, MoreHorizontal, Pencil, Sun, Trash2, Type } from 'lucide-vue-next';
import ThemeMiniature from '@/components/theme/ThemeMiniature.vue';
import { IsolatedText } from '@/components/isolated-text';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_CONTENT, MENU_ITEM } from '@/components/chat-header/menuStyles';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import { LOOK_KINDS, type LookKind } from '@shared/themes/tokens';
import type { OverlayThemeEntry } from '../../../../preload/overlay-channels';
import { looksText, miniatureLabel, originText, pickName } from './theme-text';

export interface CardPick {
  // the preferred look of this kind
  readonly checked: boolean;
  // the look on screen now
  readonly showing: boolean;
  // the one pick of its group that Tab reaches
  readonly tabbable: boolean;
}

// view: a built-in theme in the editor, read-only
// update: a store theme whose entry has another version, through the install dialog
export type CardAction = 'view' | 'edit' | 'duplicate' | 'rename' | 'export' | 'delete' | 'showFile' | 'update';

const props = defineProps<{
  entry: OverlayThemeEntry;
  // names this card's picks in element ids; the gallery's radio groups own them by those ids
  domKey: string;
  picks: Readonly<Record<LookKind, CardPick>>;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: 'pick', kind: LookKind): void;
  (e: 'pickKey', kind: LookKind, event: KeyboardEvent): void;
  (e: 'action', action: CardAction): void;
}>();

const { t } = useI18n();
const name = computed(() => props.entry.name ?? props.entry.id);
const ok = computed(() => (props.entry.status === 'ok' ? props.entry : undefined));
const showing = computed(() => LOOK_KINDS.some((kind) => props.picks[kind].showing));
const nameId = useId();
const hasLook = (kind: LookKind): boolean => ok.value?.theme.looks[kind] !== undefined;
const miniMode = computed(() => {
  const theme = ok.value?.theme;
  return theme?.looks.dark && theme.looks.light ? 'split' : theme?.looks.dark ? 'dark' : 'light';
});
const origin = computed(() => (ok.value ? `${originText(t, ok.value.theme, ok.value.builtin, ok.value.fromName)} · ${looksText(t, ok.value.theme)}` : ''));
const pickLabel = (kind: LookKind): string => {
  const pick = props.picks[kind];
  return pickName(t, name.value, kind, pick.checked ? (pick.showing ? 'active' : 'selected') : undefined);
};
const pickId = (kind: LookKind): string => `theme-pick-${kind}-${props.domKey}`;
</script>

<template>
  <article
    class="flex min-w-0 flex-col gap-1.5 rounded-11 border bg-(--d-panel) p-1.5"
    :class="showing ? 'border-(--d-accent-fill) ring-1 ring-(--d-accent-fill)' : 'border-(--d-border)'"
    :aria-labelledby="nameId"
    :data-testid="`theme-card-${entry.id}`"
  >
    <div class="relative">
      <ThemeMiniature
        v-if="ok"
        :theme="ok.theme"
        :mode="miniMode"
        :label="miniatureLabel(t, name, ok.theme)"
      />
      <!-- a hatched placeholder: the file cannot be drawn -->
      <div
        v-else
        class="flex aspect-16/10 flex-col items-center justify-center gap-1 rounded-8 border border-dashed border-(--d-border2) bg-[repeating-linear-gradient(135deg,var(--d-panel)_0_0.375rem,var(--d-hover)_0.375rem_0.75rem)] p-3 text-center text-11"
        :class="entry.status === 'broken' ? 'text-(--d-danger-text)' : 'text-(--d-warning-text)'"
        :data-testid="`theme-card-placeholder-${entry.id}`"
      >
        <AlertTriangle
          v-if="entry.status === 'broken'"
          class="size-5"
          aria-hidden="true"
        />
        <Info
          v-else
          class="size-5"
          aria-hidden="true"
        />
        <strong>{{ entry.status === 'broken' ? t('settingsHost.themes.broken.title') : t('settingsHost.themes.newer.title') }}</strong>
        <span class="line-clamp-3 wrap-break-word">{{ entry.status === 'broken' ? entry.reason : entry.status === 'needsNewer' ? t('settingsHost.themes.newer.body', { version: entry.version }) : '' }}</span>
      </div>
      <span
        v-if="ok?.builtin"
        class="absolute inset-s-1 top-1 inline-flex items-center gap-1 rounded-5 border border-(--d-border) bg-(--d-card) px-1.5 text-10/4 text-(--d-text)"
      >
        <Lock
          class="size-3"
          aria-hidden="true"
        />
        {{ t('settingsHost.themes.builtIn') }}
      </span>
    </div>
    <div class="flex min-w-0 items-center gap-1.5 px-1">
      <h3
        :id="nameId"
        class="min-w-0 flex-1 truncate text-13 font-semibold"
        :title="name"
      >
        <bdi>{{ name }}</bdi>
      </h3>
      <span
        v-if="showing"
        class="d-tone-accent rounded-full bg-(--tone)/15 px-1.5 text-10.5 font-semibold"
        data-testid="theme-showing"
      >{{ t('settingsHost.themes.showing') }}</span>
    </div>
    <p
      v-if="origin"
      class="min-h-4.5 px-1 text-11 text-(--d-faint-text)"
    >
      <IsolatedText :text="origin" />
    </p>
    <div
      v-if="ok?.storeUpdate"
      class="mx-1 rounded-8 bg-(--d-info-fill)/10 px-2 py-1.5 text-11 text-(--d-info-text)"
      data-testid="theme-card-update"
    >
      {{ t('settingsHost.themes.store.update', { version: ok.storeUpdate.version }) }}
      <div class="mt-1.5 flex flex-wrap gap-1.5">
        <SettingButton
          aria-haspopup="dialog"
          :aria-label="t('settingsHost.themes.store.updateNamed', { name, version: ok.storeUpdate.version })"
          :disabled="busy"
          @click="emit('action', 'update')"
        >
          {{ t('settingsHost.themes.store.updateButton') }}
        </SettingButton>
      </div>
    </div>
    <div
      v-if="ok?.removedFromStore"
      class="mx-1 rounded-8 bg-(--d-danger-fill)/10 px-2 py-1.5 text-11 text-(--d-danger-text) wrap-anywhere"
      data-testid="theme-card-removed"
    >
      {{ t('settingsHost.themes.store.removed', { reason: ok.removedFromStore.reason }) }}
      <div class="mt-1.5 flex flex-wrap gap-1.5">
        <SettingButton
          variant="danger"
          :aria-label="t('settingsHost.themes.deleteNamed', { name })"
          :disabled="busy"
          @click="emit('action', 'delete')"
        >
          {{ t('settingsHost.themes.delete') }}
        </SettingButton>
      </div>
    </div>
    <div
      v-if="!ok"
      class="mx-1 rounded-8 bg-(--d-danger-fill)/10 px-2 py-1.5 text-11 text-(--d-danger-text)"
    >
      {{ entry.status === 'broken' ? t('settingsHost.themes.broken.note') : t('settingsHost.themes.newer.unusable') }}
      <div class="mt-1.5 flex flex-wrap gap-1.5">
        <!-- Show file and the menu's View only read, so they stay usable while a change is under way -->
        <SettingButton
          v-if="entry.status === 'broken'"
          :aria-label="t('settingsHost.themes.showFileNamed', { name })"
          @click="emit('action', 'showFile')"
        >
          {{ t('settingsHost.themes.broken.showFile') }}
        </SettingButton>
        <SettingButton
          variant="danger"
          :aria-label="t('settingsHost.themes.deleteNamed', { name })"
          :disabled="busy"
          @click="emit('action', 'delete')"
        >
          {{ t('settingsHost.themes.delete') }}
        </SettingButton>
      </div>
    </div>
    <div class="mt-auto grid grid-cols-[1fr_1fr_auto] gap-1 px-0.5 pb-0.5">
      <template
        v-for="kind in LOOK_KINDS"
        :key="kind"
      >
        <!-- One radio of the gallery's "Dark look" or "Light look" group, which owns it across cards (aria-owns), so no
             shadcn radio group can hold it. A theme that cannot be used keeps its picks, disabled. -->
        <button
          v-if="!ok || hasLook(kind)"
          :id="pickId(kind)"
          type="button"
          role="radio"
          class="inline-flex min-h-7 min-w-0 items-center justify-center gap-1 rounded-7 border px-1.5 text-12 focus-visible:outline-2 focus-visible:outline-(--d-accent-fill) aria-disabled:opacity-(--d-opacity-disabled)"
          :class="picks[kind].checked ? 'border-(--d-accent-fill) bg-(--d-accent-soft) font-semibold text-(--d-accent-text)' : 'border-(--d-border2) text-(--d-muted) hover:border-(--d-accent-fill)'"
          :aria-checked="picks[kind].checked"
          :aria-disabled="!ok ? 'true' : undefined"
          :aria-label="pickLabel(kind)"
          :title="!ok ? (entry.status === 'broken' ? t('settingsHost.themes.broken.unusable') : t('settingsHost.themes.newer.unusable')) : undefined"
          :tabindex="picks[kind].tabbable ? 0 : -1"
          @click="ok && emit('pick', kind)"
          @keydown="emit('pickKey', kind, $event)"
        >
          <Check
            v-if="picks[kind].checked"
            class="size-3"
            aria-hidden="true"
          />
          <component
            :is="kind === 'dark' ? Moon : Sun"
            v-else
            class="size-3"
            aria-hidden="true"
          />
          {{ t(`settingsHost.themes.lookName.${kind}`) }}
        </button>
        <span
          v-else
          class="inline-flex min-h-7 items-center justify-center rounded-7 border border-dashed border-(--d-border) text-11 text-(--d-faint-text)"
        >{{ t(`settingsHost.themes.noLook.${kind}`) }}</span>
      </template>
      <DropdownMenu>
        <DropdownMenuTrigger
          class="inline-flex size-7 items-center justify-center rounded-7 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill)"
          :aria-label="t('settingsHost.themes.more', { name })"
          :data-testid="`theme-more-${entry.id}`"
        >
          <MoreHorizontal
            class="size-4"
            aria-hidden="true"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          :class="MENU_CONTENT"
          :aria-label="t('settingsHost.themes.menu.label', { name })"
        >
          <DropdownMenuItem
            v-if="ok?.builtin"
            :class="MENU_ITEM"
            @select="emit('action', 'view')"
          >
            <Eye aria-hidden="true" />{{ t('settingsHost.themes.menu.view') }}
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="ok && !ok.builtin"
            :class="MENU_ITEM"
            :disabled="busy"
            @select="emit('action', 'edit')"
          >
            <Pencil aria-hidden="true" />{{ t('settingsHost.themes.menu.edit') }}
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="ok"
            :class="MENU_ITEM"
            :disabled="busy"
            @select="emit('action', 'duplicate')"
          >
            <Copy aria-hidden="true" />{{ ok.builtin ? t('settingsHost.themes.menu.duplicateBuiltin') : t('settingsHost.themes.menu.duplicate') }}
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="ok && !ok.builtin"
            :class="MENU_ITEM"
            :disabled="busy"
            @select="emit('action', 'rename')"
          >
            <Type aria-hidden="true" />{{ t('settingsHost.themes.menu.rename') }}
          </DropdownMenuItem>
          <DropdownMenuItem
            v-if="ok"
            :class="MENU_ITEM"
            :disabled="busy"
            @select="emit('action', 'export')"
          >
            <Download aria-hidden="true" />{{ t('settingsHost.themes.menu.export') }}
          </DropdownMenuItem>
          <template v-if="!ok || !ok.builtin">
            <DropdownMenuSeparator v-if="ok" />
            <DropdownMenuItem
              :class="[MENU_ITEM, 'text-(--d-danger-text) focus:text-(--d-danger-text) [&>svg]:text-(--d-danger-text)']"
              :disabled="busy"
              @select="emit('action', 'delete')"
            >
              <Trash2 aria-hidden="true" />{{ t('settingsHost.themes.menu.delete') }}
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </article>
</template>
