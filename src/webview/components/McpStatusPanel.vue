<script setup lang="ts">
import { LOCAL_MCP_RELATIVE_PATH } from '@shared/types/mcp';
import type {
  McpConfigError,
  McpServerConfig,
  McpServerSource,
  McpServerStatusInfo,
  McpToolExposureScope,
  McpToolExposureSetting,
  McpToolInfo,
  McpWriteErrorInfo,
} from '@shared/types/mcp';
import type { Component } from 'vue';
import { ref, computed, nextTick, onMounted, onUnmounted, useId, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Ban, ChevronRight, CircleCheck, CircleOff, CircleX, FileX, KeyRound, LoaderCircle, LogOut, Pencil, Plug, Plus,
  RefreshCw, Search, Settings, ShieldAlert, Trash2, TriangleAlert, Zap,
} from 'lucide-vue-next';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import SegmentedToggle, { type SegmentedOption } from './SegmentedToggle.vue';
import ToggleSwitch from './ToggleSwitch.vue';
import McpServerFormDialog from './McpServerFormDialog.vue';
import { canDeleteMcpServer, canEditMcpServer, type McpCollisionServer } from './mcp-server-form-logic';

const { t } = useI18n();

const props = defineProps<{
  servers: McpServerStatusInfo[];
  configErrors: McpConfigError[];
  /** True between emitting a write and the extension acknowledging it. */
  mcpWriteInFlight: boolean;
  /** The extension’s reason for refusing the last write, or null. */
  mcpWriteError: McpWriteErrorInfo | null;
  mcpEnabled: boolean;
  /** True when `<ws>/.damocles/mcp.local.json` exists and git does not ignore it. */
  localMcpUnignored: boolean;
  /** Scopes a tool's exposure can be saved to here, lowest first; absent means User only. */
  toolExposureScopes?: McpToolExposureScope[];
  /** Counts applied `mcpConfigUpdate` payloads, so the panel can see a reload land. */
  configRevision: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'toggle', serverName: string, enabled: boolean): void;
  (e: 'toggleEnabled', enabled: boolean): void;
  (e: 'reconnect', serverName: string): void;
  (e: 'authenticate', serverName: string): void;
  (e: 'reauthenticate', serverName: string): void;
  (e: 'signOut', serverName: string): void;
  (e: 'trustProject'): void;
  (e: 'openFile', filePath: string, line: number | null): void;
  (e: 'addServer', serverName: string, config: McpServerConfig): void;
  (e: 'updateServer', serverName: string, newServerName: string | undefined, config: McpServerConfig): void;
  (e: 'deleteServer', serverName: string): void;
  (e: 'reloadConfig'): void;
  (e: 'setToolExposure', serverName: string, toolName: string, exposure: McpToolExposureSetting, scope: McpToolExposureScope): void;
}>();

const TOOL_EXPOSURES: readonly { value: McpToolExposureSetting; labelKey: string; icon: Component }[] = [
  { value: 'off', labelKey: 'mcp.toolExposureOff', icon: CircleOff },
  { value: 'deferred', labelKey: 'mcp.toolExposureOn', icon: Search },
  { value: 'direct', labelKey: 'mcp.toolExposureDirect', icon: Zap },
];

const exposureOptions = computed<SegmentedOption<McpToolExposureSetting>[]>(() =>
  TOOL_EXPOSURES.map((option) => ({ value: option.value, label: t(option.labelKey), icon: option.icon, attrs: { 'data-exposure': option.value } })),
);

const exposureScopes = computed<McpToolExposureScope[]>(() => props.toolExposureScopes ?? ['user']);

/** The scope the next exposure change is written to; User until the user picks another the host offers. */
const chosenSaveScope = ref<McpToolExposureScope>('user');
const saveScope = computed<McpToolExposureScope>(() =>
  exposureScopes.value.includes(chosenSaveScope.value) ? chosenSaveScope.value : 'user',
);

const scopeOptions = computed<SegmentedOption<McpToolExposureScope>[]>(() =>
  exposureScopes.value.map((scope) => ({ value: scope, label: t(`mcp.toolExposureSource.${scope}`), attrs: { 'data-scope': scope } })),
);

function handleToolExposure(server: McpServerStatusInfo, tool: McpToolInfo, value: McpToolExposureSetting): void {
  if (value === (tool.exposure ?? 'deferred')) return;
  emit('setToolExposure', server.name, tool.name, value, saveScope.value);
}

/** The indicator is mixed into the opaque card under it, since a translucent one would show its seams. */
function exposureIndicator(tool: McpToolInfo): string {
  return (tool.exposure ?? 'deferred') === 'off'
    ? 'text-[color-mix(in_srgb,var(--d-text)_9%,var(--d-card))]'
    : 'text-[color-mix(in_srgb,var(--d-accent)_16%,var(--d-card))]';
}

const hasUntrustedServers = computed(() => props.servers.some((s) => s.untrusted === true));
const hasToolRows = computed(() => props.servers.some((s) => (s.tools?.length ?? 0) > 0));

/**
 * How long Reload config stays disabled with no answer. `mcpReloadConfig` carries no requestId, so a
 * reply lost to a host-side throw would otherwise disable the button for the life of the webview.
 * Ten seconds clears the slowest plausible reload, five config reads plus a `git status` on a
 * virtualised filesystem, and still gives the user the button back inside one attention span.
 */
const RELOAD_TIMEOUT_MS = 10_000;

/** True between a clicked reload and the config update that answers it. */
const reloadInFlight = ref(false);
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function endReload(): void {
  reloadInFlight.value = false;
  if (reloadTimer !== null) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

function handleReloadClick(): void {
  endReload();
  reloadInFlight.value = true;
  reloadTimer = setTimeout(endReload, RELOAD_TIMEOUT_MS);
  emit('reloadConfig');
}

watch(() => props.configRevision, endReload);

/**
 * Re-read the config when the panel opens (it mounts on open), so an edit made to `.gitignore` while the
 * extension was not running does not leave a stale warning on screen. Only the click path raises
 * `reloadInFlight`, so this cannot strand the button.
 */
onMounted(() => emit('reloadConfig'));

const expandedServers = ref<Set<string>>(new Set());

/** True while the add/edit form is open; `editingName` is null for an add. */
const formOpen = ref(false);
const editingName = ref<string | null>(null);
const editingConfig = ref<McpServerConfig | null>(null);

/**
 * Whether `~/.damocles/mcp.json` itself is unusable. Every write is a read-modify-write of that file,
 * so while it cannot be parsed no Add, Edit or Delete can succeed — and the inline collision check is
 * blind, because it runs against the merged list, which currently holds none of that file’s servers.
 * Offering the actions anyway would mean the user fills in a whole form to be told it was never going
 * to work. The notice above already says which file and which line.
 */
const damoclesConfigBroken = computed(() =>
  props.configErrors.some((error) => /[/\\]\.damocles[/\\]mcp\.json$/.test(error.path)),
);

/** The server awaiting delete confirmation. Delete is never emitted without passing through here. */
const pendingDeleteName = ref<string | null>(null);

function openAddForm(): void {
  editingName.value = null;
  editingConfig.value = null;
  formOpen.value = true;
}

function openEditForm(server: McpServerStatusInfo): void {
  if (!canEditMcpServer(server)) return;
  editingName.value = server.name;
  editingConfig.value = server.editableConfig ?? null;
  formOpen.value = true;
}

/**
 * Only the visibility flag is cleared. The form reads `editingName`/`editingConfig` when it mounts;
 * clearing them here instead mutates it while its exit transition plays, so the just-saved name
 * starts colliding with itself and the overlay flashes “Add MCP server” on its way off screen.
 */
function closeForm(): void {
  formOpen.value = false;
}

/**
 * Send the write and leave the form open. It closes only when `mcpWriteInFlight` goes false with no
 * `mcpWriteError` — i.e. when the extension confirms the write landed. Closing here instead would
 * discard everything the user typed on any rejection the webview could not predict.
 */
function handleFormSave(serverName: string, config: McpServerConfig): void {
  const original = editingName.value;
  if (original === null) {
    emit('addServer', serverName, config);
  } else {
    emit('updateServer', original, serverName === original ? undefined : serverName, config);
  }
}

/** Each row by server name; the inline delete confirmation replaces a row's controls, so focus is placed by hand around it. */
const rowElements = new Map<string, HTMLElement>();
let deleteCancelButton: HTMLElement | null = null;
const addServerAction = useTemplateRef('addServerAction');

function setRowElement(name: string, el: unknown): void {
  if (el instanceof HTMLElement) rowElements.set(name, el);
  else rowElements.delete(name);
}

function setDeleteCancelButton(el: unknown): void {
  deleteCancelButton = el instanceof HTMLElement ? el : null;
}

/** A confirmed delete until its write settles: the server's name and row index. */
let deleting: { name: string; index: number } | null = null;

/** Once a delete lands, focus moves to the row that took the deleted one's place. */
async function focusAfterDelete({ name, index }: { name: string; index: number }): Promise<void> {
  if (props.servers.some((server) => server.name === name)) return;
  await nextTick();
  const next = props.servers[Math.min(index, props.servers.length - 1)];
  (next ? rowElements.get(next.name) : addServerAction.value?.$el as HTMLElement | undefined)?.focus();
}

// The host posts the config update before the write's result, so the list is current when this runs.
watch(
  () => props.mcpWriteInFlight,
  (inFlight, wasInFlight) => {
    if (!wasInFlight || inFlight) return;
    if (props.mcpWriteError === null) closeForm();
    if (deleting !== null) void focusAfterDelete(deleting);
    deleting = null;
  },
);

async function requestDelete(server: McpServerStatusInfo): Promise<void> {
  if (!canDeleteMcpServer(server)) return;
  pendingDeleteName.value = server.name;
  await nextTick();
  deleteCancelButton?.focus();
}

/** Returns focus to the Delete button that opened the confirmation. */
async function cancelDelete(): Promise<void> {
  const name = pendingDeleteName.value;
  pendingDeleteName.value = null;
  await nextTick();
  if (name !== null) rowElements.get(name)?.querySelector<HTMLElement>('[data-row-action="delete"]')?.focus();
}

/** Escape, the scrim and the X first back out of an open delete confirmation. */
function handleClose(): void {
  if (pendingDeleteName.value !== null) void cancelDelete();
  else emit('close');
}

async function confirmDelete(): Promise<void> {
  const name = pendingDeleteName.value;
  if (name === null) return;
  deleting = { name, index: props.servers.findIndex((server) => server.name === name) };
  emit('deleteServer', name);
  pendingDeleteName.value = null;
  await nextTick();
  rowElements.get(name)?.focus();
}

function toggleExpanded(serverName: string): void {
  const next = new Set(expandedServers.value);
  if (next.has(serverName)) {
    next.delete(serverName);
  } else {
    next.add(serverName);
  }
  expandedServers.value = next;
}

onUnmounted(endReload);

function getStatusIcon(status: McpServerStatusInfo['status']): Component {
  switch (status) {
    case 'connected':
      return CircleCheck;
    case 'failed':
      return CircleX;
    case 'needs-auth':
      return KeyRound;
    case 'pending':
      return LoaderCircle;
    case 'idle':
      return Settings;
    case 'disabled':
      return Ban;
    default:
      return Settings;
  }
}

function getStatusLabel(status: McpServerStatusInfo['status']): string {
  switch (status) {
    case 'connected':
      return t('mcp.connected');
    case 'failed':
      return t('mcp.failed');
    case 'needs-auth':
      return t('mcp.needsAuth');
    case 'pending':
      return t('mcp.pending');
    case 'idle':
      return t('mcp.ready');
    case 'disabled':
      return t('mcp.disabled');
    default:
      return t('mcp.unknown');
  }
}

/** The status colour: `icon` the tone as a text class, `chip` its `.d-tone-*` class (style.css), from which the badge tints its fill and border. */
function getStatusClass(status: McpServerStatusInfo['status']): { icon: string; chip: string } {
  switch (status) {
    case 'connected':
      return { icon: 'text-(--d-success)', chip: 'd-tone-success' };
    case 'failed':
      return { icon: 'text-(--d-danger)', chip: 'd-tone-danger' };
    case 'needs-auth':
      return { icon: 'text-(--d-warning)', chip: 'd-tone-warning' };
    case 'pending':
      return { icon: 'text-(--d-accent)', chip: 'd-tone-accent' };
    default:
      return { icon: 'text-(--d-muted)', chip: 'd-tone-muted' };
  }
}

/**
 * Provenance badge label per source. Every source is labelled, including the read-only ones: only
 * `damocles` servers carry edit and delete buttons, so without a badge the missing buttons on every
 * other row would look arbitrary. Keyed by the full `McpServerSource` union so a new source cannot
 * ship unbadged without failing to compile here.
 */
const SOURCE_LABEL_KEYS: Record<McpServerSource, string> = {
  workspace: 'mcp.fromWorkspace',
  damocles: 'mcp.fromDamocles',
  claude: 'mcp.fromClaudeCode',
  codex: 'mcp.fromCodex',
  'claude-local': 'mcp.fromClaudeLocal',
  'damocles-local': 'mcp.fromDamoclesLocal',
  pi: 'mcp.fromPi',
  'pi-project': 'mcp.fromPiProject',
};

/** `source` is optional on the wire, and a server that arrived without one carries no badge. */
function getSourceLabel(source: McpServerStatusInfo['source']): string | null {
  if (source === undefined) return null;
  return t(SOURCE_LABEL_KEYS[source]);
}

function isServerSource(value: string): value is McpServerSource {
  return Object.hasOwn(SOURCE_LABEL_KEYS, value);
}

/**
 * The row's error, translated by code. `error` is the host's English fallback for a row without a
 * code. `insufficientScope` arrives on a needs-auth row, so a coded needs-auth row shows it too.
 */
function getServerErrorText(server: McpServerStatusInfo): string | null {
  const info = server.errorInfo;
  if (info && (server.status === 'failed' || server.status === 'needs-auth')) {
    const params = { ...info.params };
    if (params.keptSource !== undefined && isServerSource(params.keptSource)) {
      params.keptSource = t(SOURCE_LABEL_KEYS[params.keptSource]);
    }
    return t(`mcp.serverErrors.${info.code}`, params);
  }
  if (server.status === 'failed' && server.error) return server.error;
  return null;
}

/** Rows whose stderr tail is expanded. The tail is host-sanitized text and renders only as text. */
const expandedStderr = ref<Set<string>>(new Set());

function toggleStderr(serverName: string): void {
  const next = new Set(expandedStderr.value);
  if (next.has(serverName)) next.delete(serverName);
  else next.add(serverName);
  expandedStderr.value = next;
}

const panelId = useId();

/** A contextual button on a server row. */
interface ServerRowAction {
  key: string;
  label: string;
  icon: Component;
  class: string;
  run: () => void;
}

/**
 * A row's actions as data rather than a run of sibling `v-if`s. A row carries up to five of them, so they
 * render on their own line; deriving them here is what lets that line know whether it has anything to
 * show without restating every button's condition.
 */
function buildRowActions(server: McpServerStatusInfo): ServerRowAction[] {
  const actions: ServerRowAction[] = [];
  if (server.status === 'needs-auth') {
    actions.push({
      key: 'authenticate',
      icon: KeyRound,
      label: t('mcp.authenticate'),
      class: 'text-(--d-warning)',
      run: () => emit('authenticate', server.name),
    });
  }
  if (server.status === 'failed') {
    actions.push({
      key: 'reconnect',
      icon: RefreshCw,
      label: t('mcp.reconnect'),
      class: 'text-(--d-danger)',
      run: () => emit('reconnect', server.name),
    });
  }
  if (server.supportsOAuth && server.status === 'connected') {
    actions.push({
      key: 'reauthenticate',
      icon: KeyRound,
      label: t('mcp.reauthenticate'),
      class: 'text-(--d-warning)',
      run: () => emit('reauthenticate', server.name),
    });
    actions.push({
      key: 'signOut',
      icon: LogOut,
      label: t('mcp.signOut'),
      class: 'text-(--d-muted)',
      run: () => emit('signOut', server.name),
    });
  }
  // Withheld while `~/.damocles/mcp.json` is unusable: every write reads that file first, so none of
  // these can succeed until it parses again.
  if (canEditMcpServer(server) && !damoclesConfigBroken.value) {
    actions.push({
      key: 'edit',
      icon: Pencil,
      label: t('mcp.editServer'),
      class: 'text-(--d-muted)',
      run: () => openEditForm(server),
    });
  }
  if (canDeleteMcpServer(server) && !damoclesConfigBroken.value) {
    actions.push({
      key: 'delete',
      icon: Trash2,
      label: t('mcp.deleteServer'),
      class: 'text-(--d-muted)',
      run: () => void requestDelete(server),
    });
  }
  return actions;
}

const rows = computed(() => props.servers.map((server) => ({ server, actions: buildRowActions(server) })));

/** How many config sources the merged list draws on, named in the master switch's description. */
const SOURCE_COUNT = Object.keys(SOURCE_LABEL_KEYS).length;

function toolsSummary(server: McpServerStatusInfo): string {
  const tools = server.tools ?? [];
  if (tools.length === 0) return server.status === 'needs-auth' ? t('overlays.mcp.authToLoadTools') : t('overlays.mcp.noTools');
  const direct = tools.filter((tool) => tool.exposure === 'direct').length;
  const off = tools.filter((tool) => tool.exposure === 'off').length;
  return [
    t('mcp.tools', { count: tools.length }),
    direct > 0 ? t('overlays.mcp.alwaysLoadedCount', { n: direct }) : null,
    off > 0 ? t('overlays.mcp.offCount', { n: off }) : null,
  ].filter(Boolean).join(' · ');
}

function availableSummary(server: McpServerStatusInfo): string {
  const tools = server.tools ?? [];
  return t('overlays.mcp.available', { n: tools.filter((tool) => tool.exposure !== 'off').length, total: tools.length });
}

/**
 * Just the three fields the form's collision check reads. `McpServerStatusInfo` also carries
 * `editableConfig`, whose `env`/`headers` values may be live credentials — there is no reason to hand
 * the whole list, secrets included, to a component that only compares names.
 *
 * `untrusted` decides whether an entry outranks `~/.damocles/mcp.json`, so dropping it here is what
 * made the form claim a precedence the host does not grant. Both optionals are spread conditionally
 * because `exactOptionalPropertyTypes` separates an absent key from a present `undefined` one.
 */
const collisionServers = computed<McpCollisionServer[]>(() =>
  props.servers.map((server) => ({
    name: server.name,
    ...(server.source === undefined ? {} : { source: server.source }),
    ...(server.untrusted === undefined ? {} : { untrusted: server.untrusted }),
  })),
);
</script>

<template>
  <OverlayShell
    :title="t('mcp.title')"
    :subtitle="t('mcp.description')"
    :icon="Plug"
    data-testid="mcp-panel"
    @close="handleClose"
  >
    <template #header-actions>
      <!-- `~/.claude.json` is deliberately unwatched, so a server added with `claude mcp add` stays invisible until the config is re-read. -->
      <OverlayHeaderAction
        :label="reloadInFlight ? t('overlays.mcp.reloading') : t('mcp.reloadConfig')"
        :title="t('mcp.reloadConfigTitle')"
        :icon="RefreshCw"
        :busy="reloadInFlight"
        :disabled="reloadInFlight"
        data-testid="mcp-reload"
        @click="handleReloadClick"
      />
      <OverlayHeaderAction
        ref="addServerAction"
        :label="t('mcp.addServer')"
        :title="damoclesConfigBroken ? t('mcp.addServerBlocked') : t('mcp.addServer')"
        :icon="Plus"
        primary
        :disabled="damoclesConfigBroken"
        data-testid="mcp-add-server"
        @click="openAddForm"
      />
    </template>

    <div class="flex flex-col gap-2.5 px-4 pt-3 pb-4.5 text-13">
      <div class="flex items-center gap-2.5 rounded-xl border border-(--d-border) bg-(--d-card) px-3 py-2.5">
        <div class="min-w-0 flex-1">
          <div class="font-semibold">
            {{ t('mcp.masterToggle') }}
          </div>
          <div class="text-11.5 text-(--d-muted) text-pretty">
            {{ t('overlays.mcp.sources', { n: SOURCE_COUNT }) }}
          </div>
        </div>
        <ToggleSwitch
          size="md"
          :checked="mcpEnabled"
          :aria-label="t('mcp.masterToggle')"
          data-testid="mcp-master-toggle"
          @update:checked="(checked: boolean) => emit('toggleEnabled', checked)"
        />
      </div>

      <div
        v-if="!mcpEnabled"
        class="rounded-10 border border-(--d-border) bg-(--d-panel) px-3 py-2.25 text-xs text-(--d-muted)"
      >
        {{ t('mcp.disabledNotice') }}
      </div>

      <!-- A config file that exists but does not parse: without this its servers vanish, which reads as data loss. -->
      <div
        v-for="configError in configErrors"
        :key="`${configError.path}:${configError.line ?? 0}`"
        class="flex gap-2.5 rounded-10 border border-[color-mix(in_srgb,var(--d-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2.5 text-xs"
      >
        <FileX
          class="size-3.5 mt-0.5 flex-none text-(--d-danger)"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-0.75">
          <div class="font-semibold text-(--d-danger-text)">
            {{ t('mcp.configErrorTitle') }}
          </div>
          <div class="font-mono text-11.5 break-all">
            {{ configError.displayPath }}
          </div>
          <div class="text-(--d-muted) text-pretty">
            {{
              configError.kind === 'unreadable'
                ? t('mcp.configErrorUnreadable')
                : configError.line !== null && configError.column !== null
                  ? t('mcp.configErrorAt', { line: configError.line, column: configError.column })
                  : t('mcp.configErrorUnknown')
            }}
          </div>
        </div>
        <button
          type="button"
          class="flex-none self-end whitespace-nowrap rounded-7 px-2.25 py-1 text-11.5 font-semibold text-(--d-danger-text) transition-colors hover:bg-[color-mix(in_srgb,var(--d-danger)_12%,transparent)]"
          @click="emit('openFile', configError.path, configError.line)"
        >
          {{ t('mcp.configErrorOpen') }}
        </button>
      </div>

      <!-- `.damocles/mcp.local.json` holds credentials in the working tree; Damocles never edits `.gitignore` itself. -->
      <div
        v-if="localMcpUnignored"
        role="alert"
        class="flex gap-2.5 rounded-10 border border-[color-mix(in_srgb,var(--d-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2.5 text-xs"
      >
        <TriangleAlert
          class="size-3.5 mt-0.5 flex-none text-(--d-danger)"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-0.75">
          <div class="font-semibold text-(--d-danger-text)">
            {{ t('mcp.localMcpUnignoredTitle') }}
          </div>
          <div class="text-(--d-muted) text-pretty">
            {{ t('mcp.localMcpUnignored', { line: LOCAL_MCP_RELATIVE_PATH }) }}
          </div>
        </div>
      </div>

      <div
        v-if="hasUntrustedServers"
        class="flex items-center gap-2.5 rounded-10 bg-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] px-3 py-2.25 text-xs text-(--d-warning-text)"
      >
        <ShieldAlert
          class="size-3.5 flex-none"
          aria-hidden="true"
        />
        <span class="flex-1 text-pretty">{{ t('mcp.untrustedNotice') }}</span>
        <button
          type="button"
          class="flex-none font-semibold underline"
          @click="emit('trustProject')"
        >
          {{ t('mcp.trustWorkspace') }}
        </button>
      </div>

      <div
        v-if="servers.length === 0"
        class="flex flex-col items-center gap-1 py-8 text-center"
      >
        <Plug
          class="size-5.5 mb-1 text-(--d-faint)"
          aria-hidden="true"
        />
        <p class="text-(--d-muted)">
          {{ t('mcp.noServers') }}
        </p>
        <p class="text-xs text-(--d-faint)">
          {{ t('mcp.addServers') }}
        </p>
      </div>

      <div
        v-else
        class="flex flex-col gap-2.5 transition-opacity duration-200"
        :class="!mcpEnabled && 'pointer-events-none opacity-50'"
        :inert="!mcpEnabled"
      >
        <!-- One choice for the whole panel: it applies to every tool's next exposure change. -->
        <div
          v-if="hasToolRows"
          class="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-(--d-border) bg-(--d-panel) py-1.5 pr-2 pl-2.5 text-11 text-(--d-faint)"
        >
          <span :id="`${panelId}-save-to`">{{ t('mcp.toolExposureSaveTo') }}</span>
          <SegmentedToggle
            :model-value="saveScope"
            :options="scopeOptions"
            indicator-class="text-(--d-card)"
            class="bg-(--d-hover)"
            data-testid="mcp-tool-exposure-scope"
            :aria-labelledby="`${panelId}-save-to`"
            @update:model-value="(scope: McpToolExposureScope) => (chosenSaveScope = scope)"
          />
        </div>

        <div
          v-for="({ server, actions }, rowIndex) in rows"
          :ref="(el) => setRowElement(server.name, el)"
          :key="server.name"
          tabindex="-1"
          class="overflow-hidden rounded-xl border bg-(--d-card) transition-colors duration-200 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
          :class="pendingDeleteName === server.name ? 'border-[color-mix(in_srgb,var(--d-danger)_45%,transparent)]' : 'border-(--d-border)'"
          data-testid="mcp-server-row"
        >
          <div
            v-if="pendingDeleteName === server.name"
            role="alertdialog"
            :aria-labelledby="`${panelId}-delete-${rowIndex}`"
            class="flex flex-col gap-2 bg-[color-mix(in_srgb,var(--d-danger)_6%,transparent)] p-3"
          >
            <div
              :id="`${panelId}-delete-${rowIndex}`"
              class="flex items-center gap-2 font-semibold"
            >
              <TriangleAlert
                class="size-3.75 text-(--d-danger)"
                aria-hidden="true"
              />{{ t('mcp.deleteConfirmTitle') }}
            </div>
            <div class="text-xs text-(--d-muted) text-pretty">
              {{ t('mcp.deleteConfirmWarning', { name: server.name }) }}
            </div>
            <div class="flex justify-end gap-1.5">
              <button
                :ref="setDeleteCancelButton"
                type="button"
                class="d-press flex h-7 items-center rounded-lg px-3 text-xs transition-colors hover:bg-(--d-hover)"
                @click="cancelDelete"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                type="button"
                class="d-press flex h-7 items-center gap-1.5 rounded-lg bg-(--d-danger) px-3 text-xs font-semibold text-(--d-on-danger)"
                @click="confirmDelete"
              >
                <Trash2
                  class="size-3"
                  aria-hidden="true"
                />{{ t('common.delete') }}
              </button>
            </div>
          </div>

          <template v-else>
            <div class="flex items-center gap-2.25 px-3 pt-2.5">
              <button
                type="button"
                class="flex flex-none rounded-sm text-(--d-faint) transition-colors enabled:hover:text-(--d-text) disabled:opacity-35"
                :disabled="!server.tools?.length"
                :aria-expanded="expandedServers.has(server.name)"
                :aria-controls="`${panelId}-tools-${rowIndex}`"
                :aria-label="expandedServers.has(server.name) ? t('overlays.mcp.hideTools') : t('overlays.mcp.showTools')"
                @click="toggleExpanded(server.name)"
              >
                <ChevronRight
                  class="size-3.25 transition-transform duration-200"
                  :class="expandedServers.has(server.name) && 'rotate-90'"
                  aria-hidden="true"
                />
              </button>
              <component
                :is="getStatusIcon(server.status)"
                class="size-3.75 flex-none"
                :class="[getStatusClass(server.status).icon, server.status === 'pending' && 'd-spinning']"
                aria-hidden="true"
              />
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.75">
                <span
                  class="min-w-0 font-mono text-12.5 font-semibold break-all"
                  :class="!server.enabled && 'opacity-50'"
                >{{ server.displayName ?? server.name }}</span>
                <span
                  v-if="getSourceLabel(server.source)"
                  class="whitespace-nowrap rounded-full border border-(--d-border) bg-(--d-hover) px-1.75 text-10/4 text-(--d-faint-text)"
                >{{ getSourceLabel(server.source) }}</span>
              </div>
              <span
                class="flex-none whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--tone,currentColor)_30%,transparent)] bg-[color-mix(in_srgb,var(--tone,currentColor)_13%,transparent)] px-2 py-px text-10.5 font-medium"
                :class="getStatusClass(server.status).chip"
              >{{ getStatusLabel(server.status) }}</span>
              <ToggleSwitch
                :checked="server.enabled"
                :aria-label="t('mcp.toggleServer', { name: server.displayName ?? server.name })"
                @update:checked="(checked: boolean) => emit('toggle', server.name, checked)"
              />
            </div>

            <div class="flex flex-col gap-1 pt-1 pr-3 pb-2.5 pl-11.5 text-11.5">
              <p
                v-if="server.description"
                data-testid="mcp-server-description"
                class="text-(--d-muted) text-pretty wrap-break-word"
              >
                {{ server.description }}
              </p>
              <div class="flex flex-wrap gap-x-2.5 gap-y-0.5 text-(--d-faint)">
                <button
                  v-if="server.tools?.length"
                  type="button"
                  class="transition-colors hover:text-(--d-text)"
                  :aria-expanded="expandedServers.has(server.name)"
                  :aria-controls="`${panelId}-tools-${rowIndex}`"
                  @click="toggleExpanded(server.name)"
                >
                  {{ toolsSummary(server) }}
                </button>
                <span v-else>{{ toolsSummary(server) }}</span>
                <span
                  v-if="server.serverInfo"
                  class="font-mono text-11"
                >{{ server.serverInfo.name }} v{{ server.serverInfo.version }}</span>
              </div>
              <p
                v-if="getServerErrorText(server)"
                data-testid="mcp-server-error"
                class="text-pretty wrap-break-word"
                :class="server.status === 'needs-auth' ? 'text-(--d-warning)' : 'text-(--d-danger)'"
              >
                {{ getServerErrorText(server) }}
              </p>
              <div
                v-if="server.status === 'failed' && server.stderrTail"
                class="flex flex-col gap-1"
              >
                <button
                  type="button"
                  class="-ml-1 flex items-center gap-1 self-start rounded-5 px-1 py-0.5 text-(--d-muted) transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
                  data-testid="mcp-server-stderr-toggle"
                  :aria-expanded="expandedStderr.has(server.name)"
                  :aria-controls="`${panelId}-stderr-${rowIndex}`"
                  @click="toggleStderr(server.name)"
                >
                  <ChevronRight
                    class="size-2.75 transition-transform duration-200"
                    :class="expandedStderr.has(server.name) && 'rotate-90'"
                    aria-hidden="true"
                  />
                  {{ t('mcp.serverOutput') }}
                </button>
                <div
                  v-show="expandedStderr.has(server.name)"
                  :id="`${panelId}-stderr-${rowIndex}`"
                  data-testid="mcp-server-stderr"
                  class="max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word rounded-7 border border-(--d-border) bg-(--d-code) px-2.25 py-1.75 font-mono text-11 leading-[1.55] text-(--d-muted)"
                >
                  <span>{{ server.stderrTail }}</span>
                </div>
              </div>
              <p
                v-if="canDeleteMcpServer(server) && !canEditMcpServer(server)"
                class="text-(--d-faint) text-pretty"
              >
                {{ t('mcp.notFormEditable') }}
              </p>
              <div
                v-if="actions.length > 0"
                class="mt-0.5 flex flex-wrap justify-end gap-1"
              >
                <button
                  v-for="action in actions"
                  :key="action.key"
                  type="button"
                  class="d-press flex h-6 items-center gap-1.25 whitespace-nowrap rounded-7 px-2.25 text-11.5 font-medium transition-colors hover:bg-(--d-hover)"
                  :class="action.class"
                  :data-row-action="action.key"
                  @click="action.run()"
                >
                  <component
                    :is="action.icon"
                    class="size-2.75"
                    aria-hidden="true"
                  />{{ action.label }}
                </button>
              </div>
            </div>

            <Transition name="t-fade">
              <div
                v-if="server.tools?.length && expandedServers.has(server.name)"
                :id="`${panelId}-tools-${rowIndex}`"
                class="mx-3 mb-3 overflow-hidden rounded-lg border border-(--d-border) @min-[35rem]/overlay:ml-11.5"
              >
                <div class="flex items-center bg-(--d-panel) py-1.5 pr-2 pl-2.5 text-11 text-(--d-faint)">
                  <span class="flex-1" />
                  <span class="whitespace-nowrap">{{ availableSummary(server) }}</span>
                </div>
                <div
                  v-for="tool in server.tools"
                  :key="tool.name"
                  class="flex flex-col gap-1.25 border-t border-(--d-border) px-2.5 py-2"
                  data-testid="mcp-tool-row"
                >
                  <div
                    class="flex min-w-0 flex-wrap items-center gap-1.5 transition-opacity duration-200"
                    :class="tool.exposure === 'off' && 'opacity-55'"
                  >
                    <span
                      class="font-mono text-11.5 break-all"
                      :class="tool.exposure === 'off' && 'line-through'"
                    >{{ tool.name }}</span>
                    <span
                      v-if="tool.annotations?.readOnly"
                      class="flex-none rounded-full border border-[color-mix(in_srgb,var(--tone,currentColor)_30%,transparent)] bg-[color-mix(in_srgb,var(--tone,currentColor)_13%,transparent)] px-1.5 text-10/4 d-tone-success"
                    >{{ t('mcp.toolReadOnly') }}</span>
                    <span
                      v-if="tool.annotations?.destructive"
                      class="flex-none rounded-full border border-[color-mix(in_srgb,var(--tone,currentColor)_30%,transparent)] bg-[color-mix(in_srgb,var(--tone,currentColor)_13%,transparent)] px-1.5 text-10/4 d-tone-danger"
                    >{{ t('mcp.toolDestructive') }}</span>
                    <span
                      v-if="tool.annotations?.openWorld"
                      class="flex-none rounded-full border border-[color-mix(in_srgb,var(--tone,currentColor)_30%,transparent)] bg-[color-mix(in_srgb,var(--tone,currentColor)_13%,transparent)] px-1.5 text-10/4 d-tone-accent"
                    >{{ t('mcp.toolNetwork') }}</span>
                  </div>
                  <div class="flex flex-wrap items-center gap-1.5">
                    <SegmentedToggle
                      :model-value="tool.exposure ?? 'deferred'"
                      :options="exposureOptions"
                      :indicator-class="exposureIndicator(tool)"
                      :selected-class="(tool.exposure ?? 'deferred') === 'off' ? 'text-(--d-text)' : 'text-(--d-accent-text)'"
                      class="border border-(--d-border)"
                      data-testid="mcp-tool-exposure"
                      :aria-label="t('mcp.toolExposureLabel', { name: tool.name })"
                      :title="t('mcp.toolExposureTooltip')"
                      @update:model-value="(value: McpToolExposureSetting) => handleToolExposure(server, tool, value)"
                    />
                    <span
                      data-testid="mcp-tool-exposure-source"
                      class="rounded-full border border-(--d-border) bg-(--d-hover) px-1.75 text-10/4 text-(--d-faint-text)"
                      :title="t('mcp.toolExposureSourceTitle', { source: t(`mcp.toolExposureSource.${tool.exposureSource ?? 'config'}`) })"
                    >{{ t(`mcp.toolExposureSource.${tool.exposureSource ?? 'config'}`) }}</span>
                  </div>
                  <p
                    v-if="tool.description"
                    class="text-11 text-(--d-faint) text-pretty"
                  >
                    {{ tool.description }}
                  </p>
                </div>
              </div>
            </Transition>
          </template>
        </div>
      </div>
    </div>
    <!-- The form is its own stack overlay opened over this one; teleported so it is not clipped by this panel. -->
    <Teleport to="body">
      <Transition
        name="t-overlay"
        appear
      >
        <McpServerFormDialog
          v-if="formOpen"
          :editing-name="editingName"
          :editing-config="editingConfig"
          :servers="collisionServers"
          :submitting="mcpWriteInFlight"
          :write-error="mcpWriteError"
          @save="handleFormSave"
          @cancel="closeForm"
        />
      </Transition>
    </Teleport>
  </OverlayShell>
</template>
