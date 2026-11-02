<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Box, ChevronRight, FolderOpen, FolderSearch, Laptop, LoaderCircle, Plug, Plus, RefreshCw, Search, Server, SquareTerminal, X } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import SegmentedToggle from '@/components/SegmentedToggle.vue';
import { visibleLines, visibleText } from '@shared/visible-text';
import type {
  ConnectStepEvent,
  ConnectTarget,
  ContainerFolderPick,
  ContainerListResult,
  DamoclesOverlayApi,
  HostCardInfo,
  HostParseResult,
  HostRun,
  NameCheck,
  OverlayAnswer,
  OverlayRequest,
  RunningContainer,
  WslDistroInfo,
} from '../../../preload/overlay-channels';
import { answerOf, ran } from '../popup-answer';
import { distroDetail, isDefiniteRefusal, otherDeviceCount, refusalText, wslVersionName } from '../connect-text';
import HostBadge from '@/components/HostBadge.vue';
import HostStatusDot from '../../components/HostStatusDot.vue';
import DistroStateDot from '../../components/DistroStateDot.vue';
import ContainerStateDot from '../../components/ContainerStateDot.vue';
import ContainerRebuild from './ContainerRebuild.vue';
import HostActions from './HostActions.vue';
import HostCard from './HostCard.vue';
import HostKeyDialog from './HostKeyDialog.vue';
import HostNameField from './HostNameField.vue';
import RemoteFolderBrowser from './RemoteFolderBrowser.vue';
import StepTimeline from './StepTimeline.vue';
import WslConversion from './WslConversion.vue';

type View = 'hosts' | 'name' | 'card' | 'timeline' | 'folders' | 'where' | 'attach';

// Connect to Host: the saved hosts, ~/.ssh/config aliases and WSL distros as cards, "+ New host" typed or pasted into the search
// box, the Name step for a host being saved, a host's card, the attempt's timeline and then the host's folders. Main owns the
// attempt; every step arrives on onConnectStep, every host change on onConnectHosts and the distros with it on onConnectDistros.
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'connect' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const hosts = shallowRef<readonly HostCardInfo[]>(props.request.hosts);
const distros = shallowRef<readonly WslDistroInfo[]>(props.request.distros);
const view = ref<View>('hosts');
const query = ref(props.request.query ?? '');
// main's parse of the typed text, kept with that text: a card is offered only for the text in the box now
const parsed = shallowRef<{ readonly input: string; readonly result: HostParseResult } | undefined>();
// A failed call: said where it was made, never thrown into the page.
const actionFailed = ref(false);

// The host the card, timeline or folder browser shows.
const hostId = ref<string | undefined>(props.request.hostId);
const host = computed(() => hosts.value.find((candidate) => candidate.hostId === hostId.value));
const attempt = shallowRef<ConnectStepEvent | undefined>(props.request.attempt);
// The name and address shown for an attempt whose host the list does not hold yet.
const pending = ref<{ name: string; destination: string; kind: HostCardInfo['kind'] } | undefined>();
// A remote core's picker: the host's folder browser alone, answering the picked path.
const picker = props.request.pick;
const hostName = computed(() => host.value?.name ?? picker?.hostName ?? pending.value?.name ?? '');
const destination = computed(() => (host.value?.wsl ? distroDetail(host.value.name, host.value.wsl) : host.value?.destinationLabel ?? pending.value?.destination ?? ''));
const running = computed(() => attempt.value !== undefined && attempt.value.step !== 'connected' && attempt.value.step !== 'failed');
// Opened to rename a host: its card opens once with the name field open; opened to rebuild, with the rebuild confirmation.
const renameOnCard = ref(props.request.card === 'rename');
const rebuildOnCard = ref(props.request.card === 'rebuild');
// A passwordless setup, a removal or a conversion runs in the card, which shows its progress.
const actionsBusy = ref(false);
const converting = ref(false);
const rebuilding = ref(false);
const cardBusy = computed(() => actionsBusy.value || converting.value || rebuilding.value);
watch(view, (next) => {
  if (next !== 'card') {
    renameOnCard.value = false;
    rebuildOnCard.value = false;
    actionsBusy.value = false;
    converting.value = false;
    rebuilding.value = false;
  }
  if (next === 'hosts') containerFlow.value = undefined;
});
// A forgotten host leaves the list, and its card goes with it.
watch(host, (shown) => {
  if (!shown && view.value === 'card') view.value = 'hosts';
});

async function act<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    actionFailed.value = false;
    return await call();
  } catch {
    actionFailed.value = true;
    return undefined;
  }
}

let closed = false;
function close(): void {
  if (closed) return;
  closed = true;
  emit('answer', { kind: 'dismissed' });
}

// Escape and Cancel on an attempt in progress end its ssh first; closing any other way leaves a waiting attempt to its banner.
async function cancelAndClose(): Promise<void> {
  const current = attempt.value;
  if (view.value === 'timeline' && current && running.value && !(await act(() => props.api.cancelConnect(current.attemptId)))) return;
  close();
}

function onEscape(event: KeyboardEvent): void {
  event.preventDefault();
  void cancelAndClose();
}

// A stray click beside the panel never drops an attempt in progress, a name being typed or a card action's progress.
function onOutside(event: Event): void {
  if (view.value === 'timeline' || view.value === 'name' || (view.value === 'card' && cardBusy.value)) event.preventDefault();
}

// ---- host list ----

const search = ref<InstanceType<typeof Input> | null>(null);
const savedNames = computed(() => new Set(hosts.value.map((saved) => saved.name.toLocaleLowerCase('en'))));
const filter = computed(() => query.value.trim().toLocaleLowerCase('en'));
const matches = (...texts: string[]): boolean => filter.value === '' || texts.some((text) => text.toLocaleLowerCase('en').includes(filter.value));
// A saved distro shows as its distro's card; one wsl.exe no longer lists stays a saved host, so it can still be forgotten.
const listedDistroHosts = computed(() => new Set(distros.value.flatMap((distro) => (distro.hostId === undefined ? [] : [distro.hostId]))));
const shownHosts = computed(() => hosts.value.filter((saved) => saved.kind !== 'container' && !(saved.kind === 'wsl' && listedDistroHosts.value.has(saved.hostId)) && matches(saved.name, saved.destinationLabel)));
// Saved containers show under Dev Containers, after the two ways to add one, which show while nothing is typed.
const shownContainers = computed(() => hosts.value.filter((saved) => saved.kind === 'container' && matches(saved.name, saved.destinationLabel, saved.container?.via?.name ?? '')));
const shownAliases = computed(() => props.request.sshConfigAliases.filter((alias) => filter.value === '' || alias.toLocaleLowerCase('en').includes(filter.value)));
// A distro with a host record shows its host's name and connection.
interface DistroCard {
  readonly info: WslDistroInfo;
  readonly host?: HostCardInfo;
  readonly name: string;
}
const shownDistros = computed(() => distros.value.flatMap((info): DistroCard[] => {
  const saved = info.hostId === undefined ? undefined : hosts.value.find((candidate) => candidate.hostId === info.hostId);
  const name = saved?.name ?? info.distro;
  return matches(name, info.distro) ? [saved ? { info, host: saved, name } : { info, name }] : [];
}));
// the host's connection once it is anything but offline, else whether wsl.exe runs the distro
const distroStateText = (card: DistroCard): string => (card.host && card.host.connection !== 'offline' ? t(`projects.connection.${card.host.connection}`) : t(`remote.distro.state.${card.info.state}`));
// The second line: the distro when the name differs, WSL 2 (WSL 1 has its chip) and the state, as the mockup's "WSL 2 · running".
const distroLine = (card: DistroCard): string[] => [
  ...(card.name === card.info.distro ? [] : [card.info.distro]),
  ...(card.info.version === 2 ? [wslVersionName(2)] : []),
  distroStateText(card),
];

// the host's connection once it is anything but offline, else the container's state as docker last reported it
const containerStateText = (saved: HostCardInfo): string => (saved.connection !== 'offline' || !saved.container ? t(`projects.connection.${saved.connection}`) : t(`remote.container.state.${saved.container.state}`));
// The second line, as the mockup's "Attach · typescript-node:22 · running", with the SSH host it runs on.
const containerLine = (saved: HostCardInfo): string => {
  const container = saved.container;
  if (!container) return saved.destinationLabel;
  return [
    t(`remote.container.origin.${container.origin}`),
    // the image's own name, as the mockup's "typescript-node:22"; the card shows the full reference
    ...(container.image === undefined ? [] : [visibleText(container.image.slice(container.image.lastIndexOf('/') + 1))]),
    containerStateText(saved),
    ...(container.via ? [t('remote.container.via', { host: container.via.name })] : []),
  ].join(' · ');
};

function pickDistro(card: DistroCard): void {
  if (card.host) connectSaved(card.host);
  else openNameStep({ kind: 'distro', distro: card.info.distro }, card.info.distro);
}

// the cards above the Dev Containers section, which follow them in the stagger
const cardsBefore = computed(() => shownHosts.value.length + shownAliases.value.length + shownDistros.value.length);
// the first 8 cards enter 40 ms apart; later ones enter with the eighth
const staggered = (index: number): Record<string, number> => ({ '--card-index': Math.min(index, 7) });
// The typed entry is offered unless it is exactly a listed host or alias, which the cards already offer.
const parsedNow = computed(() => (parsed.value?.input === query.value.trim() ? parsed.value.result : undefined));
const newHost = computed(() => {
  const result = parsedNow.value;
  if (!result?.ok || filter.value === '') return undefined;
  const exact = savedNames.value.has(filter.value) || props.request.sshConfigAliases.some((alias) => alias.toLocaleLowerCase('en') === filter.value);
  return exact ? undefined : result;
});
// A definite refusal (a refused option or value) always shows; one typing may still complete shows only when no card matches.
const refused = computed(() => {
  const result = parsedNow.value;
  if (!result || result.ok || filter.value === '') return undefined;
  return isDefiniteRefusal(result.reason) || (shownHosts.value.length === 0 && shownAliases.value.length === 0) ? result : undefined;
});

let parseTicket = 0;
async function onQuery(): Promise<void> {
  const ticket = ++parseTicket;
  const input = query.value.trim();
  if (input === '') {
    parsed.value = undefined;
    return;
  }
  const result = await act(() => answerOf(props.api.parseHost(input)));
  if (ticket === parseTicket) parsed.value = result && { input, result };
}

function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-connect-card]')];
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    cards()[0]?.focus();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    cards()[0]?.click();
  }
}

function onCardKeydown(event: KeyboardEvent, details?: string): void {
  const list = cards();
  const index = list.indexOf(event.currentTarget as HTMLElement);
  if (event.key === 'ArrowDown') list[index + 1]?.focus();
  else if (event.key === 'ArrowUp') (index === 0 ? (search.value?.$el as HTMLElement | undefined) : list[index - 1])?.focus();
  else if (event.key === 'ArrowRight' && details !== undefined) void openCard(details);
  else return;
  event.preventDefault();
}

// ---- name step ----

const nameDraft = ref('');
const nameField = ref<InstanceType<typeof HostNameField> | null>(null);
// What the Name step saves: the typed "+ New host" entry, or an ssh alias whose own name clashes.
// shown: what the Name step names, a container's name or a folder with a dev container
type ContainerNaming = { readonly attach: string; readonly via?: string; readonly user: 'configured' | 'root' } | { readonly devcontainer: string; readonly via?: string };
const naming = shallowRef<{ kind: 'input'; input: string; destination: string } | { kind: 'alias'; alias: string } | { kind: 'distro'; distro: string } | { kind: 'container'; target: ContainerNaming; shown: string } | undefined>();
const namingShown = computed(() => {
  const target = naming.value;
  switch (target?.kind) {
    case 'input': return target.destination;
    case 'alias': return target.alias;
    case 'distro': return target.distro;
    case 'container': return target.shown;
  }
  return '';
});

// A refusal main gave before the Name step showed, applied once its field is on screen.
let pendingRefusal: Extract<NameCheck, { ok: false }> | undefined;

function openNameStep(target: NonNullable<typeof naming.value>, prefill: string, refusal?: Extract<NameCheck, { ok: false }>): void {
  naming.value = target;
  nameDraft.value = prefill;
  pendingRefusal = refusal;
  view.value = 'name';
}

async function submitName(name: string): Promise<void> {
  const target = naming.value;
  if (!target) return;
  if (target.kind === 'distro') await start({ distro: target.distro, name }, { name, destination: target.distro, kind: 'wsl' });
  else if (target.kind === 'container') await start({ ...target.target, name }, { name, destination: target.shown, kind: 'container' });
  else if (target.kind === 'input') await start({ input: target.input, name }, { name, destination: target.destination, kind: 'ssh' });
  else await start({ alias: target.alias, name }, { name, destination: target.alias, kind: 'ssh' });
}

// ---- attempts ----

let connectedTimer: ReturnType<typeof setTimeout> | undefined;
// Main pushes the step of every attempt a start begins or joins, before its answer, so each attempt's latest step is kept here.
const steps = new Map<string, ConnectStepEvent>();
// The attempt start() was answered with, until main's step for it shows.
let started: string | undefined;
// The attempt connects a "+ New host" entry, whose Edit host goes back to the typed text in the host list.
const attemptFromInput = ref(false);

async function start(target: ConnectTarget, shown?: { name: string; destination: string; kind: HostCardInfo['kind'] }): Promise<void> {
  const result = await act(() => answerOf(props.api.startConnect(target)));
  if (!result) return;
  if (!result.ok) {
    if (result.reason === 'name' && !result.check.ok) {
      if (view.value === 'name') nameField.value?.refuse(result.check);
      else if ('alias' in target) openNameStep({ kind: 'alias', alias: target.alias }, target.alias, result.check);
    } else if (result.reason === 'refused') {
      parsed.value = { input: 'input' in target ? target.input : query.value.trim(), result: { ok: false, refused: result.refused, reason: result.refusal } };
      view.value = 'hosts';
    }
    return;
  }
  pending.value = shown;
  attemptFromInput.value = 'input' in target;
  hostId.value = result.hostId;
  // a container attempt of its own starts a flow of its own; the SSH host it runs on was only a way there
  if ('attach' in target || 'devcontainer' in target || hosts.value.find((candidate) => candidate.hostId === result.hostId)?.kind === 'container') containerFlow.value = undefined;
  started = result.attemptId;
  const known = steps.get(result.attemptId);
  if (known) showStarted(known);
}

function connectSaved(saved: HostCardInfo): void {
  hostId.value = saved.hostId;
  if (saved.connection === 'connected') view.value = 'folders';
  else void start({ hostId: saved.hostId });
}

// Main opens a dev container's own folder and closes this dialog itself, so its timeline stays until then.
const opensItsFolder = (id: string): boolean => hosts.value.find((candidate) => candidate.hostId === id)?.container?.origin === 'devcontainer';

function showConnected(id: string): void {
  const flow = containerFlow.value;
  if (flow?.kind === 'attach' && flow.via === id) void openAttach(flow.via);
  else view.value = 'folders';
}

function showStarted(event: ConnectStepEvent): void {
  started = undefined;
  attempt.value = event;
  // a host that was connected before this start goes straight on, as a connected saved host does
  if (event.step === 'connected' && !opensItsFolder(event.hostId)) showConnected(event.hostId);
  else view.value = 'timeline';
}

function onStep(event: ConnectStepEvent): void {
  steps.set(event.attemptId, event);
  if (event.attemptId === started) {
    showStarted(event);
    return;
  }
  if (event.attemptId !== attempt.value?.attemptId && event.hostId !== hostId.value) return;
  attempt.value = event;
  // Cancel, which held focus, goes with the attempt; the failure's first action takes it.
  if ((event.step === 'failed' || event.folderFailure) && view.value === 'timeline') void nextTick(() => frame.value?.querySelector<HTMLElement>('[data-failure-actions] button')?.focus());
  if (event.step !== 'connected' || view.value !== 'timeline' || opensItsFolder(event.hostId)) return;
  // The finished timeline stays a moment, so the last check mark is seen before the folders replace it.
  clearTimeout(connectedTimer);
  connectedTimer = setTimeout(() => {
    if (view.value === 'timeline') showConnected(event.hostId);
  }, prefersReducedMotion() ? 0 : 450);
}

const hostKeyPrompt = computed(() => {
  const prompt = attempt.value?.prompt;
  return prompt?.kind === 'hostKey' ? prompt : undefined;
});
const changedKeyDismissed = ref<string | undefined>();
const changedKey = computed(() => {
  const current = attempt.value;
  const failure = current?.failure;
  if (failure?.code !== 'hostKeyChanged' || changedKeyDismissed.value === current?.attemptId) return undefined;
  const { host, command } = failure.params;
  return { host: typeof host === 'string' ? host : undefined, command: typeof command === 'string' ? command : undefined };
});

async function answer(promptId: string, value: string | null, remember = false): Promise<void> {
  const current = attempt.value;
  if (current) await act(() => props.api.answerConnect(current.attemptId, promptId, value, remember));
}

async function showLog(id: string): Promise<void> {
  // The log opens as editor tabs behind this dialog, so the dialog makes way for them.
  if (await act(() => ran(props.api.showHostLog(id)))) close();
}

// Main ends this request and opens Settings, Remote hosts on the host.
async function openSettings(id: string): Promise<void> {
  await act(() => ran(props.api.openHostSettings(id)));
}

// ---- host card ----

const runs = shallowRef<readonly HostRun[] | 'failed' | undefined>();

async function loadRuns(id: string): Promise<void> {
  try {
    const listed = await answerOf(props.api.hostRuns(id));
    if (listed !== undefined && hostId.value === id) runs.value = listed;
  } catch {
    if (hostId.value === id) runs.value = 'failed';
  }
}

async function openCard(id: string): Promise<void> {
  hostId.value = id;
  runs.value = undefined;
  view.value = 'card';
  await loadRuns(id);
}

// what runs there changes with the connection: a drop or a removed server ends the daemon's list, a connect starts one
watch(() => (view.value === 'card' ? host.value?.connection : undefined), (now, before) => {
  const id = hostId.value;
  if (id !== undefined && now !== undefined && before !== undefined && now !== before) void loadRuns(id);
});

async function kill(runId: string): Promise<void> {
  const id = hostId.value;
  if (id !== undefined && (await act(() => ran(props.api.killHostRun(id, runId))))) await loadRuns(id);
}

// A saved host's Edit host opens its card with the name field open, as the shell banner's does.
function editHost(): void {
  const current = attempt.value;
  if (!current || attemptFromInput.value) {
    view.value = 'hosts';
    return;
  }
  renameOnCard.value = true;
  void openCard(current.hostId);
}

// Main gives the terminal a tab and focuses it, so the dialog makes way; a refusal lists the runs again.
async function openRun(runId: string): Promise<void> {
  const id = hostId.value;
  if (id === undefined) return;
  if (await act(() => ran(props.api.openHostRun(id, runId)))) close();
  else if (actionFailed.value) await loadRuns(id);
}

// ---- folders ----

async function pick(path: string): Promise<void> {
  const id = hostId.value;
  if (id === undefined) return;
  const flow = containerFlow.value;
  if (flow?.kind === 'devcontainer' && flow.via === id) {
    await openDevcontainer(await act(() => answerOf(props.api.checkContainerFolder(id, path))), id);
    return;
  }
  if (picker) {
    if (closed) return;
    closed = true;
    emit('answer', { kind: 'connect', path });
    return;
  }
  if (await act(() => answerOf(props.api.pickHostFolder(id, path)))) close();
}

// ---- dev containers ----

// The way to a container the where, folders and attach views serve: a folder's dev container, or a running container; via names
// the SSH host the engine runs on, absent for this computer.
const containerFlow = ref<{ readonly kind: 'devcontainer' | 'attach'; readonly via?: string } | undefined>();
// A folder without a dev container, or a host that could not answer, said in the view that asked.
const containerRefusal = ref<string | undefined>();
watch(view, () => (containerRefusal.value = undefined));
const sshHosts = computed(() => hosts.value.filter((saved) => saved.kind === 'ssh'));

function openContainerFlow(kind: 'devcontainer' | 'attach'): void {
  containerFlow.value = { kind };
  view.value = 'where';
}

async function chooseWhere(via?: HostCardInfo): Promise<void> {
  const flow = containerFlow.value;
  if (!flow) return;
  if (via === undefined) {
    if (flow.kind === 'attach') await openAttach(undefined);
    else await openDevcontainer(await act(() => answerOf(props.api.pickContainerFolder())), undefined);
    return;
  }
  containerFlow.value = { kind: flow.kind, via: via.hostId };
  if (flow.kind === 'attach' && via.connection === 'connected') {
    hostId.value = via.hostId;
    await openAttach(via.hostId);
  } else {
    // the folder browser of a connected host, else its timeline first
    connectSaved(via);
  }
}

// A picked folder: one with a record reconnects it, a new one is named first.
async function openDevcontainer(picked: ContainerFolderPick | null | undefined, via: string | undefined): Promise<void> {
  if (!picked) return;
  if (!picked.ok) {
    containerRefusal.value = picked.code === 'noDevcontainerConfig' ? t('remote.container.noConfig', { folder: visibleText(picked.folder) }) : t('remote.container.notConnected');
    return;
  }
  if (picked.hostId !== undefined) {
    await start({ hostId: picked.hostId });
    return;
  }
  openNameStep({ kind: 'container', target: { devcontainer: picked.folder, ...(via === undefined ? {} : { via }) }, shown: picked.folder }, picked.prefillName);
}

const attachList = shallowRef<ContainerListResult | undefined>();
const attachUser = ref<'configured' | 'root'>('configured');
const attachUserLabel = useId();
// "on this computer" or "on prod-1", with the preposition each language needs
const attachWhere = computed(() => {
  const via = containerFlow.value?.via;
  return via === undefined ? t('remote.container.onThisComputer') : t('remote.container.via', { host: hosts.value.find((candidate) => candidate.hostId === via)?.name ?? '' });
});

async function openAttach(via: string | undefined): Promise<void> {
  containerFlow.value = { kind: 'attach', ...(via === undefined ? {} : { via }) };
  view.value = 'attach';
  await loadContainers();
}

let listTicket = 0;
async function loadContainers(): Promise<void> {
  const ticket = ++listTicket;
  const via = containerFlow.value?.via;
  attachList.value = undefined;
  let listed: ContainerListResult | undefined;
  try {
    listed = await answerOf(props.api.listContainers(via));
  } catch {
    listed = { ok: false, code: 'listFailed' };
  }
  if (ticket === listTicket && listed) attachList.value = listed;
}

const attachFailure = computed(() => {
  const listed = attachList.value;
  if (!listed || listed.ok) return undefined;
  return { code: listed.code, text: t(`remote.container.listFailure.${listed.code}`, { where: attachWhere.value }), message: listed.message };
});

// A container with a record attaches under its name as the user chosen here, which main saves on the record; a new one is named first.
function attachTo(container: RunningContainer): void {
  const via = containerFlow.value?.via;
  const target = { attach: container.id, user: attachUser.value, ...(via === undefined ? {} : { via }) };
  const saved = container.hostId === undefined ? undefined : hosts.value.find((candidate) => candidate.hostId === container.hostId);
  if (saved) void start({ ...target, name: saved.name }, { name: saved.name, destination: visibleText(container.name), kind: 'container' });
  else openNameStep({ kind: 'container', target, shown: visibleText(container.name) }, container.prefillName);
}

// "node" or "root": the user the chosen Attach as runs the container's shell as
const attachUserName = (container: RunningContainer): string => (attachUser.value === 'root' || container.user === undefined || container.user === '' ? 'root' : visibleText(container.user));

const stops: Array<() => void> = [];
stops.push(props.api.onConnectHosts((next) => (hosts.value = next)));
stops.push(props.api.onConnectDistros((next) => (distros.value = next)));
stops.push(props.api.onConnectStep(onStep));

onMounted(() => {
  const id = props.request.hostId;
  const target = id === undefined ? undefined : hosts.value.find((candidate) => candidate.hostId === id);
  if (picker) view.value = 'folders';
  else if (props.request.attempt) view.value = 'timeline';
  else if (target && props.request.card !== undefined) void openCard(target.hostId);
  else if (target) connectSaved(target);
  else if (query.value !== '') void onQuery();
});
onBeforeUnmount(() => {
  clearTimeout(connectedTimer);
  for (const stop of stops) stop();
});

// Each view takes focus once it is on screen: the Name step its field, another view its marked control, else its first one.
const frame = ref<HTMLElement | null>(null);
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';
function focusView(): void {
  if (view.value === 'name') {
    nameField.value?.focus();
    nameField.value?.select();
    if (pendingRefusal) nameField.value?.refuse(pendingRefusal);
    pendingRefusal = undefined;
    return;
  }
  const root = frame.value;
  if (root?.contains(document.activeElement) && document.activeElement !== root && view.value !== 'hosts') return;
  (root?.querySelector<HTMLElement>('[data-view-focus]') ?? root?.querySelector<HTMLElement>(`[data-view] :is(${FOCUSABLE})`))?.focus();
}

// The host-key modals stack on the dialog only once it is open: a modal mounted with it would be hidden by the dialog's own aria-hidden of everything else.
const dialogOpen = ref(false);
function onOpenFocus(event: Event): void {
  event.preventDefault();
  dialogOpen.value = true;
  void nextTick(focusView);
}

const title = computed(() => {
  switch (view.value) {
    case 'hosts': return t('remote.connect.title');
    case 'name': return naming.value?.kind === 'distro' ? t('remote.name.titleDistro') : naming.value?.kind === 'container' ? t('remote.name.titleContainer') : t('remote.name.title');
    case 'where': return containerFlow.value?.kind === 'attach' ? t('remote.container.attachTitle') : t('remote.container.openTitle');
    case 'attach': return t('remote.container.runningOn', { where: attachWhere.value });
    case 'card': return t('remote.card.title', { name: hostName.value });
    case 'timeline': return hostName.value;
    case 'folders':
      if (containerFlow.value?.kind === 'devcontainer') return t('remote.container.folderTitle', { name: hostName.value });
      if (!picker) return t('remote.folders.title', { name: hostName.value });
      return picker.title !== undefined ? t('remote.pick.titled', { name: hostName.value, title: picker.title }) : t(`remote.pick.${picker.mode}Title`, { name: hostName.value });
  }
  return '';
});

// A distro's views show the distro icon and a container's the box where a host's show the server.
const shownKind = computed((): HostCardInfo['kind'] => {
  if (view.value === 'where' || view.value === 'attach') return 'container';
  if (view.value === 'name') return naming.value?.kind === 'distro' ? 'wsl' : naming.value?.kind === 'container' ? 'container' : 'ssh';
  return host.value?.kind ?? pending.value?.kind ?? 'ssh';
});
const KIND_ICONS = { ssh: Server, wsl: SquareTerminal, container: Box } as const;
const viewIcon = computed(() => (view.value === 'hosts' ? Plug : view.value === 'folders' ? FolderOpen : KIND_ICONS[shownKind.value]));
</script>

<template>
  <Dialog
    :open="true"
    @update:open="(open: boolean) => !open && close()"
  >
    <DialogContent
      inline
      :show-close="false"
      data-testid="connect-dialog"
      :data-pick-mode="picker?.mode"
      :aria-describedby="undefined"
      class="connect-dialog flex max-h-[86vh] outline-none w-[min(47rem,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 @container"
      :class="view === 'name' ? 'h-auto' : 'h-[min(40rem,86vh)]'"
      @open-auto-focus="onOpenFocus"
      @escape-key-down="onEscape"
      @interact-outside="onOutside"
    >
      <div
        ref="frame"
        class="relative flex min-h-0 flex-1 flex-col"
      >
        <!-- The host card draws its own heading, so its view keeps only the dialog's name and Close, laid over the card's corner. -->
        <div
          class="flex items-center gap-2.5 px-4.5 pt-4 pb-1"
          :class="view === 'card' && 'absolute top-0 right-0 z-1'"
        >
          <span
            v-if="view !== 'card'"
            aria-hidden="true"
            class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--d-accent-soft) text-(--d-accent-text)"
          >
            <component
              :is="viewIcon"
              class="size-4.5"
            />
          </span>
          <div
            class="flex min-w-0 flex-col"
            :class="view !== 'card' && 'flex-1'"
          >
            <DialogTitle
              class="truncate text-15 font-semibold"
              :class="view === 'card' && 'sr-only'"
            >
              {{ title }}
            </DialogTitle>
            <span
              v-if="view === 'timeline' && destination"
              dir="ltr"
              class="truncate font-mono text-11 text-(--d-faint-text)"
            >{{ destination }}</span>
          </div>
          <Button
            v-if="view === 'timeline' && running"
            type="button"
            data-view-focus
            variant="ghost"
            size="sm"
            class="h-7 rounded-7 px-2.5 text-12 text-(--d-muted)"
            @click="cancelAndClose"
          >
            {{ t('remote.timeline.cancel') }}
            <kbd class="rounded-5 border border-(--d-border2) px-1 font-mono text-10 text-(--d-faint-text)">Esc</kbd>
          </Button>
          <Button
            v-else
            type="button"
            variant="ghost"
            size="icon-sm"
            class="size-7 rounded-7 text-(--d-muted)"
            :aria-label="t('remote.connect.close')"
            @click="close"
          >
            <X
              aria-hidden="true"
              class="size-3.5"
            />
          </Button>
        </div>

        <Transition
          name="t-swap-box"
          mode="out-in"
          @after-enter="focusView"
        >
          <div
            v-if="view === 'hosts'"
            key="hosts"
            data-view
            class="flex min-h-0 flex-1 flex-col"
          >
            <div class="relative px-4.5 py-2 ">
              <Search
                aria-hidden="true"
                class="pointer-events-none absolute top-4.5 left-7 size-3.5 text-(--d-faint)"
              />
              <Input
                ref="search"
                v-model="query"
                data-view-focus
                autocomplete="off"
                spellcheck="false"
                :aria-label="t('remote.connect.search')"
                :placeholder="t('remote.connect.searchPlaceholder')"
                class="h-9 rounded-lg border-(--d-border2) bg-(--d-input) pr-2.5 pl-8.5 text-13 text-(--d-text) focus-visible:border-(--d-accent) focus-visible:ring-3 focus-visible:ring-(--d-accent-soft) focus-visible:ring-offset-0"
                @update:model-value="onQuery"
                @keydown="onSearchKeydown"
              />
            </div>
            <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4.5 pb-4">
              <p
                v-if="refused"
                role="alert"
                data-testid="new-host-refused"
                class="rounded-8 bg-(--d-danger)/12 px-2.5 py-2 text-12 text-(--d-danger-text)"
              >
                {{ refusalText({ refused: visibleText(refused.refused), reason: refused.reason }, t) }}
              </p>
              <div
                v-if="newHost"
                class="flex flex-col gap-2"
              >
                <!-- Host cards are card-shaped buttons with an icon tile and two lines, which no shadcn part draws. -->
                <button
                  type="button"
                  data-connect-card
                  data-testid="new-host-card"
                  class="host-card host-card-new flex min-w-0 items-center gap-3 rounded-xl border border-dashed border-(--d-accent) bg-(--d-panel) px-3 py-2.5 text-left transition-colors hover:bg-(--d-hover) focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)] focus-visible:outline-none"
                  @click="openNameStep({ kind: 'input', input: parsed!.input, destination: newHost.destinationLabel }, newHost.prefillName, newHost.nameCheck.ok ? undefined : newHost.nameCheck)"
                  @keydown="onCardKeydown($event)"
                >
                  <span
                    aria-hidden="true"
                    class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--d-accent-soft) text-(--d-accent-text)"
                  >
                    <Plus class="size-4.5" />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate font-semibold">{{ t('remote.connect.newHost', { destination: visibleText(newHost.destinationLabel) }) }}</span>
                    <span class="truncate text-11 text-(--d-faint-text)">{{ t('remote.connect.newHostNote') }}</span>
                  </span>
                  <kbd class="rounded-5 border border-(--d-border2) px-1 font-mono text-10 text-(--d-faint-text)">Enter</kbd>
                </button>
                <ul
                  v-if="newHost.options.length > 0"
                  :aria-label="t('remote.connect.parsedOptions')"
                  data-testid="parsed-options"
                  class="flex flex-wrap gap-1.5"
                >
                  <li
                    v-for="(option, index) in newHost.options"
                    :key="index"
                    dir="ltr"
                    class="rounded-5 bg-(--d-hover) px-1.5 py-0.5 font-mono text-11 text-(--d-muted)"
                  >
                    {{ visibleText(`${option.name} ${option.value}`) }}
                  </li>
                </ul>
              </div>
              <template v-if="shownHosts.length > 0">
                <h3 class="mt-2.5 mb-1 flex items-baseline gap-2 text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
                  {{ t('remote.connect.savedHosts') }}
                  <span class="font-normal tracking-normal normal-case text-(--d-faint-text)">{{ t('remote.connect.savedHostsNote') }}</span>
                </h3>
                <div
                  role="group"
                  :aria-label="t('remote.connect.savedHosts')"
                  class="grid grid-cols-1 gap-2 @min-[36rem]:grid-cols-2"
                >
                  <div
                    v-for="(saved, index) in shownHosts"
                    :key="saved.hostId"
                    class="host-card flex min-w-0 items-stretch rounded-xl border border-(--d-border) bg-(--d-panel) transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) has-focus-visible:border-(--d-accent) has-focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)]"
                    :style="staggered(index)"
                    :data-host-id="saved.hostId"
                  >
                    <!-- A card-shaped button, as the new-host card, named by its content: axe reads a card's visible text with no space
                         between its parts, so no aria-label can contain it (label-content-name-mismatch). -->
                    <button
                      type="button"
                      data-connect-card
                      data-testid="host-card-button"
                      class="d-press flex min-w-0 flex-1 items-center gap-3 rounded-l-xl px-3 py-2.5 text-left focus-visible:outline-none"
                      @click="connectSaved(saved)"
                      @keydown="onCardKeydown($event, saved.hostId)"
                    >
                      <span
                        aria-hidden="true"
                        class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--tone)/15"
                        :class="`d-tone-${saved.color ?? 'muted'}`"
                      >
                        <component
                          :is="KIND_ICONS[saved.kind]"
                          class="size-4.5"
                        />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate font-semibold">
                          <Transition
                            name="t-swap"
                            mode="out-in"
                          >
                            <span :key="saved.name">{{ saved.name }}</span>
                          </Transition>
                        </span>
                        <span
                          dir="ltr"
                          class="truncate font-mono text-11 text-(--d-faint-text)"
                        >{{ saved.destinationLabel }}</span>
                      </span>
                      <HostStatusDot
                        :connection="saved.connection"
                        :label="t('projects.connection.' + saved.connection)"
                      />
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="host-details"
                      class="my-auto mr-1.5 size-7 shrink-0 rounded-7 text-(--d-muted)"
                      :aria-label="t('remote.connect.details', { name: saved.name })"
                      :title="t('remote.connect.details', { name: saved.name })"
                      @click="openCard(saved.hostId)"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        class="size-3.5"
                      />
                    </Button>
                  </div>
                </div>
              </template>
              <template v-if="shownAliases.length > 0">
                <h3 class="mt-2.5 mb-1 flex items-baseline gap-2 text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
                  {{ t('remote.connect.sshHosts') }}
                  <span class="font-mono font-normal tracking-normal normal-case text-(--d-faint-text)">{{ t('remote.connect.sshHostsNote') }}</span>
                </h3>
                <div
                  role="group"
                  :aria-label="t('remote.connect.sshHosts')"
                  class="grid grid-cols-1 gap-2 @min-[36rem]:grid-cols-2"
                >
                  <!-- a card-shaped button, as the new-host card -->
                  <button
                    v-for="(alias, index) in shownAliases"
                    :key="alias"
                    type="button"
                    data-connect-card
                    data-testid="ssh-alias-card"
                    :aria-label="t('remote.connect.aliasCard', { alias })"
                    class="host-card d-press flex min-w-0 items-center gap-3 rounded-xl border border-(--d-border) bg-(--d-panel) px-3 py-2.5 text-left transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) focus-visible:border-(--d-accent) focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)] focus-visible:outline-none"
                    :style="staggered(shownHosts.length + index)"
                    @click="start({ alias, name: alias }, { name: alias, destination: alias, kind: 'ssh' })"
                    @keydown="onCardKeydown($event)"
                  >
                    <span
                      aria-hidden="true"
                      class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--d-hover) text-(--d-muted)"
                    >
                      <Server class="size-4.5" />
                    </span>
                    <span
                      dir="ltr"
                      class="min-w-0 flex-1 truncate font-semibold"
                    >{{ visibleText(alias) }}</span>
                  </button>
                </div>
              </template>
              <template v-if="shownDistros.length > 0">
                <h3 class="mt-2.5 mb-1 flex items-baseline gap-2 text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
                  {{ t('remote.connect.distros') }}
                  <span class="font-normal tracking-normal normal-case text-(--d-faint-text)">{{ t('remote.connect.distrosNote') }}</span>
                </h3>
                <div
                  role="group"
                  data-testid="distro-cards"
                  :aria-label="t('remote.connect.distros')"
                  class="grid grid-cols-1 gap-2 @min-[36rem]:grid-cols-2"
                >
                  <div
                    v-for="(card, index) in shownDistros"
                    :key="card.info.distro"
                    class="host-card flex min-w-0 items-stretch rounded-xl border border-(--d-border) bg-(--d-panel) transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) has-focus-visible:border-(--d-accent) has-focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)]"
                    :style="staggered(shownHosts.length + shownAliases.length + index)"
                  >
                    <!-- a card-shaped button named by its content, as a saved host's -->
                    <button
                      type="button"
                      data-connect-card
                      data-testid="distro-card"
                      :data-distro="card.info.distro"
                      :data-host-id="card.host?.hostId"
                      class="d-press flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left focus-visible:outline-none"
                      :class="card.host ? 'rounded-l-xl' : 'rounded-xl'"
                      @click="pickDistro(card)"
                      @keydown="onCardKeydown($event, card.host?.hostId)"
                    >
                      <span
                        aria-hidden="true"
                        class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--tone)/15"
                        :class="`d-tone-${card.host?.color ?? 'warning'}`"
                      >
                        <SquareTerminal class="size-4.5" />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="flex min-w-0 items-center gap-1.5 font-semibold">
                          <span class="min-w-0 truncate">
                            <Transition
                              name="t-swap"
                              mode="out-in"
                            >
                              <span :key="card.name">{{ card.name }}</span>
                            </Transition>
                          </span>
                          <Badge
                            v-if="card.info.isDefault"
                            as="span"
                            variant="tone"
                            data-testid="distro-default"
                            class="d-tone-accent h-4.5 shrink-0 rounded-5 border-0 bg-(--tone)/15 px-1.5 py-0 text-10 font-semibold"
                            :title="t('remote.distro.defaultTitle')"
                          >
                            {{ t('remote.distro.default') }}
                          </Badge>
                          <Badge
                            v-if="card.info.version === 1"
                            as="span"
                            variant="tone"
                            data-testid="distro-wsl1"
                            class="d-tone-warning h-4.5 shrink-0 rounded-5 border-0 bg-(--tone)/16 px-1.5 py-0 text-10 font-semibold"
                            :title="t('remote.distro.wsl1Title')"
                          >
                            {{ wslVersionName(1) }}
                          </Badge>
                        </span>
                        <span
                          dir="ltr"
                          class="truncate font-mono text-11 text-(--d-faint-text)"
                        >{{ distroLine(card).join(' · ') }}</span>
                      </span>
                      <!-- the second line says the state in words, so the dot adds nothing to the name -->
                      <span
                        aria-hidden="true"
                        class="flex shrink-0 items-center"
                      >
                        <HostStatusDot
                          v-if="card.host && card.host.connection !== 'offline'"
                          :connection="card.host.connection"
                          :label="distroStateText(card)"
                        />
                        <DistroStateDot
                          v-else
                          :state="card.info.state"
                          :label="distroStateText(card)"
                        />
                      </span>
                    </button>
                    <Button
                      v-if="card.host"
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="host-details"
                      class="my-auto mr-1.5 size-7 shrink-0 rounded-7 text-(--d-muted)"
                      :aria-label="t('remote.connect.details', { name: card.name })"
                      :title="t('remote.connect.details', { name: card.name })"
                      @click="openCard(card.host.hostId)"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        class="size-3.5"
                      />
                    </Button>
                  </div>
                </div>
              </template>
              <template v-if="filter === '' || shownContainers.length > 0">
                <h3 class="mt-2.5 mb-1 flex items-baseline gap-2 text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
                  {{ t('remote.connect.containers') }}
                  <span class="font-normal tracking-normal normal-case text-(--d-faint-text)">{{ t('remote.connect.containersNote') }}</span>
                </h3>
                <div
                  role="group"
                  data-testid="container-cards"
                  :aria-label="t('remote.connect.containers')"
                  class="grid grid-cols-1 gap-2 @min-[36rem]:grid-cols-2"
                >
                  <template v-if="filter === ''">
                    <!-- card-shaped buttons named by their content, as a saved host's -->
                    <button
                      type="button"
                      data-connect-card
                      data-testid="devcontainer-folder-card"
                      class="host-card d-press flex min-w-0 items-center gap-3 rounded-xl border border-(--d-border) bg-(--d-panel) px-3 py-2.5 text-left transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) focus-visible:border-(--d-accent) focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)] focus-visible:outline-none"
                      :style="staggered(cardsBefore)"
                      @click="openContainerFlow('devcontainer')"
                      @keydown="onCardKeydown($event)"
                    >
                      <span
                        aria-hidden="true"
                        class="d-tone-info grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--tone)/15"
                      >
                        <Box class="size-4.5" />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate font-semibold">{{ t('remote.container.openCard') }}</span>
                        <span class="truncate font-mono text-11 text-(--d-faint-text)">{{ t('remote.container.openCardNote') }}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      data-connect-card
                      data-testid="attach-container-card"
                      class="host-card d-press flex min-w-0 items-center gap-3 rounded-xl border border-(--d-border) bg-(--d-panel) px-3 py-2.5 text-left transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) focus-visible:border-(--d-accent) focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)] focus-visible:outline-none"
                      :style="staggered(cardsBefore + 1)"
                      @click="openContainerFlow('attach')"
                      @keydown="onCardKeydown($event)"
                    >
                      <span
                        aria-hidden="true"
                        class="d-tone-info grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--tone)/15"
                      >
                        <Plug class="size-4.5" />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate font-semibold">{{ t('remote.container.attachCard') }}</span>
                        <span class="truncate font-mono text-11 text-(--d-faint-text)">{{ t('remote.container.attachCardNote') }}</span>
                      </span>
                    </button>
                  </template>
                  <div
                    v-for="(saved, index) in shownContainers"
                    :key="saved.hostId"
                    class="host-card flex min-w-0 items-stretch rounded-xl border border-(--d-border) bg-(--d-panel) transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) has-focus-visible:border-(--d-accent) has-focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)]"
                    :style="staggered(cardsBefore + (filter === '' ? 2 : 0) + index)"
                  >
                    <button
                      type="button"
                      data-connect-card
                      data-testid="container-card"
                      :data-host-id="saved.hostId"
                      :data-origin="saved.container?.origin"
                      class="d-press flex min-w-0 flex-1 items-center gap-3 rounded-l-xl px-3 py-2.5 text-left focus-visible:outline-none"
                      @click="connectSaved(saved)"
                      @keydown="onCardKeydown($event, saved.hostId)"
                    >
                      <span
                        aria-hidden="true"
                        class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--tone)/15"
                        :class="`d-tone-${saved.color ?? 'info'}`"
                      >
                        <Box class="size-4.5" />
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate font-semibold">
                          <Transition
                            name="t-swap"
                            mode="out-in"
                          >
                            <span :key="saved.name">{{ saved.name }}</span>
                          </Transition>
                        </span>
                        <span
                          dir="ltr"
                          class="truncate font-mono text-11 text-(--d-faint-text)"
                        >{{ containerLine(saved) }}</span>
                      </span>
                      <!-- the second line says the state in words, so the dot adds nothing to the name -->
                      <span
                        aria-hidden="true"
                        class="flex shrink-0 items-center"
                      >
                        <HostStatusDot
                          v-if="saved.connection !== 'offline' || !saved.container"
                          :connection="saved.connection"
                          :label="containerStateText(saved)"
                        />
                        <ContainerStateDot
                          v-else
                          :state="saved.container.state"
                          :label="containerStateText(saved)"
                        />
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="host-details"
                      class="my-auto mr-1.5 size-7 shrink-0 rounded-7 text-(--d-muted)"
                      :aria-label="t('remote.connect.details', { name: saved.name })"
                      :title="t('remote.connect.details', { name: saved.name })"
                      @click="openCard(saved.hostId)"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        class="size-3.5"
                      />
                    </Button>
                  </div>
                </div>
              </template>
              <p
                v-if="!newHost && !refused && shownHosts.length === 0 && shownAliases.length === 0 && shownDistros.length === 0 && shownContainers.length === 0"
                class="mt-4 text-12 text-(--d-faint-text)"
              >
                {{ filter === '' ? t('remote.connect.noHosts') : t('remote.connect.noMatch') }}
              </p>
            </div>
            <div
              aria-hidden="true"
              class="flex gap-4 border-t border-(--d-border) px-4.5 py-2 text-11 text-(--d-faint-text)"
            >
              <span>{{ t('remote.connect.keysMove') }}</span>
              <span>{{ t('remote.connect.keysConnect') }}</span>
              <span>{{ t('remote.connect.keysDetails') }}</span>
              <span>{{ t('remote.connect.keysClose') }}</span>
            </div>
          </div>

          <div
            v-else-if="view === 'name'"
            key="name"
            data-view
            class="flex min-h-0 flex-1 flex-col"
          >
            <div class="flex flex-1 flex-col gap-3.5 overflow-y-auto px-4.5 py-3">
              <span
                dir="ltr"
                class="flex items-center gap-2 rounded-10 bg-(--d-panel) px-3 py-2.5 font-mono text-12"
              >{{ visibleText(namingShown) }}</span>
              <label class="flex max-w-120 flex-col gap-1.5 text-12 text-(--d-muted)">
                {{ t('remote.name.label') }}
                <HostNameField
                  ref="nameField"
                  v-model="nameDraft"
                  :label="t('remote.name.label')"
                  :check="(name) => answerOf(api.checkHostName(name))"
                  class="h-9 text-sm"
                  @submit="submitName"
                  @cancel="view = 'hosts'"
                />
              </label>
              <p class="flex flex-wrap items-center gap-2 rounded-10 bg-(--d-panel) px-3 py-2.5 text-12 text-(--d-muted)">
                {{ t('remote.name.preview') }}
                <HostBadge :name="nameDraft.trim() === '' ? ' ' : nameDraft.trim()" />
                <span class="text-11.5 text-(--d-faint-text)">{{ naming?.kind === 'distro' ? t('remote.name.noteDistro') : naming?.kind === 'container' ? t('remote.name.noteContainer') : t('remote.name.note') }}</span>
              </p>
            </div>
            <div class="flex justify-end gap-2 px-4.5 pt-3 pb-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="h-8 rounded-9 px-3.5 text-12.5"
                @click="view = 'hosts'"
              >
                {{ t('remote.connect.back') }}
              </Button>
              <Button
                type="button"
                size="sm"
                class="h-8 rounded-9 px-3.5 text-12.5 font-semibold"
                @click="nameField?.submit()"
              >
                {{ t('remote.name.connect') }}
              </Button>
            </div>
          </div>

          <HostCard
            v-else-if="view === 'card' && host"
            key="card"
            data-view
            :host="host"
            :runs="runs"
            :start-renaming="renameOnCard"
            :check-name="(name) => answerOf(api.checkHostName(name, host!.hostId))"
            :rename="(name) => answerOf(api.renameHost(host!.hostId, name))"
            :set-install-folder="(folder) => answerOf(api.setInstallFolder(host!.hostId, folder))"
            :browse="(path) => answerOf(api.browseHost(host!.hostId, path))"
            :allow-background-work="() => answerOf(api.allowBackgroundWork(host!.hostId))"
            @back="view = 'hosts'"
            @connect="start({ hostId: host!.hostId })"
            @open-folder="connectSaved(host!)"
            @show-log="showLog(host!.hostId)"
            @open-settings="openSettings(host!.hostId)"
            @kill="kill"
            @open-run="openRun"
          >
            <template
              v-if="host.container?.origin === 'devcontainer'"
              #container
            >
              <ContainerRebuild
                :api="api"
                :host-id="host.hostId"
                :host-name="host.name"
                :ask="rebuildOnCard"
                :without-data-volume="host.container.withoutDataVolume === true"
                @busy="rebuilding = $event"
              />
            </template>
            <template
              v-if="host.wsl"
              #wsl
            >
              <WslConversion
                :api="api"
                :host-id="host.hostId"
                :host-name="host.name"
                :distro="host.wsl.distro"
                :version="host.wsl.version"
                :connected="host.connection === 'connected'"
                @busy="converting = $event"
              />
            </template>
            <template #actions>
              <HostActions
                :api="api"
                :host-id="host.hostId"
                :host-name="host.name"
                :kind="host.kind"
                :connection="host.connection"
                :passwordless="host.passwordless"
                :os="host.os"
                :containers="hosts.some((candidate) => candidate.container?.via?.hostId === host!.hostId)"
                @busy="actionsBusy = $event"
              />
            </template>
          </HostCard>

          <div
            v-else-if="view === 'timeline' && attempt"
            key="timeline"
            data-view
            class="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-3 pb-4"
          >
            <StepTimeline
              class="max-w-xl"
              :event="attempt"
              :host-name="hostName"
              :other-devices="otherDeviceCount(hosts.find((card) => card.hostId === attempt!.hostId)?.devices)"
              :set-install-folder="(folder) => answerOf(api.setInstallFolder(attempt!.hostId, folder))"
              @answer="answer"
              @retry="start({ hostId: attempt!.hostId })"
              @show-log="showLog(attempt!.hostId)"
              @edit-host="editHost"
            />
          </div>

          <div
            v-else-if="view === 'where' && containerFlow"
            key="where"
            data-view
            class="flex min-h-0 flex-1 flex-col"
          >
            <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4.5 pt-2 pb-4">
              <p class="text-12 text-(--d-muted)">
                {{ containerFlow.kind === 'attach' ? t('remote.container.whereAttach') : t('remote.container.whereOpen') }}
              </p>
              <div
                role="group"
                data-testid="container-where"
                :aria-label="t('remote.container.where')"
                class="mt-2 grid grid-cols-1 gap-2 @min-[36rem]:grid-cols-2"
              >
                <button
                  type="button"
                  data-connect-card
                  data-testid="container-where-local"
                  :data-view-focus="containerFlow.via === undefined || undefined"
                  class="host-card d-press flex min-w-0 items-center gap-3 rounded-xl border border-(--d-border) bg-(--d-panel) px-3 py-2.5 text-left transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) focus-visible:border-(--d-accent) focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)] focus-visible:outline-none"
                  :style="staggered(0)"
                  @click="chooseWhere()"
                  @keydown="onCardKeydown($event)"
                >
                  <span
                    aria-hidden="true"
                    class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--d-accent-soft) text-(--d-accent-text)"
                  >
                    <Laptop class="size-4.5" />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate font-semibold">{{ t('remote.container.thisComputer') }}</span>
                    <span class="truncate font-mono text-11 text-(--d-faint-text)">{{ containerFlow.kind === 'attach' ? t('remote.container.localAttachNote') : t('remote.container.localOpenNote') }}</span>
                  </span>
                  <FolderSearch
                    v-if="containerFlow.kind === 'devcontainer'"
                    aria-hidden="true"
                    class="size-3.5 shrink-0 text-(--d-faint)"
                  />
                </button>
                <button
                  v-for="(saved, index) in sshHosts"
                  :key="saved.hostId"
                  type="button"
                  data-connect-card
                  data-testid="container-where-host"
                  :data-host-id="saved.hostId"
                  :data-view-focus="containerFlow.via === saved.hostId || undefined"
                  class="host-card d-press flex min-w-0 items-center gap-3 rounded-xl border border-(--d-border) bg-(--d-panel) px-3 py-2.5 text-left transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) focus-visible:border-(--d-accent) focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)] focus-visible:outline-none"
                  :style="staggered(index + 1)"
                  @click="chooseWhere(saved)"
                  @keydown="onCardKeydown($event)"
                >
                  <span
                    aria-hidden="true"
                    class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--tone)/15"
                    :class="`d-tone-${saved.color ?? 'muted'}`"
                  >
                    <Server class="size-4.5" />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate font-semibold">{{ saved.name }}</span>
                    <span
                      dir="ltr"
                      class="truncate font-mono text-11 text-(--d-faint-text)"
                    >{{ saved.destinationLabel }}</span>
                  </span>
                  <HostStatusDot
                    :connection="saved.connection"
                    :label="t('projects.connection.' + saved.connection)"
                  />
                </button>
              </div>
            </div>
            <div class="flex justify-start border-t border-(--d-border) px-4.5 py-2.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="h-8 rounded-9 px-3.5 text-12.5"
                @click="view = 'hosts'"
              >
                {{ t('remote.connect.back') }}
              </Button>
            </div>
          </div>

          <div
            v-else-if="view === 'attach'"
            key="attach"
            data-view
            class="flex min-h-0 flex-1 flex-col"
          >
            <div class="flex flex-wrap items-center gap-2 px-4.5 pt-1 pb-2">
              <span
                :id="attachUserLabel"
                class="text-12 text-(--d-muted)"
              >{{ t('remote.container.attachAs') }}</span>
              <SegmentedToggle
                v-model="attachUser"
                data-testid="attach-user"
                :aria-labelledby="attachUserLabel"
                :options="[{ value: 'configured', label: t('remote.container.userConfigured') }, { value: 'root', label: t('remote.container.userRoot') }]"
                class="border border-(--d-border2) bg-(--d-input)"
                indicator-class="text-(--d-card)"
                selected-class="text-(--d-accent-text)"
              />
              <span class="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="attach-refresh"
                class="h-7 rounded-7 px-2.5 text-12 text-(--d-muted)"
                :disabled="attachList === undefined"
                @click="loadContainers"
              >
                <RefreshCw
                  aria-hidden="true"
                  class="size-3.5"
                  :class="attachList === undefined && 'd-spinning'"
                />
                {{ t('remote.container.refresh') }}
              </Button>
            </div>
            <div
              class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4.5 pb-4"
              data-testid="attach-list"
              :aria-busy="attachList === undefined"
            >
              <p
                v-if="attachList === undefined"
                data-testid="attach-listing"
                class="d-fade-in flex items-center gap-2 text-12 text-(--d-faint-text)"
              >
                <LoaderCircle
                  aria-hidden="true"
                  class="size-3.5 shrink-0 d-spinning text-(--d-accent-text)"
                />
                {{ t('remote.container.listing', { where: attachWhere }) }}
              </p>
              <div
                v-else-if="attachFailure"
                role="alert"
                data-testid="attach-failure"
                :data-code="attachFailure.code"
                class="timeline-grow flex flex-col gap-1.5 rounded-8 bg-(--d-danger)/12 px-2.5 py-2 text-12 text-(--d-danger-text)"
              >
                <p>{{ attachFailure.text }}</p>
                <pre
                  v-if="attachFailure.message"
                  dir="ltr"
                  class="m-0 font-mono text-11.5 whitespace-pre-wrap"
                >{{ visibleLines(attachFailure.message) }}</pre>
              </div>
              <p
                v-else-if="attachList.ok && attachList.containers.length === 0"
                data-testid="attach-empty"
                class="text-12 text-(--d-faint-text)"
              >
                {{ t('remote.container.noneRunning', { where: attachWhere }) }}
              </p>
              <div
                v-else-if="attachList.ok"
                role="group"
                :aria-label="t('remote.container.running')"
                class="grid grid-cols-1 gap-2 @min-[36rem]:grid-cols-2"
              >
                <!-- card-shaped buttons named by their content, as a saved host's -->
                <button
                  v-for="(container, index) in attachList.containers"
                  :key="container.id"
                  type="button"
                  data-connect-card
                  data-testid="running-container"
                  :data-container-id="container.id"
                  class="host-card d-press flex min-w-0 items-center gap-3 rounded-xl border border-(--d-border) bg-(--d-panel) px-3 py-2.5 text-left transition-colors hover:border-(--d-border2) hover:bg-(--d-hover) focus-visible:border-(--d-accent) focus-visible:shadow-[0_0_0_3px_var(--d-accent-soft)] focus-visible:outline-none"
                  :style="staggered(index)"
                  @click="attachTo(container)"
                  @keydown="onCardKeydown($event)"
                >
                  <span
                    aria-hidden="true"
                    class="d-tone-info grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--tone)/15"
                  >
                    <Box class="size-4.5" />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="flex min-w-0 items-center gap-1.5 font-semibold">
                      <span
                        dir="ltr"
                        class="min-w-0 truncate"
                      >{{ visibleText(container.name) }}</span>
                      <Badge
                        as="span"
                        variant="tone"
                        data-testid="running-container-user"
                        class="d-tone-muted h-4.5 shrink-0 rounded-5 border-0 bg-(--tone)/15 px-1.5 py-0 font-mono text-10 font-semibold"
                      >
                        {{ t('remote.container.asUser', { user: attachUserName(container) }) }}
                      </Badge>
                      <Badge
                        v-if="container.hostId !== undefined"
                        as="span"
                        variant="tone"
                        data-testid="running-container-saved"
                        class="d-tone-accent h-4.5 shrink-0 rounded-5 border-0 bg-(--tone)/15 px-1.5 py-0 text-10 font-semibold"
                      >
                        {{ t('remote.container.saved') }}
                      </Badge>
                    </span>
                    <span
                      dir="ltr"
                      class="truncate font-mono text-11 text-(--d-faint-text)"
                    >{{ visibleText(container.image) }} · {{ visibleText(container.status) }}</span>
                  </span>
                  <!-- the status in words says the state, so the dot adds nothing to the name -->
                  <span
                    aria-hidden="true"
                    class="flex shrink-0 items-center"
                  >
                    <ContainerStateDot
                      :state="container.state"
                      :label="t(`remote.container.state.${container.state}`)"
                    />
                  </span>
                </button>
              </div>
            </div>
            <div class="flex justify-start border-t border-(--d-border) px-4.5 py-2.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="attach-back"
                class="h-8 rounded-9 px-3.5 text-12.5"
                @click="view = 'where'"
              >
                {{ t('remote.connect.back') }}
              </Button>
            </div>
          </div>

          <RemoteFolderBrowser
            v-else-if="view === 'folders' && hostId !== undefined"
            key="folders"
            data-view
            :host-name="hostName"
            :recent-folders="picker?.roots ?? host?.recentFolders ?? []"
            :browse="(path) => answerOf(api.browseHost(hostId!, path))"
            :pick="picker && { mode: picker.mode, ...(picker.buttonLabel !== undefined ? { buttonLabel: picker.buttonLabel } : {}) }"
            :open-label="containerFlow?.kind === 'devcontainer' ? t('remote.container.openInContainer') : undefined"
            @pick="pick"
            @cancel="close"
          />
        </Transition>

        <p
          v-if="containerRefusal"
          role="alert"
          data-testid="container-refusal"
          class="mx-4.5 mb-3 text-12 text-(--d-danger-text)"
        >
          {{ containerRefusal }}
        </p>
        <p
          v-if="actionFailed"
          role="alert"
          class="mx-4.5 mb-3 text-12 text-(--d-danger-text)"
        >
          {{ t('remote.connect.actionFailed') }}
        </p>
      </div>
    </DialogContent>
  </Dialog>
  <HostKeyDialog
    :unknown="dialogOpen ? hostKeyPrompt : undefined"
    :changed="dialogOpen ? changedKey : undefined"
    :host-name="hostName"
    :copy-command="() => ran(api.copyHostKeyCommand(attempt?.hostId ?? ''))"
    @answer="hostKeyPrompt && answer(hostKeyPrompt.promptId, $event)"
    @close="changedKeyDismissed = attempt?.attemptId"
  />
</template>
