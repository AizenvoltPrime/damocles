<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowRight, Check, ChevronDown, FileUp, PackagePlus } from 'lucide-vue-next';
import SettingSlider from '@/components/settings/controls/SettingSlider.vue';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MAX_FONT_BYTES, type FontRole } from '@shared/themes/fonts';
import type { AssetMeta, FontChoice, ThemeFile } from '@shared/themes/schema';
import { CHAT_COLUMN_RANGE, DEFAULT_CHAT_COLUMN, DENSITY_RANGE, LINE_HEIGHT_RANGE, RADIUS_RANGE, type ThemeStyle } from '@shared/themes/style';
import type { DamoclesOverlayApi, ThemeEditorFontResult } from '../../../preload/overlay-channels';
import type { EditorImports } from './editor-imports';
import { useEditorFormat } from './format';
import { installedFamilies, installedFontFile } from './installed-fonts';
import { withFont, withStyle } from './type-edits';

// The editor's Type section (docs/themes.md "Style"): the UI and mono fonts, line spacing, corners, density and the chat
// column. Text size is the user's own setting, never the theme's. It unmounts when its tab hides, so a font being
// bundled, and what came of it, live in `imports`, which the editor owns.
const props = defineProps<{
  api: DamoclesOverlayApi;
  draft: ThemeFile;
  readOnly: boolean;
  imports: EditorImports;
}>();
const emit = defineEmits<{ update: [theme: ThemeFile] }>();

const { t } = useI18n();
const format = useEditorFormat();
const ROLES: readonly FontRole[] = ['ui', 'mono'];
const BUILTIN_NAME: Readonly<Record<FontRole, string>> = { ui: 'Geist', mono: 'Geist Mono' };
// The chat column slider's stop past CHAT_COLUMN_RANGE.max, which stands for the full width of the chat slot.
const FULL_STOP = CHAT_COLUMN_RANGE.max + 2;
// Most matches a font list draws; typing narrows the rest.
const MAX_LISTED = 200;
// Licenses a bundled font may be shared under without asking the user to judge.
const SHAREABLE = new Set(['OFL-1.1', 'Apache-2.0', 'LicenseRef-Ubuntu-Font-1.0']);

type FontOption =
  | { readonly key: string; readonly kind: 'builtin'; readonly name: string }
  | { readonly key: string; readonly kind: 'bundled'; readonly name: string; readonly sha256: string; readonly asset: AssetMeta }
  | { readonly key: string; readonly kind: 'installed'; readonly name: string };

const installed = ref<string[]>();
const installedError = ref(false);
const open = ref<FontRole>();
const search = ref('');
const busy = computed(() => props.imports.busy.font);
const failure = computed(() => props.imports.failure.type);

const style = computed<ThemeStyle>(() => props.draft.style ?? {});
const fonts = computed(() => style.value.fonts ?? {});

const bundledOptions = computed<FontOption[]>(() => Object.entries(props.draft.assets ?? {})
  .filter(([, asset]) => asset.kind === 'font' && asset.family !== undefined)
  .map(([sha256, asset]) => ({ key: `bundled:${sha256}`, kind: 'bundled', name: asset.family!, sha256, asset })));

const keyOf = (choice: FontChoice | undefined): string => (choice === undefined ? 'builtin' : 'installed' in choice ? `installed:${choice.installed}` : `bundled:${choice.asset}`);

function selected(role: FontRole): FontOption {
  const choice = fonts.value[role];
  if (choice === undefined) return { key: 'builtin', kind: 'builtin', name: BUILTIN_NAME[role] };
  if ('installed' in choice) return { key: keyOf(choice), kind: 'installed', name: choice.installed };
  return bundledOptions.value.find((option) => option.key === keyOf(choice)) ?? { key: keyOf(choice), kind: 'installed', name: choice.family };
}

function listed(role: FontRole): FontOption[] {
  const term = search.value.trim().toLowerCase();
  const matches = (name: string): boolean => term === '' || name.toLowerCase().includes(term);
  const fixed: FontOption[] = [{ key: 'builtin', kind: 'builtin', name: BUILTIN_NAME[role] }, ...bundledOptions.value];
  const current = selected(role);
  const families = installed.value ?? [];
  const others: FontOption[] = families.map((name) => ({ key: `installed:${name}`, kind: 'installed', name }));
  // an installed font the theme names stays listed when this computer lacks it
  if (current.kind === 'installed' && !families.includes(current.name)) others.unshift(current);
  return [...fixed.filter((option) => matches(option.name)), ...others.filter((option) => matches(option.name)).slice(0, MAX_LISTED)];
}

async function openList(role: FontRole, value: boolean): Promise<void> {
  open.value = value && !props.readOnly ? role : undefined;
  search.value = '';
  if (!value || installed.value !== undefined) return;
  try {
    installed.value = await installedFamilies();
    installedError.value = false;
  } catch {
    installed.value = [];
    installedError.value = true;
  }
}

const setFont = (role: FontRole, choice: FontChoice | undefined): void => emit('update', withFont(props.draft, role, choice));

function pick(role: FontRole, key: unknown): void {
  const option = listed(role).find((candidate) => candidate.key === key) ?? (selected(role).key === key ? selected(role) : undefined);
  open.value = undefined;
  if (!option) return;
  props.imports.clear('type');
  if (option.kind === 'builtin') setFont(role, undefined);
  else if (option.kind === 'bundled') setFont(role, { asset: option.sha256, family: option.name });
  else setFont(role, { installed: option.name });
}

// A font main stored becomes the role's font in the draft as it is when the answer comes.
function bundle(role: FontRole, request: (sessionId: number) => Promise<ThemeEditorFontResult>): void {
  void props.imports.importFont(role, request, (draft, font) => withFont(draft, role, { asset: font.sha256, family: font.family }, font));
}

function addFile(role: FontRole): void {
  open.value = undefined;
  const { api } = props;
  bundle(role, (sessionId) => api.themeEditor.importFontFile(sessionId));
}

function bundleInstalled(role: FontRole, family: string): void {
  const { api } = props;
  bundle(role, async (sessionId) => {
    const bytes = await installedFontFile(family);
    if (bytes === undefined) return { ok: false, error: t('themeEditor.type.notInstalled', { name: family }) };
    if (bytes === 'tooLarge') return { ok: false, error: t('themeEditor.type.tooLarge', { name: family, max: format.number(MAX_FONT_BYTES / 1024 / 1024) }) };
    return api.themeEditor.importFontBytes(sessionId, bytes);
  });
}

function note(role: FontRole): { readonly tags: readonly { readonly text: string; readonly tone?: 'success' | 'warning' }[]; readonly text: string } {
  const option = selected(role);
  if (option.kind === 'builtin') return { tags: [{ text: t('themeEditor.type.tags.builtin') }], text: t(`themeEditor.type.notes.builtin.${role}`) };
  if (option.kind === 'installed') return { tags: [{ text: t('themeEditor.type.tags.installed') }], text: t('themeEditor.type.notes.installed') };
  const spdx = option.asset.license.spdx;
  const shareable = spdx !== undefined && SHAREABLE.has(spdx);
  return {
    tags: [{ text: t('themeEditor.type.tags.bundled'), tone: 'success' }, shareable ? { text: spdx } : { text: t('themeEditor.type.tags.licenseUnknown'), tone: 'warning' }],
    text: shareable ? t('themeEditor.type.notes.bundledShareable') : t('themeEditor.type.notes.bundled'),
  };
}

// Sliders: a value equal to Damocles' own is left out of the file.
function setStyle(key: 'lineHeight' | 'radius' | 'density', value: number): void {
  const next: Record<string, unknown> = { ...style.value, [key]: Math.round(value * 100) / 100 };
  if (next[key] === 1) delete next[key];
  emit('update', withStyle(props.draft, next as ThemeStyle));
}
function setColumn(value: number): void {
  const next: Record<string, unknown> = { ...style.value, chatColumn: value > CHAT_COLUMN_RANGE.max ? 'full' : value };
  if (next['chatColumn'] === DEFAULT_CHAT_COLUMN) delete next['chatColumn'];
  emit('update', withStyle(props.draft, next as ThemeStyle));
}
const column = computed(() => (style.value.chatColumn === 'full' ? FULL_STOP : style.value.chatColumn ?? DEFAULT_CHAT_COLUMN));
const times = (value: number): string => t('themeEditor.units.times', { n: format.number(value, 2) });
const radiusText = (value: number): string => (value === 0 ? t('themeEditor.type.square') : times(value));
const densityText = (value: number): string => format.percent(Math.round(value * 100) / 100);
const columnText = (value: number): string => (value > CHAT_COLUMN_RANGE.max ? t('themeEditor.type.fullWidth') : t('themeEditor.units.value', { n: format.number(value), unit: 'rem' }));
</script>

<template>
  <div class="flex flex-col gap-4">
    <div
      v-for="role in ROLES"
      :key="role"
      class="flex flex-col gap-1.5"
    >
      <span
        :id="`theme-type-${role}-label`"
        class="text-12 font-medium"
      >{{ t(`themeEditor.type.font.${role}`) }}</span>
      <Popover
        :open="open === role"
        @update:open="(value: boolean) => openList(role, value)"
      >
        <PopoverTrigger as-child>
          <!-- a combobox trigger; reka's Select would need every installed font rendered as an item up front -->
          <button
            :id="`theme-type-${role}-font`"
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            :aria-expanded="open === role"
            :aria-labelledby="`theme-type-${role}-label theme-type-${role}-value`"
            :aria-controls="open === role ? `theme-type-${role}-list` : undefined"
            :disabled="readOnly || busy !== undefined"
            class="flex h-8 w-full items-center gap-2 rounded-7 border border-(--d-border2) bg-(--d-input) px-2.5 text-start text-12.5 hover:bg-(--d-hover) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill) disabled:opacity-(--d-opacity-disabled)"
            :data-testid="`theme-type-${role}-font`"
          >
            <span
              :id="`theme-type-${role}-value`"
              class="min-w-0 flex-1 truncate"
            >{{ selected(role).name }}</span>
            <ChevronDown
              class="size-3.5 flex-none text-(--d-muted)"
              aria-hidden="true"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          class="w-(--reka-popover-trigger-width) min-w-60 p-0"
        >
          <Command
            :model-value="selected(role).key"
            @update:model-value="(key: unknown) => pick(role, key)"
          >
            <CommandInput
              v-model="search"
              :aria-label="t(`themeEditor.type.search.${role}`)"
              :placeholder="t('themeEditor.type.searchPlaceholder')"
              class="h-8 text-12"
            />
            <CommandList
              :id="`theme-type-${role}-list`"
              :aria-label="t(`themeEditor.type.list.${role}`)"
              class="max-h-64"
            >
              <CommandEmpty class="py-3 text-center text-12 text-(--d-muted)">
                {{ t('themeEditor.type.noMatch') }}
              </CommandEmpty>
              <CommandGroup>
                <CommandItem
                  v-for="option in listed(role)"
                  :key="option.key"
                  :value="option.key"
                  class="flex items-center gap-2 text-12"
                >
                  <Check
                    class="size-3.5 flex-none"
                    :class="option.key === selected(role).key ? 'opacity-100' : 'opacity-0'"
                    aria-hidden="true"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ option.name }}</span>
                  <span class="flex-none text-10.5 text-(--d-muted)">{{ t(`themeEditor.type.tags.${option.kind}`) }}</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
            <!-- Damocles' own font is always listed, so this is its own line, never the empty state -->
            <p
              v-if="installedError"
              class="px-3 py-2 text-11 text-(--d-muted)"
              role="note"
              data-testid="theme-type-installed-unavailable"
            >
              {{ t('themeEditor.type.installedUnavailable') }}
            </p>
            <CommandSeparator />
            <div class="p-1">
              <button
                type="button"
                class="sm-button w-full justify-start"
                @click="addFile(role)"
              >
                <FileUp
                  class="size-3"
                  aria-hidden="true"
                />{{ t('themeEditor.type.addFile') }}
              </button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
      <p
        class="flex flex-wrap items-center gap-1.5 text-11 text-(--d-muted)"
        aria-live="polite"
        :data-testid="`theme-type-${role}-note`"
      >
        <span
          v-for="tag in note(role).tags"
          :key="tag.text"
          class="rounded-full px-1.5 text-10.5"
          :class="tag.tone === 'success' ? 'bg-(--d-success-fill)/15 text-(--d-success-text)' : tag.tone === 'warning' ? 'bg-(--d-warning-fill)/15 text-(--d-warning-text)' : 'bg-(--d-hover) text-(--d-muted)'"
        >{{ tag.text }}</span>
        <span>{{ note(role).text }}</span>
      </p>
      <button
        v-if="selected(role).kind === 'installed' && !readOnly"
        type="button"
        class="sm-button self-start"
        :disabled="busy !== undefined"
        @click="bundleInstalled(role, selected(role).name)"
      >
        <PackagePlus
          class="size-3"
          aria-hidden="true"
        />{{ busy === role ? t('themeEditor.type.bundling') : t('themeEditor.type.bundle') }}
      </button>
      <p
        v-if="failure?.role === role"
        class="text-11 text-(--d-danger-text)"
        role="alert"
      >
        {{ failure.text }}
      </p>
    </div>

    <div class="flex flex-col gap-1">
      <span class="text-12 font-medium">{{ t('themeEditor.type.lineSpacing') }}</span>
      <SettingSlider
        :model-value="style.lineHeight ?? 1"
        :min="LINE_HEIGHT_RANGE.min"
        :max="LINE_HEIGHT_RANGE.max"
        :step="0.05"
        :label="t('themeEditor.type.lineSpacing')"
        :format="times"
        :disabled="readOnly"
        live
        @update:model-value="(value: number) => setStyle('lineHeight', value)"
      />
      <div
        class="flex justify-between text-10.5 text-(--d-faint-text)"
        aria-hidden="true"
      >
        <span>{{ times(LINE_HEIGHT_RANGE.min) }}</span><span>{{ times(LINE_HEIGHT_RANGE.max) }}</span>
      </div>
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-12 font-medium">{{ t('themeEditor.type.radius') }}</span>
      <SettingSlider
        :model-value="style.radius ?? 1"
        :min="RADIUS_RANGE.min"
        :max="RADIUS_RANGE.max"
        :step="0.1"
        :label="t('themeEditor.type.radius')"
        :format="radiusText"
        :disabled="readOnly"
        live
        @update:model-value="(value: number) => setStyle('radius', value)"
      />
      <div
        class="flex justify-between text-10.5 text-(--d-faint-text)"
        aria-hidden="true"
      >
        <span>{{ t('themeEditor.type.square') }}</span><span>{{ times(RADIUS_RANGE.max) }}</span>
      </div>
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-12 font-medium">{{ t('themeEditor.type.density') }}</span>
      <SettingSlider
        :model-value="style.density ?? 1"
        :min="DENSITY_RANGE.min"
        :max="DENSITY_RANGE.max"
        :step="0.05"
        :label="t('themeEditor.type.density')"
        :format="densityText"
        :disabled="readOnly"
        live
        @update:model-value="(value: number) => setStyle('density', value)"
      />
      <div
        class="flex justify-between text-10.5 text-(--d-faint-text)"
        aria-hidden="true"
      >
        <span>{{ t('themeEditor.type.compact') }}</span><span>{{ t('themeEditor.type.roomy') }}</span>
      </div>
      <p class="text-11 text-(--d-muted)">
        {{ t('themeEditor.type.densityNote') }}
      </p>
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-12 font-medium">{{ t('themeEditor.type.chatColumn') }}</span>
      <SettingSlider
        :model-value="column"
        :min="CHAT_COLUMN_RANGE.min"
        :max="FULL_STOP"
        :step="2"
        :label="t('themeEditor.type.chatColumn')"
        :format="columnText"
        :disabled="readOnly"
        live
        @update:model-value="setColumn"
      />
      <div
        class="flex justify-between text-10.5 text-(--d-faint-text)"
        aria-hidden="true"
      >
        <span>{{ columnText(CHAT_COLUMN_RANGE.min) }}</span><span>{{ t('themeEditor.type.fullWidth') }}</span>
      </div>
      <p class="text-11 text-(--d-muted)">
        {{ t('themeEditor.type.chatColumnNote') }}
      </p>
    </div>

    <div class="sm-banner">
      <ArrowRight
        class="size-4"
        aria-hidden="true"
      />
      <span class="sm-banner-text">
        {{ t('themeEditor.type.textSizeNote') }}
        <button
          type="button"
          class="text-(--d-accent) underline underline-offset-2"
          @click="api.themeEditor.openSettings()"
        >{{ t('themeEditor.type.textSizeLink') }}</button>.
      </span>
    </div>
  </div>
</template>
