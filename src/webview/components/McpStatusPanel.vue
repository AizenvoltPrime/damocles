<script setup lang="ts">
import { LOCAL_MCP_RELATIVE_PATH } from '@shared/types/mcp';
import type {
  McpConfigError,
  McpServerConfig,
  McpServerSource,
  McpServerStatusInfo,
  McpWriteErrorInfo,
} from '@shared/types/mcp';
import type { Component } from 'vue';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import { Switch } from '@/components/ui/switch';
import {
  IconCheckCircle,
  IconXCircle,
  IconKey,
  IconGear,
  IconBan,
  IconWarning,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
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
  /** Counts applied `mcpConfigUpdate` payloads, so the panel can see a reload land. */
  configRevision: number;
  visible: boolean;
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
}>();

const hasUntrustedServers = computed(() => props.servers.some((s) => s.untrusted === true));

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
 * Re-read the config when the panel opens, so an edit made to `.gitignore` while the extension was
 * not running does not leave a stale warning on screen. Only the click path raises `reloadInFlight`,
 * so this cannot strand the button, and the transition it watches is driven by the user opening the
 * panel, never by anything a reload sends back.
 */
watch(
  () => props.visible,
  (visible, wasVisible) => {
    if (visible && wasVisible === false) emit('reloadConfig');
  },
);

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
 * Only the visibility flag is cleared. `editingName`/`editingConfig` belong to the child’s reset
 * watcher, which fires on false → true; clearing them here instead mutates the form while reka is
 * still animating it out, so the just-saved name starts colliding with itself and the dialog flashes
 * “Add MCP server” plus a bogus duplicate-name error on its way off screen.
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

watch(
  () => props.mcpWriteInFlight,
  (inFlight, wasInFlight) => {
    if (wasInFlight && !inFlight && props.mcpWriteError === null) closeForm();
  },
);

function requestDelete(server: McpServerStatusInfo): void {
  if (!canDeleteMcpServer(server)) return;
  pendingDeleteName.value = server.name;
}

function confirmDelete(): void {
  const name = pendingDeleteName.value;
  if (name === null) return;
  emit('deleteServer', name);
  pendingDeleteName.value = null;
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

function handleKeydown(e: KeyboardEvent): void {
  // The form and the delete confirmation stack on top of this panel and close themselves on Escape;
  // without this guard the document-level listener would tear the whole panel down underneath them.
  if (formOpen.value || pendingDeleteName.value !== null) return;
  if (e.key === 'Escape' && props.visible) {
    e.stopPropagation();
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  endReload();
});

function getStatusIcon(status: McpServerStatusInfo['status']): Component | null {
  switch (status) {
    case 'connected':
      return IconCheckCircle;
    case 'failed':
      return IconXCircle;
    case 'needs-auth':
      return IconKey;
    case 'pending':
      return null;
    case 'idle':
      return IconGear;
    case 'disabled':
      return IconBan;
    default:
      return IconGear;
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

function getStatusClass(status: McpServerStatusInfo['status']): string {
  switch (status) {
    case 'connected':
      return 'text-success';
    case 'failed':
      return 'text-error';
    case 'needs-auth':
      return 'text-warning';
    case 'pending':
      return 'text-primary';
    case 'idle':
      return 'text-muted-foreground';
    case 'disabled':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}

function getStatusBadgeClass(status: McpServerStatusInfo['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-success/15 text-success border border-success/30';
    case 'failed':
      return 'bg-error/15 text-error border border-error/30';
    case 'needs-auth':
      return 'bg-warning/15 text-warning border border-warning/30';
    case 'pending':
      return 'bg-primary/15 text-primary border border-primary/30';
    case 'idle':
      return 'bg-muted text-muted-foreground border border-border';
    case 'disabled':
      return 'bg-muted text-muted-foreground border border-border';
    default:
      return 'bg-muted text-muted-foreground border border-border';
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
};

/** `source` is optional on the wire, and a server that arrived without one carries no badge. */
function getSourceLabel(source: McpServerStatusInfo['source']): string | null {
  if (source === undefined) return null;
  return t(SOURCE_LABEL_KEYS[source]);
}

/** A contextual button on a server row. */
interface ServerRowAction {
  key: string;
  label: string;
  class: string;
  run: () => void;
}

/**
 * A row's actions as data rather than a run of sibling `v-if`s. A row carries up to five of them and
 * the panel is only `max-w-md` wide, so they render on their own line; deriving them here is what lets
 * that line know whether it has anything to show without restating every button's condition.
 */
function buildRowActions(server: McpServerStatusInfo): ServerRowAction[] {
  const actions: ServerRowAction[] = [];
  if (server.status === 'needs-auth') {
    actions.push({
      key: 'authenticate',
      label: t('mcp.authenticate'),
      class: 'text-warning hover:text-warning',
      run: () => emit('authenticate', server.name),
    });
  }
  if (server.status === 'failed') {
    actions.push({
      key: 'reconnect',
      label: t('mcp.reconnect'),
      class: 'text-error hover:text-error',
      run: () => emit('reconnect', server.name),
    });
  }
  if (server.supportsOAuth && server.status === 'connected') {
    actions.push({
      key: 'reauthenticate',
      label: t('mcp.reauthenticate'),
      class: 'text-warning hover:text-warning',
      run: () => emit('reauthenticate', server.name),
    });
    actions.push({
      key: 'signOut',
      label: t('mcp.signOut'),
      class: 'text-muted-foreground hover:text-foreground',
      run: () => emit('signOut', server.name),
    });
  }
  // Withheld while `~/.damocles/mcp.json` is unusable: every write reads that file first, so none of
  // these can succeed until it parses again.
  if (canEditMcpServer(server) && !damoclesConfigBroken.value) {
    actions.push({
      key: 'edit',
      label: t('mcp.editServer'),
      class: 'text-muted-foreground hover:text-foreground',
      run: () => openEditForm(server),
    });
  }
  if (canDeleteMcpServer(server) && !damoclesConfigBroken.value) {
    actions.push({
      key: 'delete',
      label: t('mcp.deleteServer'),
      class: 'text-muted-foreground hover:text-error',
      run: () => requestDelete(server),
    });
  }
  return actions;
}

const rows = computed(() => props.servers.map((server) => ({ server, actions: buildRowActions(server) })));

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
  <Dialog :open="visible" @update:open="(open: boolean) => !open && emit('close')">
    <DialogContent class="bg-card border-border max-w-md max-h-96 overflow-hidden flex flex-col">
      <DialogHeader class="flex flex-row items-center justify-between shrink-0 pr-8">
        <div>
          <DialogTitle>{{ t('mcp.title') }}</DialogTitle>
          <DialogDescription class="sr-only">
            {{ t('mcp.description') }}
          </DialogDescription>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-xs text-muted-foreground">{{ t('mcp.masterToggle') }}</span>
          <Switch
            :checked="mcpEnabled"
            @update:checked="(checked: boolean) => emit('toggleEnabled', checked)"
          />
        </div>
      </DialogHeader>

      <div class="flex-1 overflow-y-auto py-2">
        <div class="mb-2 flex justify-end gap-1">
          <!--
            `~/.claude.json` is deliberately unwatched, so a server added with `claude mcp add` stays
            invisible until the config is re-read. This is the only way to ask for that.
          -->
          <Button
            size="sm"
            variant="ghost"
            class="h-6 px-2 text-xs"
            :disabled="reloadInFlight"
            :title="t('mcp.reloadConfigTitle')"
            @click="handleReloadClick"
          >
            <LoadingSpinner
              v-if="reloadInFlight"
              :size="12"
              class="mr-1"
            />
            {{ t('mcp.reloadConfig') }}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            class="h-6 px-2 text-xs"
            :disabled="damoclesConfigBroken"
            :title="damoclesConfigBroken ? t('mcp.addServerBlocked') : undefined"
            @click="openAddForm"
          >
            {{ t('mcp.addServer') }}
          </Button>
        </div>

        <div
          v-if="!mcpEnabled"
          class="mb-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          {{ t('mcp.disabledNotice') }}
        </div>

        <!--
          A config file that exists but does not parse. Without this the servers it defines simply
          vanish from the list, which reads as data loss rather than a syntax error.
        -->
        <div
          v-for="configError in configErrors"
          :key="`${configError.path}:${configError.line ?? 0}`"
          class="mb-2 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-muted-foreground"
        >
          <div class="text-error font-medium">{{ t('mcp.configErrorTitle') }}</div>
          <div class="mt-1 font-mono break-all">{{ configError.displayPath }}</div>
          <div class="mt-1">
            {{
              configError.kind === 'unreadable'
                ? t('mcp.configErrorUnreadable')
                : configError.line !== null && configError.column !== null
                  ? t('mcp.configErrorAt', { line: configError.line, column: configError.column })
                  : t('mcp.configErrorUnknown')
            }}
          </div>
          <div class="mt-1.5 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              class="h-6 px-2 text-xs text-error hover:text-error"
              @click="emit('openFile', configError.path, configError.line)"
            >
              {{ t('mcp.configErrorOpen') }}
            </Button>
          </div>
        </div>

        <!--
          `.damocles/mcp.local.json` holds env values and headers in plain text and sits in the working
          tree, so a commit would publish them. Damocles never edits `.gitignore` itself.
        -->
        <div
          v-if="localMcpUnignored"
          role="alert"
          class="mb-2 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-muted-foreground"
        >
          <div class="text-error font-medium flex items-center gap-1.5">
            <IconWarning
              :size="14"
              class="shrink-0"
              aria-hidden="true"
            />
            {{ t('mcp.localMcpUnignoredTitle') }}
          </div>
          <div class="mt-1">
            {{ t('mcp.localMcpUnignored', { line: LOCAL_MCP_RELATIVE_PATH }) }}
          </div>
        </div>

        <div
          v-if="hasUntrustedServers"
          class="mb-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-muted-foreground flex items-center justify-between gap-2"
        >
          <span>{{ t('mcp.untrustedNotice') }}</span>
          <Button size="sm" variant="ghost" class="h-6 px-2 text-xs text-warning hover:text-warning shrink-0" @click="emit('trustProject')">
            {{ t('mcp.trustWorkspace') }}
          </Button>
        </div>

        <div v-if="servers.length === 0" class="text-center py-8 opacity-50">
          <p>{{ t('mcp.noServers') }}</p>
          <p class="text-xs mt-2">{{ t('mcp.addServers') }}</p>
        </div>

        <div v-else class="space-y-2" :class="{ 'opacity-50 pointer-events-none': !mcpEnabled }">
          <Card
            v-for="{ server, actions } in rows"
            :key="server.name"
            class="bg-background border-border hover:bg-background/80 transition-colors"
          >
            <CardContent class="p-3">
              <div class="flex items-center gap-2">
                <div class="shrink-0">
                  <LoadingSpinner v-if="server.status === 'pending'" :size="16" :class="getStatusClass(server.status)" />
                  <component v-else :is="getStatusIcon(server.status)" :size="16" :class="getStatusClass(server.status)" />
                </div>
                <span class="font-medium truncate min-w-0" :class="{ 'opacity-50': !server.enabled }">{{ server.displayName ?? server.name }}</span>
                <span
                  v-if="getSourceLabel(server.source)"
                  class="shrink-0 text-xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground border border-border leading-4"
                >
                  {{ getSourceLabel(server.source) }}
                </span>
                <div class="ml-auto flex items-center gap-2 shrink-0">
                  <span
                    class="text-xs px-2 py-0.5 rounded-full whitespace-nowrap"
                    :class="getStatusBadgeClass(server.status)"
                  >
                    {{ getStatusLabel(server.status) }}
                  </span>
                  <Switch
                    :checked="server.enabled"
                    @update:checked="(checked: boolean) => emit('toggle', server.name, checked)"
                  />
                </div>
              </div>

              <div v-if="actions.length > 0" class="mt-2 flex flex-wrap items-center justify-end gap-1">
                <Button
                  v-for="action in actions"
                  :key="action.key"
                  size="sm"
                  variant="ghost"
                  class="h-6 px-2 text-xs"
                  :class="action.class"
                  @click="action.run()"
                >
                  {{ action.label }}
                </Button>
              </div>

              <!-- A Damocles server whose stored definition uses options this form cannot show. -->
              <div
                v-if="canDeleteMcpServer(server) && !canEditMcpServer(server)"
                class="mt-2 text-xs text-muted-foreground pl-6"
              >
                {{ t('mcp.notFormEditable') }}
              </div>

              <div v-if="server.serverInfo" class="mt-2 text-xs text-muted-foreground pl-6">
                {{ server.serverInfo.name }} v{{ server.serverInfo.version }}
              </div>

              <div v-if="server.error && server.status === 'failed'" class="mt-2 text-xs text-error pl-6 break-words">
                {{ server.error }}
              </div>

              <div v-if="server.tools && server.tools.length > 0" class="mt-2 pl-6">
                <button
                  class="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  @click="toggleExpanded(server.name)"
                >
                  <span class="mr-1">{{ expandedServers.has(server.name) ? '▾' : '▸' }}</span>
                  {{ t('mcp.tools', { count: server.tools.length }) }}
                </button>

                <div v-if="expandedServers.has(server.name)" class="mt-1.5 space-y-1">
                  <div
                    v-for="tool in server.tools"
                    :key="tool.name"
                    class="text-xs"
                  >
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="font-mono text-foreground">{{ tool.name }}</span>
                      <span
                        v-if="tool.annotations?.readOnly"
                        class="px-1.5 py-0 rounded-full bg-success/15 text-success border border-success/30 text-xs leading-4"
                      >
                        {{ t('mcp.toolReadOnly') }}
                      </span>
                      <span
                        v-if="tool.annotations?.destructive"
                        class="px-1.5 py-0 rounded-full bg-error/15 text-error border border-error/30 text-xs leading-4"
                      >
                        {{ t('mcp.toolDestructive') }}
                      </span>
                      <span
                        v-if="tool.annotations?.openWorld"
                        class="px-1.5 py-0 rounded-full bg-primary/15 text-primary border border-primary/30 text-xs leading-4"
                      >
                        {{ t('mcp.toolNetwork') }}
                      </span>
                    </div>
                    <p v-if="tool.description" class="text-muted-foreground mt-0.5 pl-0">
                      {{ tool.description }}
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <McpServerFormDialog
    :visible="formOpen"
    :editing-name="editingName"
    :editing-config="editingConfig"
    :servers="collisionServers"
    :submitting="mcpWriteInFlight"
    :write-error="mcpWriteError"
    @save="handleFormSave"
    @cancel="closeForm"
  />

  <AlertDialog
    :open="pendingDeleteName !== null"
    @update:open="(open: boolean) => !open && (pendingDeleteName = null)"
  >
    <AlertDialogContent class="bg-card border-border max-w-md">
      <AlertDialogHeader>
        <AlertDialogTitle class="flex items-center gap-2">
          <IconWarning :size="20" class="text-error" />
          {{ t('mcp.deleteConfirmTitle') }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {{ t('mcp.deleteConfirmWarning', { name: pendingDeleteName ?? '' }) }}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div class="flex justify-end gap-2 mt-4">
        <Button variant="ghost" @click="pendingDeleteName = null">
          {{ t('common.cancel') }}
        </Button>
        <Button
          class="bg-destructive hover:bg-destructive/80 text-destructive-foreground"
          @click="confirmDelete"
        >
          {{ t('common.delete') }}
        </Button>
      </div>
    </AlertDialogContent>
  </AlertDialog>
</template>
