<script setup lang="ts">
import { computed, inject, nextTick, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FocusOutsideEvent, PointerDownOutsideEvent } from 'reka-ui';
import { Ban, Check, FileText, Pipette } from 'lucide-vue-next';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import SettingInput from '@/components/settings/controls/SettingInput.vue';
import SettingSelect, { type SelectOption } from '@/components/settings/controls/SettingSelect.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import { ColorPicker } from '@/components/ui/color-picker';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { canonicalHexColor, hexColorParts, type HexColor } from '@shared/hex-color';
import { HOST_TONES, canonicalHostColor, hostColorLook, isHostTone, type CustomHostColor, type HostTone } from '@shared/host-colors';
import { PERMISSION_MODES, type PermissionMode } from '@shared/types/settings';
import { DESKTOP_CONFIGURATION, REMOTE_TERMINAL_IDLE_DAYS_SETTING } from '../../../local-services/desktop-configuration';
import type { HostSettingChange, NameCheck, RemoteHostEntry } from '../../../preload/overlay-channels';
import type { ShellPlatform } from '../../../preload/shell-channels';
import { THEME_PALETTES } from '../../../theme-palettes';
import { hostAppearance } from '../../host-appearance';
import { answerOf, ran } from '../popup-answer';
import HostActions from '../components/HostActions.vue';
import HostNameField from '../components/HostNameField.vue';
import InstallFolderField from '../components/InstallFolderField.vue';
import HeldMemoryRow from './HeldMemoryRow.vue';
import { useDesktopPrefs } from './desktop-prefs';
import { integerSetting } from './integer-setting';
import { REMOTE_HOSTS_TARGET } from './remote-hosts-target';

type SwitchKey = Extract<HostSettingChange, { readonly value: boolean }>['key'];
type Pending = Partial<Record<HostSettingChange['key'], HostSettingChange['value']>>;

// Settings, Remote hosts: the saved SSH hosts as main reads them from this computer's host store, one host's settings at a
// time, and the global idle-terminal limit. Every change goes to main, which pushes the hosts again.
const { t } = useI18n();
const prefs = useDesktopPrefs();
const { api } = prefs;
const targetHost = inject(REMOTE_HOSTS_TARGET, undefined);

const entries = shallowRef<readonly RemoteHostEntry[] | undefined>();
const loadFailed = ref(false);
// Subscribed before the first read, so a change between the two is not lost; a push is always the newer list.
onScopeDispose(api.onHostEntries((next) => {
  entries.value = next;
  pending.value = Object.fromEntries(Object.entries(pending.value).filter(([hostId]) => writing.has(hostId)));
}));
void answerOf(api.listRemoteHosts()).then((first) => {
  if (!entries.value && first) entries.value = first;
}, () => {
  loadFailed.value = true;
});

const selectedId = ref<string | undefined>(targetHost?.value);
watch(() => targetHost?.value, (hostId) => {
  if (hostId !== undefined) selectedId.value = hostId;
});
const host = computed(() => entries.value?.find((entry) => entry.hostId === selectedId.value) ?? entries.value?.[0]);

// A change shows at once and holds until main's next push, or reverts with a notice when main refuses it.
const pending = shallowRef<Readonly<Record<string, Pending>>>({});
const writing = new Map<string, number>();
const failedKey = ref<{ readonly hostId: string; readonly key: HostSettingChange['key'] } | undefined>();

function shown<K extends keyof RemoteHostEntry['settings']>(entry: RemoteHostEntry, key: K & HostSettingChange['key']): RemoteHostEntry['settings'][K] {
  const value = pending.value[entry.hostId]?.[key];
  if (value === undefined) return entry.settings[key];
  return (value === null ? undefined : value) as RemoteHostEntry['settings'][K];
}

function show(hostId: string, change: HostSettingChange): void {
  pending.value = { ...pending.value, [hostId]: { ...pending.value[hostId], [change.key]: change.value } };
}

function hold(hostId: string): void {
  writing.set(hostId, (writing.get(hostId) ?? 0) + 1);
}

function letGo(hostId: string): void {
  const left = (writing.get(hostId) ?? 1) - 1;
  if (left === 0) writing.delete(hostId);
  else writing.set(hostId, left);
}

async function save(hostId: string, change: HostSettingChange): Promise<void> {
  failedKey.value = undefined;
  hold(hostId);
  show(hostId, change);
  try {
    await ran(api.setHostSetting(hostId, change));
  } catch {
    const { [change.key]: _dropped, ...rest } = pending.value[hostId] ?? {};
    pending.value = { ...pending.value, [hostId]: rest };
    failedKey.value = { hostId, key: change.key };
  } finally {
    letGo(hostId);
  }
}

const set = (entry: RemoteHostEntry, change: HostSettingChange): Promise<void> => save(entry.hostId, change);

// The picker's commits show at once and reach main once they pause, so a held key or a run of drags writes the file once.
const COLOR_WRITE_DELAY_MS = 300;
let heldColor: { readonly hostId: string; readonly change: HostSettingChange; readonly timer: ReturnType<typeof setTimeout> } | undefined;

function holdColor(hostId: string, change: HostSettingChange): void {
  if (heldColor && heldColor.hostId !== hostId) flushColor();
  if (heldColor) clearTimeout(heldColor.timer);
  else hold(hostId);
  show(hostId, change);
  heldColor = { hostId, change, timer: setTimeout(flushColor, COLOR_WRITE_DELAY_MS) };
}

function flushColor(): void {
  const held = heldColor;
  if (!held) return;
  heldColor = undefined;
  clearTimeout(held.timer);
  void save(held.hostId, held.change);
  letGo(held.hostId);
}
onScopeDispose(flushColor);

function failedOn(entry: RemoteHostEntry, key: HostSettingChange['key']): boolean {
  const failed = failedKey.value;
  return failed?.hostId === entry.hostId && failed.key === key;
}

const idleDays = computed(() => String(prefs.values.value[REMOTE_TERMINAL_IDLE_DAYS_SETTING] ?? DESKTOP_CONFIGURATION[REMOTE_TERMINAL_IDLE_DAYS_SETTING]!.default));
const parseIdleDays = integerSetting(REMOTE_TERMINAL_IDLE_DAYS_SETTING, t);

// The host picker and the swatches are radio groups of buttons with a roving tab stop; no shadcn part draws either.
function moveRadio(event: KeyboardEvent, count: number, index: number, pick: (next: number) => void): void {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  const next = (index + step + count) % count;
  // read now: an event's currentTarget is null once its dispatch ends
  const group = (event.currentTarget as HTMLElement | null)?.parentElement;
  pick(next);
  void nextTick(() => group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus());
}

const pickHost = (index: number): void => {
  selectedId.value = entries.value?.[index]?.hostId;
};

// The custom swatch is the radio after the palette; arrowing onto it only focuses it, and its popover writes.
const COLORS: readonly (HostTone | null)[] = [null, ...HOST_TONES];
const CUSTOM = COLORS.length;
const customOf = (entry: RemoteHostEntry): CustomHostColor | undefined => {
  const color = shown(entry, 'color');
  return color === undefined || isHostTone(color) ? undefined : color;
};
const colorIndex = (entry: RemoteHostEntry): number => {
  const color = shown(entry, 'color');
  return color === undefined || isHostTone(color) ? COLORS.indexOf(color ?? null) : CUSTOM;
};
const pickColor = (entry: RemoteHostEntry, index: number): void => {
  if (index < CUSTOM) void set(entry, { key: 'color', value: COLORS[index] ?? null });
};
const customLook = computed(() => {
  const custom = host.value && customOf(host.value);
  return custom ? hostColorLook(custom) : undefined;
});
// The custom swatch's description: the color it holds, then what it opens.
const customHintId = useId();
const customValue = computed(() => {
  const custom = host.value && customOf(host.value);
  return custom ? t('remoteHosts.color.customValue', { hex: custom.slice(0, 7), opacity: Math.round(hexColorParts(custom).alpha * 100) }) : undefined;
});

// The picker edits the color of the host it opened on: a commit writes, closing with an unwritten draft writes it, and Escape
// drops it. Zero opacity writes no color.
const customSwatch = ref<HTMLElement | null>(null);
const pickerOpen = ref(false);
const pickerDraft = ref<HexColor>();
let pickerHostId: string | undefined;
let pickerWritten: HexColor | undefined;
let pickerEscaped = false;
let pickerLeftOutside = false;
const pickerTransparent = computed(() => pickerDraft.value !== undefined && hexColorParts(pickerDraft.value).alpha === 0);

// None starts from the first tone, and a tone from its palette value in this page's theme (safety-colors.test.ts).
function startColor(entry: RemoteHostEntry): HexColor {
  const color = shown(entry, 'color') ?? HOST_TONES[0];
  if (!isHostTone(color)) return color;
  const start = canonicalHexColor(THEME_PALETTES[hostAppearance().kind][`--d-${color}`] ?? '');
  if (!start) throw new Error(`The ${color} tone is not a hex color in the palette`);
  return start;
}

function openPicker(entry: RemoteHostEntry): void {
  pickerHostId = entry.hostId;
  pickerDraft.value = startColor(entry);
  pickerWritten = pickerDraft.value;
  pickerEscaped = false;
  pickerLeftOutside = false;
  pickerOpen.value = true;
}

function writePicked(value: HexColor): void {
  if (pickerHostId === undefined || pickerEscaped || value === pickerWritten) return;
  pickerWritten = value;
  const change = { key: 'color', value: canonicalHostColor(value) } as const;
  if (pickerOpen.value) {
    holdColor(pickerHostId, change);
    return;
  }
  flushColor();
  void save(pickerHostId, change);
}

function closePicker(): void {
  if (!pickerOpen.value) return;
  pickerOpen.value = false;
  if (pickerDraft.value) writePicked(pickerDraft.value);
  flushColor();
}

// The custom swatch opens and closes the picker itself, so a press on it is no dismissal.
function onPickerOutside(event: PointerDownOutsideEvent | FocusOutsideEvent): void {
  if (customSwatch.value?.contains(event.target as Node | null)) event.preventDefault();
  else pickerLeftOutside = true;
}

// The swatch anchors the popover, so reka has no trigger to refocus; a close by a press elsewhere leaves focus there.
function onPickerCloseFocus(event: Event): void {
  if (pickerLeftOutside) return;
  event.preventDefault();
  customSwatch.value?.focus();
}

const areaValueText = (saturation: number, brightness: number): string => t('remoteHosts.picker.areaValue', { saturation, brightness });
const hueValueText = (degrees: number): string => t('remoteHosts.picker.hueValue', degrees);
const opacityValueText = (percent: number): string => t('remoteHosts.picker.opacityValue', { percent });

// Name: saved on Enter and when the field loses focus, through main's validator.
const nameDraft = ref('');
const nameField = ref<InstanceType<typeof HostNameField> | null>(null);
watch(() => [host.value?.hostId, host.value?.name] as const, ([, name]) => {
  nameDraft.value = name ?? '';
}, { immediate: true });

async function rename(entry: RemoteHostEntry, name: string): Promise<void> {
  if (name === entry.name) return;
  let result: NameCheck | undefined;
  try {
    result = await answerOf(api.renameHost(entry.hostId, name));
  } catch {
    nameField.value?.saveFailed();
    return;
  }
  if (result && !result.ok) await nameField.value?.refuse(result);
}

// reka reserves '' for no selection, so "the host's own setting" is a sentinel of its own.
const HOST_MODE = 'host';
const modeOptions = computed((): SelectOption<PermissionMode | typeof HOST_MODE>[] => [
  { value: HOST_MODE, label: t('remoteHosts.mode.host') },
  ...PERMISSION_MODES.map((mode) => ({ value: mode, label: t(`remoteHosts.mode.${mode}`) })),
]);

const DETECT = 'detect';
// Product names, the same in every language.
const OS_NAMES: Readonly<Record<ShellPlatform, string>> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
const osOptions = (entry: RemoteHostEntry): SelectOption<ShellPlatform | typeof DETECT>[] => [
  { value: DETECT, label: entry.detectedOs ? t('remoteHosts.os.detected', { os: OS_NAMES[entry.detectedOs] }) : t('remoteHosts.os.detect') },
  ...(Object.keys(OS_NAMES) as ShellPlatform[]).map((os) => ({ value: os, label: OS_NAMES[os] })),
];

// row: the row id; name: its settingsHost.rows strings
const SWITCHES: readonly { readonly key: SwitchKey; readonly row: string; readonly name: string }[] = [
  { key: 'allowBypass', row: 'remote-host-yolo', name: 'remoteHostYolo' },
  { key: 'forwardAgent', row: 'remote-host-agent', name: 'remoteHostAgent' },
  { key: 'rememberPassword', row: 'remote-host-remember', name: 'remoteHostRemember' },
  { key: 'browserLocalNetwork', row: 'remote-host-local-network', name: 'remoteHostLocalNetwork' },
  { key: 'openLinksWithoutAsking', row: 'remote-host-links', name: 'remoteHostLinks' },
];
// The agent reaches a POSIX SSH host through ssh and a container through its connection, never a WSL distro; only ssh asks
// for a password to remember.
const shownSwitch = (entry: RemoteHostEntry, key: SwitchKey): boolean => {
  if (key === 'forwardAgent') return entry.kind === 'container' || (entry.kind === 'ssh' && entry.os !== 'win32');
  return key !== 'rememberPassword' || entry.kind === 'ssh';
};
const switchesOf = (entry: RemoteHostEntry): typeof SWITCHES => SWITCHES.filter((item) => shownSwitch(entry, item.key));
// The links row names the host; search still matches its static label.
const switchLabel = (entry: RemoteHostEntry, item: (typeof SWITCHES)[number]): string => (item.key === 'openLinksWithoutAsking'
  ? t('remoteHosts.linksLabel', { name: entry.name })
  : t(`settingsHost.rows.${item.name}.label`));

const revokeFailed = ref<string | undefined>();
async function revoke(entry: RemoteHostEntry, credentialHost: string): Promise<void> {
  revokeFailed.value = undefined;
  try {
    await ran(api.revokeCredentialHost(entry.hostId, credentialHost));
  } catch {
    revokeFailed.value = credentialHost;
  }
}

const logFailed = ref(false);
async function showLog(entry: RemoteHostEntry): Promise<void> {
  logFailed.value = false;
  try {
    await ran(api.showHostLog(entry.hostId));
  } catch {
    logFailed.value = true;
  }
}

const choosingFolder = ref(false);
watch(() => host.value?.hostId, () => {
  choosingFolder.value = false;
  flushColor();
  pickerOpen.value = false;
  pickerDraft.value = undefined;
  pickerHostId = undefined;
});
</script>

<template>
  <SettingsRow :id="REMOTE_TERMINAL_IDLE_DAYS_SETTING">
    <span class="flex items-center gap-1.5">
      <SettingInput
        :model-value="idleDays"
        :parse="parseIdleDays"
        :label="t('settingsHost.rows.remoteTerminalIdleDays.label')"
        inputmode="numeric"
        @commit="(value: number) => prefs.set(REMOTE_TERMINAL_IDLE_DAYS_SETTING, value)"
      />
      <span class="text-12 text-(--d-faint-text)">{{ t('remoteHosts.days') }}</span>
    </span>
  </SettingsRow>
  <SettingsRow
    id="remote-hosts"
    :description="entries?.length === 0 ? t('remoteHosts.none') : undefined"
  >
    <p
      v-if="loadFailed"
      role="alert"
      class="text-12 text-(--d-danger-text)"
    >
      {{ t('remoteHosts.loadFailed') }}
    </p>
    <div
      v-else-if="entries && entries.length > 0"
      role="radiogroup"
      :aria-label="t('remoteHosts.hosts')"
      class="flex flex-wrap justify-end gap-1.5"
    >
      <button
        v-for="(entry, index) in entries"
        :key="entry.hostId"
        type="button"
        role="radio"
        data-testid="remote-host-pick"
        :data-host-id="entry.hostId"
        :aria-checked="entry.hostId === host?.hostId"
        :tabindex="entry.hostId === host?.hostId ? 0 : -1"
        class="flex h-7 max-w-40 items-center gap-1.5 rounded-full border px-2.5 text-12 font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
        :class="entry.hostId === host?.hostId ? 'border-(--d-accent) bg-(--d-accent-soft) text-(--d-text)' : 'border-(--d-border2) text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)'"
        @click="selectedId = entry.hostId"
        @keydown="moveRadio($event, entries.length, index, pickHost)"
      >
        <span
          aria-hidden="true"
          class="size-2 shrink-0 rounded-full bg-(--tone)"
          :class="hostColorLook(shown(entry, 'color')).class"
          :style="hostColorLook(shown(entry, 'color')).style"
        />
        <Transition
          name="t-swap"
          mode="out-in"
        >
          <span
            :key="entry.name"
            class="truncate"
          >{{ entry.name }}</span>
        </Transition>
      </button>
    </div>
  </SettingsRow>
  <div
    v-if="host"
    :key="host.hostId"
    data-testid="remote-host"
    :data-host-id="host.hostId"
    class="contents"
  >
    <HeldMemoryRow
      :api="api"
      :host-id="host.hostId"
      :host-name="host.name"
      :queues="host.heldMemoryQueues"
    />
    <SettingsRow id="remote-host-name">
      <span
        class="w-48"
        @focusout="nameField && rename(host, nameDraft.trim())"
      >
        <HostNameField
          ref="nameField"
          v-model="nameDraft"
          :label="t('settingsHost.rows.remoteHostName.label')"
          :check="(name) => answerOf(api.checkHostName(name, host!.hostId))"
          @submit="(name) => rename(host!, name)"
          @cancel="nameDraft = host.name"
        />
      </span>
    </SettingsRow>
    <SettingsRow
      id="remote-host-color"
      :description="t('remoteHosts.colorDescription', { name: host.name })"
    >
      <template #note>
        <p
          v-if="failedOn(host, 'color')"
          role="alert"
          class="sm-feedback sm-feedback-error"
        >
          {{ t('remoteHosts.saveFailed') }}
        </p>
      </template>
      <div
        role="radiogroup"
        :aria-label="t('settingsHost.rows.remoteHostColor.label')"
        class="flex items-center gap-1.5"
      >
        <button
          v-for="(tone, index) in COLORS"
          :key="tone ?? 'none'"
          type="button"
          role="radio"
          data-testid="remote-host-color"
          :data-tone="tone ?? 'none'"
          :aria-checked="index === colorIndex(host)"
          :aria-label="t(`remoteHosts.color.${tone ?? 'none'}`)"
          :title="t(`remoteHosts.color.${tone ?? 'none'}`)"
          :tabindex="index === colorIndex(host) ? 0 : -1"
          class="grid size-5.5 place-items-center rounded-full transition-transform duration-150 hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
          :class="tone ? [hostColorLook(tone).class, 'bg-(--tone) text-(--tone-on)'] : 'border border-dashed border-(--d-border2) text-(--d-muted)'"
          @click="set(host, { key: 'color', value: tone })"
          @keydown="moveRadio($event, CUSTOM + 1, index, (next) => pickColor(host!, next))"
        >
          <Check
            v-if="index === colorIndex(host) && tone"
            aria-hidden="true"
            class="size-3 animate-[d-icon-in_.25s_var(--ease-spring)]"
          />
          <Ban
            v-else-if="!tone"
            aria-hidden="true"
            class="size-3"
          />
        </button>
        <Popover
          :open="pickerOpen"
          @update:open="(open: boolean) => open || closePicker()"
        >
          <PopoverAnchor as-child>
            <button
              ref="customSwatch"
              type="button"
              role="radio"
              data-testid="remote-host-color"
              data-tone="custom"
              :aria-checked="colorIndex(host) === CUSTOM"
              :aria-label="t('remoteHosts.color.custom')"
              :aria-describedby="customValue ? `${customHintId}-value ${customHintId}-opens` : `${customHintId}-opens`"
              :title="customValue ? t('remoteHosts.color.customTitle', { value: customValue }) : t('remoteHosts.color.custom')"
              :tabindex="colorIndex(host) === CUSTOM ? 0 : -1"
              class="grid size-5.5 place-items-center rounded-full transition-transform duration-150 hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
              :class="customLook ? [customLook.class, 'bg-(--tone) text-(--tone-on) ring-1 ring-(--d-border2) ring-inset [--tone-surface:var(--d-bg)]'] : 'border border-dashed border-(--d-border2) text-(--d-muted)'"
              :style="customLook?.style"
              @click="pickerOpen ? closePicker() : openPicker(host!)"
              @keydown="moveRadio($event, CUSTOM + 1, CUSTOM, (next) => pickColor(host!, next))"
            >
              <Check
                v-if="customLook"
                aria-hidden="true"
                class="size-3 animate-[d-icon-in_.25s_var(--ease-spring)]"
              />
              <Pipette
                v-else
                aria-hidden="true"
                class="size-3"
              />
            </button>
          </PopoverAnchor>
          <PopoverContent
            align="end"
            data-testid="host-color-picker"
            :aria-label="t('remoteHosts.color.custom')"
            class="w-60"
            @escape-key-down="pickerEscaped = true"
            @interact-outside="onPickerOutside"
            @close-auto-focus="onPickerCloseFocus"
          >
            <ColorPicker
              v-if="pickerDraft"
              v-model="pickerDraft"
              :area-label="t('remoteHosts.picker.area')"
              :area-thumb-label="t('remoteHosts.picker.areaThumb')"
              :hue-label="t('remoteHosts.picker.hue')"
              :opacity-label="t('remoteHosts.picker.opacity')"
              :hex-label="t('remoteHosts.picker.hex')"
              :preview-label="t('remoteHosts.picker.preview')"
              :area-value-text="areaValueText"
              :hue-value-text="hueValueText"
              :opacity-value-text="opacityValueText"
              @commit="writePicked"
            />
            <!-- present before its text, so the note is announced when the opacity reaches 0% -->
            <p
              role="status"
              class="text-11 text-(--d-muted)"
            >
              <span
                v-if="pickerTransparent"
                data-testid="host-color-transparent"
                class="block animate-[d-fade_.2s_var(--ease-out)] pt-2.5"
              >{{ t('remoteHosts.picker.transparent') }}</span>
            </p>
          </PopoverContent>
        </Popover>
        <span
          v-if="customValue"
          :id="`${customHintId}-value`"
          class="sr-only"
        >{{ customValue }}</span>
        <span
          :id="`${customHintId}-opens`"
          class="sr-only"
        >{{ t('remoteHosts.color.opensPicker') }}</span>
      </div>
    </SettingsRow>
    <SettingsRow
      id="remote-host-mode"
      :description="t('remoteHosts.modeDescription', { name: host.name })"
    >
      <template #note>
        <p
          v-if="failedOn(host, 'defaultPermissionMode')"
          role="alert"
          class="sm-feedback sm-feedback-error"
        >
          {{ t('remoteHosts.saveFailed') }}
        </p>
      </template>
      <SettingSelect
        :model-value="shown(host, 'defaultPermissionMode') ?? HOST_MODE"
        :options="modeOptions"
        :label="t('settingsHost.rows.remoteHostMode.label')"
        @update:model-value="(value) => set(host!, { key: 'defaultPermissionMode', value: value === HOST_MODE ? null : value })"
      />
    </SettingsRow>
    <SettingsRow
      v-for="item in switchesOf(host)"
      :id="item.row"
      :key="item.key"
      :label="switchLabel(host, item)"
      :description="t(`remoteHosts.switch.${item.key}`, { name: host.name })"
    >
      <template #note>
        <p
          v-if="failedOn(host, item.key)"
          role="alert"
          class="sm-feedback sm-feedback-error"
        >
          {{ t('remoteHosts.saveFailed') }}
        </p>
      </template>
      <SettingSwitch
        :model-value="shown(host, item.key) === true"
        :label="switchLabel(host, item)"
        :data-testid="`remote-host-switch-${item.key}`"
        @update:model-value="(value) => set(host!, { key: item.key, value })"
      />
    </SettingsRow>
    <SettingsRow
      id="remote-host-credentials"
      :label="t('remoteHosts.credentialsLabel', { name: host.name })"
      :description="host.facts.alwaysCredentialHosts.length === 0 ? t('remoteHosts.credentialsNone', { name: host.name }) : t('remoteHosts.credentialsDescription', { name: host.name })"
    >
      <template #expand>
        <ul
          v-if="host.facts.alwaysCredentialHosts.length > 0"
          class="flex flex-col gap-px px-3.5 pb-2.5"
        >
          <li
            v-for="credentialHost in host.facts.alwaysCredentialHosts"
            :key="credentialHost"
            data-testid="credential-host"
            class="flex h-8 items-center gap-2 text-12.5"
          >
            <span
              dir="ltr"
              class="min-w-0 flex-1 truncate font-mono"
            >{{ credentialHost }}</span>
            <span
              v-if="revokeFailed === credentialHost"
              role="alert"
              class="text-11.5 text-(--d-danger-text)"
            >{{ t('remoteHosts.revokeFailed') }}</span>
            <SettingButton
              :aria-label="t('remoteHosts.revokeHost', { host: credentialHost })"
              data-testid="credential-host-revoke"
              @click="revoke(host!, credentialHost)"
            >
              {{ t('remoteHosts.revoke') }}
            </SettingButton>
          </li>
        </ul>
      </template>
    </SettingsRow>
    <SettingsRow
      v-if="host.kind === 'ssh'"
      id="remote-host-os"
    >
      <template #note>
        <p
          v-if="failedOn(host, 'osOverride')"
          role="alert"
          class="sm-feedback sm-feedback-error"
        >
          {{ t('remoteHosts.saveFailed') }}
        </p>
      </template>
      <SettingSelect
        :model-value="shown(host, 'osOverride') ?? DETECT"
        :options="osOptions(host)"
        :label="t('settingsHost.rows.remoteHostOs.label')"
        @update:model-value="(value) => set(host!, { key: 'osOverride', value: value === DETECT ? null : value })"
      />
    </SettingsRow>
    <SettingsRow
      id="remote-host-install-folder"
      :description="t('settingsHost.rows.remoteHostInstallFolder.description')"
    >
      <template #note>
        <span
          dir="ltr"
          data-testid="remote-host-install-folder"
          class="font-mono text-11.5 text-(--d-text)"
        >{{ host.settings.installFolder ?? t('remote.installFolder.default') }}</span>
      </template>
      <SettingButton
        data-testid="remote-host-install-folder-change"
        :aria-expanded="choosingFolder"
        @click="choosingFolder = !choosingFolder"
      >
        {{ choosingFolder ? t('remoteHosts.cancelFolder') : t('remoteHosts.changeFolder') }}
      </SettingButton>
      <template #expand>
        <div
          v-if="choosingFolder"
          class="px-3.5 pb-3"
        >
          <InstallFolderField
            :current="host.settings.installFolder"
            :host-name="host.name"
            :browse="host.connection === 'connected' ? (path) => answerOf(api.browseHost(host!.hostId, path)) : undefined"
            :save="(folder) => answerOf(api.setInstallFolder(host!.hostId, folder))"
            @saved="choosingFolder = false"
          />
        </div>
      </template>
    </SettingsRow>
    <SettingsRow id="remote-host-actions">
      <SettingButton
        data-testid="remote-host-show-log"
        @click="showLog(host)"
      >
        <FileText
          aria-hidden="true"
          class="size-3"
        />
        {{ t('remote.card.showLog') }}
      </SettingButton>
      <template #note>
        <p
          v-if="logFailed"
          role="alert"
          class="sm-feedback sm-feedback-error"
        >
          {{ t('remoteHosts.logFailed', { name: host.name }) }}
        </p>
      </template>
      <template #expand>
        <div class="px-3.5 pb-3">
          <HostActions
            :api="api"
            :host-id="host.hostId"
            :host-name="host.name"
            :kind="host.kind"
            :connection="host.connection"
            :passwordless="host.facts.passwordless"
            :os="host.os"
            :containers="entries!.some((entry) => entry.container?.via?.hostId === host!.hostId)"
          />
        </div>
      </template>
    </SettingsRow>
  </div>
</template>
