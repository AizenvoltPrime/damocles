<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowLeftRight, Check, Ellipsis, ExternalLink, Globe, Plus, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import type { OnDetect, PortRow, PortsView } from '../../preload/ports-channels';
import SidebarSection from './SidebarSection.vue';
import PortDot from './PortDot.vue';
import { menuChoice, portActions, portDotShape, portMenu, primaryAction, remoteText, type PortAction } from './ports-section';

const props = defineProps<{
  api: DamoclesShellApi;
  projectKey: string;
  hostId: string;
  hostName: string;
  collapsed: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();

const section = ref<InstanceType<typeof SidebarSection> | null>(null);
// undefined while loading; null when main forwards no ports for this host
const view = ref<PortsView | null | undefined>(undefined);
const rows = computed(() => view.value?.rows ?? []);
const connected = computed(() => view.value?.connected === true);
// The inline line under the rows: only the latest failed action shows, and any later action clears it.
const failure = ref<string | undefined>();

// Rows that arrived after the host's first list slide in once; the first list, and the list of another host, show at rest.
const arrived = ref(new Set<string>());
let known: Set<string> | undefined;
function show(next: PortsView | null): void {
  const keys = new Set(next?.rows.map((row) => row.key) ?? []);
  if (known && next) {
    const fresh = [...keys].filter((key) => !known!.has(key));
    if (fresh.length > 0) arrived.value = new Set([...arrived.value, ...fresh]);
  }
  known = next ? keys : undefined;
  const refocusAt = focusAfterStop(keys);
  view.value = next;
  if (refocusAt === undefined) return;
  if (rows.value.length > 0) focusRow(Math.min(refocusAt, rows.value.length - 1));
  else void nextTick(() => section.value?.focusHeader());
}

// A stopped row that held focus hands it to the row now at its place, or to the section's header once none is left.
let stopping: { readonly key: string; readonly index: number } | undefined;
function focusAfterStop(keys: ReadonlySet<string>): number | undefined {
  const pending = stopping;
  if (!pending || keys.has(pending.key)) return undefined;
  stopping = undefined;
  return rowElements.get(pending.key)?.contains(document.activeElement) ? pending.index : undefined;
}
function settled(key: string): void {
  if (!arrived.value.has(key)) return;
  const next = new Set(arrived.value);
  next.delete(key);
  arrived.value = next;
}

// A push for this host after the read was asked is newer than the read's answer.
let pushedSinceRead = false;
const stopState = props.api.ports.onState((next) => {
  if (next.hostId !== props.hostId) return;
  pushedSinceRead = true;
  show(next);
});
onBeforeUnmount(stopState);
watch(() => props.hostId, async (hostId) => {
  known = undefined;
  arrived.value = new Set();
  view.value = undefined;
  pushedSinceRead = false;
  stopping = undefined;
  failure.value = undefined;
  const read = await props.api.ports.get(hostId);
  if (props.hostId === hostId && !pushedSinceRead) show(read);
}, { immediate: true });

// One row is in the tab order (roving tabindex); its buttons are the only row buttons Tab reaches.
const active = ref(0);
const activeIndex = computed(() => Math.min(active.value, Math.max(0, rows.value.length - 1)));
const rowElements = new Map<string, HTMLElement>();
function setRowElement(key: string, element: unknown): void {
  if (element instanceof HTMLElement) rowElements.set(key, element);
  else rowElements.delete(key);
}
function focusRow(index: number): void {
  const row = rows.value[index];
  if (!row) return;
  active.value = index;
  void nextTick(() => rowElements.get(row.key)?.focus());
}

// The row whose menu is open keeps its highlight and buttons while focus is in the overlay.
const menuFor = ref<string | null>(null);
const announcement = ref('');
const helpId = useId();

// Copy address answers on the row: its menu button shows a check for a moment.
const COPIED_MS = 1200;
const copiedKey = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(copiedTimer));
async function copied(row: PortRow): Promise<void> {
  copiedKey.value = row.key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedKey.value = null;
  }, COPIED_MS);
  // emptied first, so a second copy is announced again
  announcement.value = '';
  await nextTick();
  announcement.value = t('ports.copied', { address: `http://localhost:${row.localPort}` });
}

const actionLabel = (action: PortAction): string => t(`ports.action.${action}`);
const onDetectLabel = (value: OnDetect): string => t(`ports.onDetect.${value}`);

function attempt(action: () => Promise<unknown>, failed: () => string): Promise<void> {
  failure.value = undefined;
  return action().then(() => undefined, () => {
    failure.value = failed();
  });
}
const rowFailed = (row: PortRow) => (): string => t('ports.failed.row', { port: remoteText(row) });

function run(row: PortRow, action: PortAction): void {
  const { projectKey } = props;
  const ports = props.api.ports;
  const failed = rowFailed(row);
  switch (action) {
    case 'openInPane': void attempt(() => ports.openInPane(projectKey, row.key), failed); return;
    case 'openInBrowser': void attempt(() => ports.openInBrowser(projectKey, row.key), failed); return;
    case 'copyAddress': void attempt(() => ports.copyAddress(projectKey, row.key).then(() => copied(row)), failed); return;
    case 'setLabel': void attempt(() => ports.setLabel(projectKey, row.key), failed); return;
    case 'changeLocalPort': void attempt(() => ports.changeLocalPort(projectKey, row.key), failed); return;
    case 'stop':
      stopping = { key: row.key, index: rows.value.findIndex((candidate) => candidate.key === row.key) };
      void attempt(() => ports.stop(projectKey, row.key), failed);
      return;
    case 'forward': void attempt(() => ports.forwardDetected(projectKey, row.key), failed); return;
  }
}

function setOnDetect(row: PortRow, onDetect: OnDetect): void {
  void attempt(() => props.api.ports.setOnDetect(props.projectKey, row.remotePort, onDetect), rowFailed(row));
}

function undoFallback(): void {
  void attempt(() => props.api.ports.undoFallback(props.projectKey), () => t('ports.failed.undo'));
}

async function openMenu(row: PortRow, anchor: { x: number; y: number; width: number; height: number }): Promise<void> {
  menuFor.value = row.key;
  try {
    const items = portMenu(row, { action: actionLabel, whenDetected: t('ports.whenDetected'), onDetect: onDetectLabel }, connected.value);
    const answer = await props.api.requestOverlay({ kind: 'menu', label: t('ports.menuLabel', { port: remoteText(row) }), anchor, items });
    if (answer.kind !== 'menu') return;
    const choice = menuChoice(answer.itemId);
    if (!choice) return;
    if ('onDetect' in choice) setOnDetect(row, choice.onDetect);
    else run(row, choice.action);
  } finally {
    if (menuFor.value === row.key) menuFor.value = null;
  }
}

function anchorOf(element: Element): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height };
}

function onRowKeydown(event: KeyboardEvent, row: PortRow, index: number): void {
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault();
    void openMenu(row, anchorOf(event.currentTarget as Element));
    return;
  }
  // Keys on a row's own buttons are the buttons'.
  if (event.target !== event.currentTarget) return;
  const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.value.length - 1 };
  const target = moves[event.key];
  if (target !== undefined) {
    event.preventDefault();
    focusRow(Math.min(Math.max(target, 0), rows.value.length - 1));
    return;
  }
  const actions = portActions(row);
  // VS Code's Ports view keys: Enter opens or forwards, F2 labels, Delete stops.
  const action = ({ Enter: primaryAction(row), F2: 'setLabel', Delete: 'stop' } as Record<string, PortAction>)[event.key];
  if (!action || !actions.includes(action)) return;
  event.preventDefault();
  if (connected.value || action === 'setLabel' || action === 'stop') run(row, action);
}

function onRowContextMenu(event: MouseEvent, row: PortRow, index: number): void {
  event.preventDefault();
  active.value = index;
  void openMenu(row, { x: event.clientX, y: event.clientY, width: 0, height: 0 });
}

function forwardPort(): void {
  const forwarding = props.api.ports.forward(props.projectKey);
  void attempt(() => (section.value ? section.value.holdActions(forwarding) : forwarding), () => t('ports.failed.forward'));
}

// "5173 → localhost:5174"; the local part is marked when it differs from the target's port.
const localDiffers = (row: PortRow): boolean => row.localPort !== undefined && row.localPort !== row.remotePort;
const detail = (row: PortRow): string => [row.label, row.processLabel].filter((part) => part !== undefined && part !== '').join(' · ');
function dotLabel(row: PortRow): string {
  switch (portDotShape(row)) {
    case 'live': return t('ports.dot.live', { count: row.liveConnections }, row.liveConnections);
    case 'idle': return t('ports.dot.idle');
    case 'detected': return t('ports.dot.detected');
    case 'ignored': return t('ports.dot.ignored');
    case 'error': return t('ports.dot.error');
    case 'direct': return t('ports.dot.direct');
  }
}
function rowTitle(row: PortRow): string {
  const target = `${props.hostName}:${row.remotePort}`;
  const remote = row.remoteHost === 'localhost' ? target : `${row.remoteHost}:${row.remotePort}`;
  const forward = row.localPort === undefined ? remote : `${remote} → localhost:${row.localPort}`;
  return [forward, row.viaWsl ? t('ports.viaWsl') : undefined, row.processLabel].filter((part) => part !== undefined && part !== '').join(' · ');
}

const ROW_BUTTON = 'd-press size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) [&_svg]:size-3.5';
</script>

<template>
  <SidebarSection
    v-if="view !== null"
    ref="section"
    section="ports"
    data-testid="ports-section"
    class="border-t border-(--d-border)"
    :count="view ? rows.length : undefined"
    :collapsed="collapsed"
    @toggle="emit('toggle')"
  >
    <template #actions>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="ports-forward"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :disabled="!connected"
        :aria-label="t('ports.forward')"
        :title="t('ports.forward')"
        @click="forwardPort"
      >
        <Plus aria-hidden="true" />
      </Button>
    </template>

    <div
      v-if="view"
      data-testid="ports-body"
      :data-away="!connected || undefined"
      class="d-dim-transition max-h-40 min-h-0 overflow-y-auto px-1.5 pb-1.5"
      :class="{ 'opacity-(--d-opacity-disabled)': !connected }"
    >
      <!-- The host forwards only ports seen in terminal output after too many automatic forwards; Undo returns it. -->
      <Transition name="t-tuck">
        <p
          v-if="view.autoForwardMode === 'outputOnly'"
          data-testid="ports-output-only"
          class="mb-1 flex items-center gap-1.5 rounded-lg bg-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] px-2 py-1 text-11 text-(--d-warning-text)"
        >
          <span class="min-w-0 flex-1">{{ t('ports.outputOnly') }}</span>
          <Button
            type="button"
            variant="link"
            data-testid="ports-undo-fallback"
            class="h-auto shrink-0 p-0 text-11 font-semibold text-(--d-warning-text)"
            @click="undoFallback"
          >
            {{ t('ports.undo') }}
          </Button>
        </p>
      </Transition>

      <div
        v-if="rows.length === 0"
        data-testid="ports-empty"
        class="d-fade-in flex items-start gap-2.5 p-1.5"
      >
        <span class="d-state-icon mt-px flex size-6 shrink-0 items-center justify-center rounded-md border border-(--d-border) bg-(--d-bg) text-(--d-faint-text)">
          <ArrowLeftRight
            aria-hidden="true"
            class="size-3.25"
          />
        </span>
        <span class="min-w-0">
          <span class="block text-12 text-(--d-muted)">{{ t('ports.empty') }}</span>
          <span class="block text-11/snug text-(--d-faint)">{{ view.autoForward ? t('ports.emptyHint', { host: hostName }) : t('ports.emptyHintManual') }}</span>
        </span>
      </div>

      <!-- An ARIA table of rows: native table rows cannot leave and move as a TransitionGroup needs. -->
      <div
        v-else
        role="table"
        data-testid="ports-table"
        :aria-label="t('ports.tableLabel', { host: hostName })"
        :aria-describedby="helpId"
        class="relative"
      >
        <div
          role="rowgroup"
          class="sr-only"
        >
          <div role="row">
            <span role="columnheader">{{ t('ports.column.state') }}</span>
            <span role="columnheader">{{ t('ports.column.port') }}</span>
            <span role="columnheader">{{ t('ports.column.actions') }}</span>
          </div>
        </div>
        <TransitionGroup
          :key="hostId"
          tag="div"
          role="rowgroup"
          name="t-row"
          class="relative flex flex-col gap-px"
        >
          <div
            v-for="(row, index) in rows"
            :key="row.key"
            :ref="(element) => setRowElement(row.key, element)"
            role="row"
            data-testid="port-row"
            :data-key="row.key"
            :data-port="row.remotePort"
            :data-state="row.state"
            :data-via-wsl="row.viaWsl"
            :data-menu-open="menuFor === row.key || undefined"
            :data-copied="copiedKey === row.key || undefined"
            :tabindex="index === activeIndex ? 0 : -1"
            :title="rowTitle(row)"
            class="group/port relative flex h-8 shrink-0 items-center gap-2 rounded-lg pr-1 pl-2 outline-none focus-within:bg-(--d-hover) hover:bg-(--d-hover) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-inset data-copied:bg-(--d-hover) data-menu-open:bg-(--d-hover)"
            :class="arrived.has(row.key) ? 'd-row-arrive' : ''"
            @animationend.self="settled(row.key)"
            @focusin="active = index"
            @keydown="onRowKeydown($event, row, index)"
            @contextmenu="onRowContextMenu($event, row, index)"
          >
            <span
              role="cell"
              class="flex shrink-0"
            >
              <PortDot
                :shape="portDotShape(row)"
                :label="dotLabel(row)"
              />
            </span>
            <span
              role="cell"
              class="flex min-w-0 flex-1 flex-col leading-tight"
            >
              <span
                data-testid="port-mapping"
                class="truncate font-mono text-11.5 text-(--d-text)"
              >
                {{ remoteText(row) }}<template v-if="row.state === 'forwarded' && row.localPort !== undefined">
                  <span
                    aria-hidden="true"
                    class="text-(--d-faint)"
                  > → </span><span class="sr-only">{{ ` ${t('ports.forwardedTo')} ` }}</span><Transition
                    name="t-swap"
                    mode="out-in"
                  ><span
                    :key="row.localPort"
                    data-testid="port-local"
                    :data-via="localDiffers(row) || undefined"
                    :class="localDiffers(row) ? 'text-(--d-accent-text)' : ''"
                  >localhost:{{ row.localPort }}</span></Transition><span
                    v-if="row.viaWsl"
                    data-testid="port-via-wsl"
                    class="ms-1.5 inline-flex h-4 items-center rounded-5 bg-(--d-info)/15 px-1.25 align-[0.0625rem] font-sans text-10 font-semibold text-(--d-info-text)"
                    :title="t('ports.viaWslTitle')"
                  ><span class="sr-only">, </span>{{ t('ports.viaWsl') }}</span>
                </template>
                <span
                  v-else
                  data-testid="port-state-text"
                  class="font-sans text-10.5"
                  :class="row.state === 'error' ? 'text-(--d-danger-text)' : 'text-(--d-faint)'"
                > · {{ t(`ports.state.${row.state}`) }}</span>
              </span>
              <span
                v-if="detail(row)"
                data-testid="port-detail"
                class="truncate text-10.5 text-(--d-faint)"
              >{{ detail(row) }}</span>
            </span>
            <span
              role="cell"
              class="flex shrink-0 items-center gap-px"
            >
              <Button
                v-if="row.state !== 'forwarded'"
                type="button"
                variant="outline"
                data-testid="port-forward"
                class="d-press h-5.5 rounded-md border-(--d-border2) bg-transparent px-2 text-11 font-medium text-(--d-text) hover:border-(--d-accent) hover:bg-(--d-accent-soft) hover:text-(--d-accent-text) focus-visible:ring-1 focus-visible:ring-(--d-accent)"
                :tabindex="index === activeIndex ? 0 : -1"
                :disabled="!connected"
                :aria-label="t('ports.forwardRow', { port: remoteText(row) })"
                @click="run(row, 'forward')"
              >
                {{ t('ports.action.forward') }}
              </Button>
              <!-- A forward's buttons lie over the end of its line on the row's own hover ground, so at rest the line reads whole. -->
              <span
                data-testid="port-actions"
                class="pointer-events-none flex items-center gap-px opacity-0 transition-opacity duration-150 group-focus-within/port:pointer-events-auto group-focus-within/port:opacity-100 group-hover/port:pointer-events-auto group-hover/port:opacity-100 group-data-menu-open/port:pointer-events-auto group-data-menu-open/port:opacity-100 group-data-copied/port:opacity-100"
                :class="row.state === 'forwarded' ? 'absolute inset-y-px right-1 bg-[linear-gradient(to_right,transparent,var(--d-hover)_1rem)] ps-5' : ''"
              >
                <template v-if="row.state === 'forwarded'">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="port-open-pane"
                    :class="ROW_BUTTON"
                    :tabindex="index === activeIndex ? 0 : -1"
                    :disabled="!connected"
                    :aria-label="t('ports.rowAction.openInPane', { port: remoteText(row) })"
                    :title="t('ports.action.openInPane')"
                    @click="run(row, 'openInPane')"
                  >
                    <Globe aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="port-open-browser"
                    :class="ROW_BUTTON"
                    :tabindex="index === activeIndex ? 0 : -1"
                    :disabled="!connected"
                    :aria-label="t('ports.rowAction.openInBrowser', { port: remoteText(row) })"
                    :title="t('ports.action.openInBrowser')"
                    @click="run(row, 'openInBrowser')"
                  >
                    <ExternalLink aria-hidden="true" />
                  </Button>
                  <Button
                    v-if="!row.viaWsl"
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="port-stop"
                    :class="[ROW_BUTTON, 'hover:text-(--d-danger-text)']"
                    :tabindex="index === activeIndex ? 0 : -1"
                    :aria-label="t('ports.rowAction.stop', { port: remoteText(row) })"
                    :title="t('ports.action.stop')"
                    @click="run(row, 'stop')"
                  >
                    <X aria-hidden="true" />
                  </Button>
                </template>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid="port-more"
                  :class="ROW_BUTTON"
                  :tabindex="index === activeIndex ? 0 : -1"
                  aria-haspopup="menu"
                  :aria-expanded="menuFor === row.key"
                  :aria-label="t('ports.rowAction.more', { port: remoteText(row) })"
                  :title="t('ports.more')"
                  @click="openMenu(row, anchorOf($event.currentTarget as Element))"
                >
                  <Transition name="t-icon">
                    <Check
                      v-if="copiedKey === row.key"
                      key="copied"
                      aria-hidden="true"
                      data-testid="port-copied"
                      class="text-(--d-success-text)"
                    />
                    <Ellipsis
                      v-else
                      key="more"
                      aria-hidden="true"
                    />
                  </Transition>
                </Button>
              </span>
            </span>
          </div>
        </TransitionGroup>
      </div>
      <p
        v-if="failure"
        role="alert"
        data-testid="ports-failure"
        class="d-fade-in px-2 pt-1 text-11 text-(--d-danger-text)"
      >
        {{ failure }}
      </p>
      <p
        :id="helpId"
        class="sr-only"
      >
        {{ t('ports.keysHelp') }}
      </p>
      <p
        data-testid="ports-announcement"
        class="sr-only"
        role="status"
        aria-live="polite"
      >
        {{ announcement }}
      </p>
    </div>
  </SidebarSection>
</template>
