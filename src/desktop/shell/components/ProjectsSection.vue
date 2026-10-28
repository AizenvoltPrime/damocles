<script setup lang="ts">
import { computed, getCurrentScope, nextTick, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEventListener } from '@vueuse/core';
import { FolderPlus, Plug } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import SegmentedToggle, { type SegmentedOption } from '@/components/SegmentedToggle.vue';
import { remPx } from '@/composables/useRemPx';
import { playAttention } from '@/composables/useAttention';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import type { DamoclesShellApi, ProjectConnection, ProjectsView, ShellHost, ShellPlatform, ShellProject, ShellProjectGroups } from '../../preload/shell-channels';
import type { NameCheck, OverlayMenuItem, OverlayRect } from '../../preload/overlay-channels';
import SidebarSection from './SidebarSection.vue';
import ProjectRow from './ProjectRow.vue';
import ProjectGroup from './ProjectGroup.vue';
import { moveGroup, moveProject, moveProjectInGroup, stepGroup, stepProject, type OrderedProject, type ReorderResult } from './project-reorder';

const props = defineProps<{
  api: DamoclesShellApi;
  projects: readonly ShellProject[];
  selectedKey: string | undefined;
  // remote entry points show only while remote is enabled; hosts are the saved SSH hosts
  remoteEnabled: boolean;
  hosts: readonly ShellHost[];
  view: ProjectsView;
  groups: ShellProjectGroups;
  platform: ShellPlatform;
  collapsed: boolean;
  // CSS px of the body; absent, the section takes the sidebar's remaining height
  bodySize?: number | undefined;
}>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();

const LOCAL_GROUP = 'local';
// the settle of a row the user moved, after the rows around it slid with .t-row-move
const SETTLE = 'transition-transform duration-260 ease-(--ease-spring)';

const listId = useId();
const helpId = useId();
const listbox = ref<HTMLElement | null>(null);
const section = ref<InstanceType<typeof SidebarSection> | null>(null);

interface GroupView {
  readonly key: string;
  readonly name: string;
  // the saved host behind an SSH group
  readonly hostId?: string;
  // absent for this computer, which is always connected
  readonly connection?: ProjectConnection;
  readonly projects: readonly ShellProject[];
  readonly collapsed: boolean;
  readonly busy: { readonly count: number; readonly waiting: boolean };
}

type Row =
  | { readonly id: string; readonly domId: string; readonly kind: 'project'; readonly project: ShellProject }
  | { readonly id: string; readonly domId: string; readonly kind: 'header'; readonly group: GroupView };

const grouped = computed(() => props.view === 'grouped');
const ordered = computed<OrderedProject[]>(() => props.projects.map((project) => ({ key: project.key, group: project.authority.key })));

// Groups in main's group order, each with the projects it shows; a group with none (this computer, with only remote projects) is not drawn.
const hostOf = (authorityKey: string): ShellHost | undefined => props.hosts.find((host) => host.authorityKey === authorityKey);

const groupViews = computed<GroupView[]>(() => {
  const collapsed = new Set(props.groups.collapsed);
  return props.groups.order.flatMap((key): GroupView[] => {
    const members = props.projects.filter((project) => project.authority.key === key);
    const first = members[0];
    if (!first) return [];
    const remote = first.authority.kind !== 'local';
    return [{
      key,
      name: remote ? first.authority.name : t('projects.group.local'),
      ...(first.authority.hostId === undefined ? {} : { hostId: first.authority.hostId }),
      ...(remote ? { connection: first.connection } : {}),
      projects: members,
      collapsed: collapsed.has(key),
      busy: { count: members.reduce((sum, project) => sum + project.running + project.waiting, 0), waiting: members.some((project) => project.waiting > 0) },
    }];
  });
});
const shownGroupKeys = computed(() => groupViews.value.map((group) => group.key));

const projectRow = (project: ShellProject, index: number): Row => ({ id: `p:${project.key}`, domId: `${listId}-p${index}`, kind: 'project', project });
const projectIndex = computed(() => new Map(props.projects.map((project, index) => [project.key, index])));
// The rows the arrow keys move through, in screen order.
const rows = computed<Row[]>(() => {
  if (!grouped.value) return props.projects.map(projectRow);
  return groupViews.value.flatMap((group, index) => [
    { id: `g:${group.key}`, domId: `${listId}-g${index}`, kind: 'header' as const, group },
    ...(group.collapsed ? [] : group.projects.map((project) => projectRow(project, projectIndex.value.get(project.key)!))),
  ]);
});

// Keyboard position; the selection itself is main's (selectedKey).
const activeId = ref<string | undefined>();
const activeRow = computed(() => {
  const all = rows.value;
  const selected = props.projects.find((project) => project.key === props.selectedKey);
  return all.find((row) => row.id === activeId.value)
    ?? all.find((row) => row.id === `p:${props.selectedKey}`)
    ?? (selected ? all.find((row) => row.id === `g:${selected.authority.key}`) : undefined)
    ?? all[0];
});

// The inline line under the list: only the latest refusal shows, and any later action on the list clears it.
interface Refusal { readonly text: string; readonly action?: { readonly label: string; readonly run: () => Promise<void> } }
const refusal = shallowRef<Refusal | undefined>();
const announcement = ref('');

function select(project: ShellProject): void {
  refusal.value = undefined;
  activeId.value = `p:${project.key}`;
  void props.api.selectProject(project.key);
}

function trust(project: ShellProject): void {
  refusal.value = undefined;
  void props.api.grantTrust(project.key);
}

function setView(view: ProjectsView): void {
  refusal.value = undefined;
  void props.api.setProjectsView(view);
}

const viewOptions = computed((): SegmentedOption<ProjectsView>[] => [
  { value: 'flat', label: t('projects.view.flat'), attrs: { 'data-testid': 'projects-view-flat', title: t('projects.view.flatTitle') } },
  { value: 'grouped', label: t('projects.view.grouped'), attrs: { 'data-testid': 'projects-view-grouped', title: t('projects.view.groupedTitle') } },
]);

function toggleGroup(group: GroupView): void {
  refusal.value = undefined;
  activeId.value = `g:${group.key}`;
  void props.api.setProjectGroupCollapsed(group.key, !group.collapsed);
}

// The add button's menu: a local folder through the OS picker, or a remote one through the Connect dialog.
const addButton = ref<InstanceType<typeof Button> | null>(null);
const addMenuOpen = ref(false);
async function openAddMenu(): Promise<void> {
  refusal.value = undefined;
  // Without remote features the only entry is a local folder, so the button opens the OS picker as it always did.
  if (!props.remoteEnabled) {
    await props.api.addProject();
    return;
  }
  if (addMenuOpen.value) return;
  addMenuOpen.value = true;
  try {
    const items: OverlayMenuItem[] = [
      { kind: 'item', id: 'local', label: t('remote.add.local'), icon: 'folder' },
      { kind: 'item', id: 'remote', label: t('remote.add.remote'), icon: 'cloud' },
      ...(props.hosts.length > 0 ? [{ kind: 'separator' } as const] : []),
      ...props.hosts.map((host): OverlayMenuItem => ({ kind: 'item', id: `host:${host.hostId}`, label: t('remote.add.onHost', { name: host.name }), icon: 'folder-open' })),
    ];
    const asked = props.api.requestOverlay({ kind: 'menu', label: t('remote.add.menuLabel'), anchor: rectOf(addButton.value?.$el as HTMLElement | undefined), items });
    // the title actions stay shown while the menu their button opened is up
    const answer = await (section.value ? section.value.holdActions(asked) : asked);
    if (answer.kind !== 'menu') return;
    if (answer.itemId === 'local') await props.api.addProject();
    else if (answer.itemId === 'remote') await props.api.openConnect();
    else if (answer.itemId.startsWith('host:')) await props.api.openHostFolder(answer.itemId.slice('host:'.length));
  } finally {
    addMenuOpen.value = false;
  }
}

function openConnect(): void {
  refusal.value = undefined;
  void props.api.openConnect();
}

async function remove(project: ShellProject): Promise<void> {
  refusal.value = undefined;
  const result = await props.api.removeProject(project.key);
  if (!result.ok) refusal.value = { text: t('projects.removeRefused', { name: project.name, reason: result.reason }) };
}

// A project or group moved by keyboard or menu: the row settles with a spring once the state shows it moved.
let settleId: string | undefined;

// Every reorder ends in main's write; the rows move only when the next state shows the new order.
// false: main wrote nothing (the list changed under the move, or the write failed) and leaves saying so to this line.
async function commitProjects(order: readonly string[], id: string): Promise<boolean> {
  refusal.value = undefined;
  settleId = id;
  const saved = await props.api.reorderProjects(order);
  if (!saved) refusal.value = { text: t('projects.orderFailed') };
  return saved;
}

// Main's group order also holds groups with no project shown (this computer, empty); they keep their places.
async function commitGroups(shown: readonly string[], id: string): Promise<boolean> {
  refusal.value = undefined;
  settleId = id;
  const moved = new Set(shown);
  let next = 0;
  const saved = await props.api.reorderProjectGroups(props.groups.order.map((key) => (moved.has(key) ? shown[next++]! : key)));
  if (!saved) refusal.value = { text: t('projects.orderFailed') };
  return saved;
}

const projectStep = (project: ShellProject, delta: -1 | 1): ReorderResult => stepProject(ordered.value, project.key, delta, props.view);
const groupStep = (group: GroupView, delta: -1 | 1): ReorderResult => stepGroup(shownGroupKeys.value, group.key, delta);

async function stepRow(row: Row, delta: -1 | 1): Promise<void> {
  const name = row.kind === 'project' ? row.project.name : row.group.name;
  const result = row.kind === 'project' ? projectStep(row.project, delta) : groupStep(row.group, delta);
  if (!result.ok) return;
  const saved = row.kind === 'project' ? await commitProjects(result.order, row.id) : await commitGroups(result.order, row.id);
  if (!saved) return;
  // emptied first, so a second identical move is announced again
  announcement.value = '';
  await nextTick();
  announcement.value = t(delta < 0 ? 'projects.movedUp' : 'projects.movedDown', { name });
}

const moveItems = (up: ReorderResult, down: ReorderResult): OverlayMenuItem[] => [
  { kind: 'item', id: 'moveUp', label: t('projects.moveUp'), shortcut: props.platform === 'darwin' ? '⌥↑' : 'Alt+Up', disabled: !up.ok },
  { kind: 'item', id: 'moveDown', label: t('projects.moveDown'), shortcut: props.platform === 'darwin' ? '⌥↓' : 'Alt+Down', disabled: !down.ok },
];

async function openProjectMenu(project: ShellProject, anchor: OverlayRect): Promise<void> {
  activeId.value = `p:${project.key}`;
  const hostId = props.remoteEnabled ? project.authority.hostId : undefined;
  const items: OverlayMenuItem[] = [
    ...(project.trusted ? [] : [{ kind: 'item', id: 'trust', label: t('projects.trust'), icon: 'shield-check' } as const, { kind: 'separator' } as const]),
    ...(hostId === undefined ? [] : [
      { kind: 'item', id: 'openFolder', label: t('projects.openAnotherFolder', { name: project.authority.name }), icon: 'folder-plus' } as const,
      { kind: 'item', id: 'rename', label: t('projects.renameHost', { name: project.authority.name }), icon: 'pencil' } as const,
      { kind: 'separator' } as const,
    ]),
    ...moveItems(projectStep(project, -1), projectStep(project, 1)),
    { kind: 'separator' },
    { kind: 'item', id: 'remove', label: t('projects.remove'), icon: 'folder-minus', danger: true },
  ];
  const answer = await props.api.requestOverlay({ kind: 'menu', label: t('projects.menuLabel', { name: project.name }), anchor, items });
  if (answer.kind !== 'menu') return;
  const row = rows.value.find((candidate) => candidate.id === `p:${project.key}`);
  if (answer.itemId === 'trust') trust(project);
  else if (answer.itemId === 'remove') await remove(project);
  else if (answer.itemId === 'moveUp' && row) await stepRow(row, -1);
  else if (answer.itemId === 'moveDown' && row) await stepRow(row, 1);
  else if (answer.itemId === 'openFolder' && hostId !== undefined) await props.api.openHostFolder(hostId);
  else if (answer.itemId === 'rename' && hostId !== undefined) {
    // the grouped view renames on the group header; the flat view has none, so the host's card opens with its name field
    if (grouped.value) startRename(project.authority.key);
    else await props.api.renameHostOnCard(hostId);
  }
}

async function openGroupMenu(group: GroupView, anchor: OverlayRect): Promise<void> {
  activeId.value = `g:${group.key}`;
  const hostId = props.remoteEnabled ? group.hostId : undefined;
  const items: OverlayMenuItem[] = [
    ...(hostId === undefined ? [] : [
      { kind: 'item', id: 'openFolder', label: t('projects.group.openFolder', { name: group.name }), icon: 'folder-plus' } as const,
      { kind: 'item', id: 'rename', label: t('projects.group.rename'), icon: 'pencil' } as const,
      { kind: 'separator' } as const,
    ]),
    ...moveItems(groupStep(group, -1), groupStep(group, 1)),
  ];
  const answer = await props.api.requestOverlay({ kind: 'menu', label: t('projects.menuLabel', { name: group.name }), anchor, items });
  if (answer.kind !== 'menu') return;
  const row = rows.value.find((candidate) => candidate.id === `g:${group.key}`);
  if (answer.itemId === 'moveUp' && row) await stepRow(row, -1);
  else if (answer.itemId === 'moveDown' && row) await stepRow(row, 1);
  else if (answer.itemId === 'openFolder' && hostId !== undefined) await props.api.openHostFolder(hostId);
  else if (answer.itemId === 'rename' && hostId !== undefined) startRename(group.key);
}

function openRowMenu(row: Row, anchor: OverlayRect): void {
  refusal.value = undefined;
  if (row.kind === 'project') void openProjectMenu(row.project, anchor);
  else void openGroupMenu(row.group, anchor);
}

function onContextMenu(row: Row, event: MouseEvent): void {
  event.preventDefault();
  openRowMenu(row, { x: event.clientX, y: event.clientY, width: 0, height: 0 });
}

function rectOf(element: Element | null | undefined): OverlayRect {
  const rect = element?.getBoundingClientRect();
  return rect ? { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 };
}

const renaming = ref<string | undefined>();
let renameSaving = false;
const groupComponents = new Map<string, InstanceType<typeof ProjectGroup>>();
function setGroupComponent(key: string, component: unknown): void {
  if (component) groupComponents.set(key, component as InstanceType<typeof ProjectGroup>);
  else groupComponents.delete(key);
}

function startRename(groupKey: string): void {
  refusal.value = undefined;
  activeId.value = `g:${groupKey}`;
  renaming.value = groupKey;
}

// refocus: Enter and Escape give focus back to the list; leaving the field leaves it where the user put it.
function endRename(refocus: boolean): void {
  renaming.value = undefined;
  if (refocus) listbox.value?.focus();
}

// Enter saves and shows a refusal in place; leaving the field saves a valid name and restores the old one otherwise.
async function submitRename(group: GroupView, name: string, refocus: boolean): Promise<void> {
  // leaving the field after Escape, or while the save is on its way, is not a submit
  if (renaming.value !== group.key || renameSaving || group.hostId === undefined) return;
  if (name.trim() === group.name) {
    endRename(refocus);
    return;
  }
  renameSaving = true;
  let result: NameCheck | null;
  try {
    result = await props.api.renameHost(group.hostId, name);
  } catch {
    result = null;
  } finally {
    renameSaving = false;
  }
  // a failed save keeps the field open, saying so, whether Enter or leaving the field asked for it
  if (result === null) groupComponents.get(group.key)?.saveFailed();
  else if (result.ok || !refocus) endRename(refocus);
  else await groupComponents.get(group.key)?.refuse(result);
}

function moveActive(index: number): void {
  const row = rows.value[Math.min(Math.max(index, 0), rows.value.length - 1)];
  if (!row) return;
  activeId.value = row.id;
  void nextTick(() => document.getElementById(row.domId)?.scrollIntoView({ block: 'nearest' }));
}

function onKeydown(event: KeyboardEvent): void {
  // keys typed into the rename field are the field's
  if (event.target !== event.currentTarget) return;
  const row = activeRow.value;
  if (!row) return;
  const index = rows.value.indexOf(row);
  const header = row.kind === 'header' ? row.group : undefined;
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    activeId.value = row.id;
    void stepRow(row, event.key === 'ArrowUp' ? -1 : 1);
  } else if (event.key === 'ArrowDown') moveActive(index + 1);
  else if (event.key === 'ArrowUp') moveActive(index - 1);
  else if (event.key === 'Home') moveActive(0);
  else if (event.key === 'End') moveActive(rows.value.length - 1);
  else if (event.key === 'Enter' || event.key === ' ') {
    if (header) toggleGroup(header);
    else if (row.kind === 'project') select(row.project);
  } else if (header && ((event.key === 'ArrowRight' && header.collapsed) || (event.key === 'ArrowLeft' && !header.collapsed))) toggleGroup(header);
  else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) openRowMenu(row, rectOf(document.getElementById(row.domId)));
  else return;
  event.preventDefault();
}

interface Drag {
  readonly id: string;
  readonly pointerId: number;
  readonly startY: number;
  // the project's group in the grouped view; a drop on another group is refused
  readonly group?: string;
  started: boolean;
  phase: 'dragging' | 'returning' | 'committing';
  siblings: string[];
  rects: DOMRect[];
  groupRects: { key: string; rect: DOMRect }[];
  index: number;
  target: number;
  // px the rows between the old and new place move to make room
  room: number;
  dy: number;
  foreign?: string;
}
const drag = ref<Drag | undefined>();
let clickAfterDrag = false;

const dragIdOf = (element: Element | null): string | undefined => element?.closest<HTMLElement>('[data-drag-id]')?.dataset.dragId;

function onPointerDown(event: PointerEvent): void {
  if (drag.value?.phase === 'returning') drag.value = undefined;
  if (event.button !== 0 || drag.value || renaming.value !== undefined) return;
  const target = event.target as HTMLElement;
  if (target.closest('button, input')) return;
  const header = target.closest('[data-testid="project-group-header"]');
  const id = dragIdOf(header ? header.closest('[data-testid="project-group"]') : target);
  if (id === undefined) return;
  const project = id.startsWith('p:') ? props.projects.find((candidate) => `p:${candidate.key}` === id) : undefined;
  drag.value = {
    id,
    pointerId: event.pointerId,
    startY: event.clientY,
    ...(grouped.value && project ? { group: project.authority.key } : {}),
    started: false,
    phase: 'dragging',
    siblings: [],
    rects: [],
    groupRects: [],
    index: 0,
    target: 0,
    room: 0,
    dy: 0,
  };
}

function startDrag(current: Drag): void {
  const element = listbox.value?.querySelector<HTMLElement>(`[data-drag-id="${CSS.escape(current.id)}"]`);
  const parent = element?.parentElement;
  if (!element || !parent || !listbox.value) {
    drag.value = undefined;
    return;
  }
  const siblings = [...parent.querySelectorAll<HTMLElement>(':scope > [data-drag-id]')];
  const rects = siblings.map((sibling) => sibling.getBoundingClientRect());
  const index = siblings.indexOf(element);
  const gap = rects.length > 1 ? rects[1]!.top - rects[0]!.bottom : 0;
  current.started = true;
  current.siblings = siblings.map((sibling) => sibling.dataset.dragId!);
  current.rects = rects;
  current.index = index;
  current.target = index;
  current.room = rects[index]!.height + gap;
  current.groupRects = current.group === undefined ? [] : [...listbox.value.querySelectorAll<HTMLElement>('[data-testid="project-group"]')].map((group) => ({ key: group.dataset.group!, rect: group.getBoundingClientRect() }));
  listbox.value.setPointerCapture(current.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  const current = drag.value;
  if (!current || current.phase !== 'dragging' || event.pointerId !== current.pointerId) return;
  const dy = event.clientY - current.startY;
  if (!current.started) {
    if (Math.abs(dy) < remPx(0.25)) return;
    startDrag(current);
    if (!current.started) return;
  }
  event.preventDefault();
  current.dy = dy;
  current.target = current.rects.filter((rect, index) => index !== current.index && event.clientY > rect.top + rect.height / 2).length;
  const over = current.groupRects.find(({ rect }) => event.clientY >= rect.top && event.clientY < rect.bottom)?.key;
  if (over !== undefined && over !== current.group) current.foreign = over;
  else delete current.foreign;
}

function slideBack(current: Drag): void {
  current.phase = 'returning';
  current.dy = 0;
  delete current.foreign;
}

// The dropped row has slid back to its place.
function onDragEnd(event: TransitionEvent): void {
  const current = drag.value;
  if (current?.phase === 'returning' && event.propertyName === 'transform' && (event.target as HTMLElement).dataset.dragId === current.id) drag.value = undefined;
}

function refuseDrop(project: ShellProject, target: GroupView): void {
  const own = project.authority.key;
  const host = project.authority.name;
  const text = own === LOCAL_GROUP
    ? t('projects.otherGroupFromLocal', { project: project.name, target: target.name })
    : target.key === LOCAL_GROUP
      ? t('projects.otherGroupToLocal', { project: project.name, host })
      : t('projects.otherGroup', { project: project.name, host, target: target.name });
  const hostId = target.hostId;
  const action = target.key === LOCAL_GROUP
    ? { label: t('projects.openLocalFolder'), run: () => props.api.addProject() }
    : hostId !== undefined && props.remoteEnabled ? { label: t('projects.group.openFolder', { name: target.name }), run: () => props.api.openHostFolder(hostId) } : undefined;
  refusal.value = action ? { text, action } : { text };
}

async function onPointerUp(event: PointerEvent): Promise<void> {
  const current = drag.value;
  if (!current || current.phase !== 'dragging' || event.pointerId !== current.pointerId) return;
  if (!current.started) {
    drag.value = undefined;
    return;
  }
  clickAfterDrag = true;
  refusal.value = undefined;
  const key = current.id.slice(current.id.indexOf(':') + 1);
  const project = props.projects.find((candidate) => candidate.key === key && current.id.startsWith('p:'));
  const foreign = groupViews.value.find((group) => group.key === current.foreign);
  if (foreign && project) {
    slideBack(current);
    refuseDrop(project, foreign);
    return;
  }
  const result = !project
    ? moveGroup(shownGroupKeys.value, key, current.target)
    : current.group === undefined
      ? moveProject(ordered.value, key, current.target)
      : moveProjectInGroup(ordered.value, key, current.group, current.target);
  if (!result.ok) {
    slideBack(current);
    return;
  }
  current.phase = 'committing';
  const saved = project ? await commitProjects(result.order, current.id) : await commitGroups(result.order, `g:${key}`);
  if (drag.value !== current) return;
  if (!saved) slideBack(current);
  else settleOnNextState(current);
}

// Main sends its state after answering the write. A state whose rows did not move (a write that raced this one) changes no
// layout signature, so the dropped row slides back to the place that state gives it.
const sectionScope = getCurrentScope();
function settleOnNextState(current: Drag): void {
  sectionScope?.run(() => {
    const stop = watch(() => [props.projects, props.groups], () => {
      stop();
      if (drag.value === current) slideBack(current);
    }, { flush: 'post' });
  });
}

function onPointerCancel(event: PointerEvent): void {
  const current = drag.value;
  if (current?.phase === 'dragging' && event.pointerId === current.pointerId) {
    if (current.started) slideBack(current);
    else drag.value = undefined;
  }
}

useEventListener(window, 'pointermove', onPointerMove);
useEventListener(window, 'pointerup', (event: PointerEvent) => void onPointerUp(event));
useEventListener(window, 'pointercancel', onPointerCancel);

// The click that ends a drag selects nothing and toggles no group.
function onClickCapture(event: MouseEvent): void {
  if (!clickAfterDrag) return;
  clickAfterDrag = false;
  event.stopPropagation();
}

function dragAttrs(id: string): Record<string, unknown> {
  const current = drag.value;
  const at = current?.started ? current.siblings.indexOf(id) : -1;
  if (!current || at < 0) return { 'data-drag-id': id };
  if (at === current.index) {
    return {
      'data-drag-id': id,
      'data-dragging': current.phase === 'returning' ? undefined : 'true',
      class: current.phase === 'returning' ? SETTLE : undefined,
      // the row follows the pointer even with reduced motion, which only drops the lift
      style: { transform: current.phase === 'returning' ? '' : `translateY(${current.dy}px)${prefersReducedMotion() ? '' : ' scale(1.02)'}` },
    };
  }
  const { index, target, room } = current;
  const shift = current.phase === 'returning' ? 0 : index < target && at > index && at <= target ? -room : index > target && at >= target && at < index ? room : 0;
  return { 'data-drag-id': id, class: 't-row-move', style: { transform: shift ? `translateY(${shift}px)` : '' } };
}

const layoutSignature = computed(() => `${props.view}\n${rows.value.map((row) => row.id).join('\n')}`);

function flipRects(): Map<string, DOMRect> {
  return new Map([...(listbox.value?.querySelectorAll<HTMLElement>('[data-flip]') ?? [])].map((element) => [element.dataset.flip!, element.getBoundingClientRect()]));
}

function glide(before: Map<string, DOMRect>, settle: string | undefined): void {
  for (const element of listbox.value?.querySelectorAll<HTMLElement>('[data-flip]') ?? []) {
    const from = before.get(element.dataset.flip!);
    if (!from) continue;
    const to = element.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    const moveClass = element.dataset.flip === settle ? SETTLE.split(' ') : ['t-row-move'];
    element.style.transform = `translate(${dx}px, ${dy}px)`;
    void element.offsetWidth;
    element.classList.add(...moveClass);
    element.style.transform = '';
    element.addEventListener('transitionend', () => element.classList.remove(...moveClass), { once: true });
  }
}

// Measured before the DOM changes (pre flush), with any drag still drawn, so a dropped row settles from where it was let go.
watch(layoutSignature, () => {
  const settle = settleId;
  settleId = undefined;
  const before = prefersReducedMotion() ? undefined : flipRects();
  drag.value = undefined;
  if (before) void nextTick(() => glide(before, settle));
}, { flush: 'pre' });

// Groups that just opened reveal their rows one after another.
const revealing = ref(new Set<string>());
watch(() => props.groups.collapsed, (now, before) => {
  revealing.value = new Set(before.filter((key) => !now.includes(key)));
  void nextTick(() => {
    revealing.value = new Set();
  });
}, { flush: 'pre' });

// A project that joins the list after it mounted drops into place, then draws the eye once.
const fresh = ref(new Set<string>());
watch(() => props.projects.map((project) => project.key), (now, before) => {
  const added = now.filter((key) => !before.includes(key));
  if (added.length === 0) return;
  fresh.value = new Set([...fresh.value, ...added]);
  for (const key of added) {
    const group = groupViews.value.find((candidate) => candidate.projects.some((project) => project.key === key));
    if (grouped.value && group?.collapsed) void props.api.setProjectGroupCollapsed(group.key, false);
  }
  void nextTick(() => {
    const row = rows.value.find((candidate) => candidate.id === `p:${added[0]}`);
    if (row) document.getElementById(row.domId)?.scrollIntoView({ block: 'nearest' });
  });
});

function onRowAnimationEnd(key: string, event: AnimationEvent): void {
  if (event.target !== event.currentTarget || !fresh.value.has(key) || event.animationName !== 'd-tuck-in') return;
  const row = event.currentTarget as HTMLElement;
  fresh.value = new Set([...fresh.value].filter((candidate) => candidate !== key));
  // after the render that drops d-row-drop, which rewrites the row's class list
  void nextTick(() => playAttention(row));
}

defineExpose({
  focus: (): boolean => {
    if (!listbox.value || props.collapsed) return false;
    activeId.value = undefined;
    listbox.value.focus();
    return true;
  },
  bodyHeight: (): number => section.value?.bodyHeight() ?? 0,
});
</script>

<template>
  <SidebarSection
    ref="section"
    section="projects"
    data-testid="sidebar-projects"
    :count="projects.length"
    :collapsed="collapsed"
    :body-size="bodySize"
    @toggle="emit('toggle')"
  >
    <template #chip>
      <SegmentedToggle
        variant="equal"
        data-testid="projects-view"
        :model-value="view"
        :options="viewOptions"
        :aria-label="t('projects.view.label')"
        class="bg-(--d-hover) shadow-[inset_0_0_0_1px_var(--d-border)]"
        indicator-class="text-(--d-card) shadow-[0_0_0_1px_var(--d-border2)]"
        @update:model-value="setView"
      />
    </template>
    <template #actions>
      <Button
        v-if="remoteEnabled"
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="connect-host"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :aria-label="t('projects.connect')"
        :title="t('projects.connect')"
        @click="openConnect"
      >
        <Plug
          aria-hidden="true"
          class="size-3.25"
        />
      </Button>
      <Button
        ref="addButton"
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="add-project"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :aria-haspopup="remoteEnabled ? 'menu' : undefined"
        :aria-expanded="remoteEnabled ? addMenuOpen : undefined"
        :aria-label="t('projects.add')"
        :title="t('projects.add')"
        @click="openAddMenu"
      >
        <FolderPlus
          aria-hidden="true"
          class="size-3.25"
        />
      </Button>
    </template>
    <p
      v-if="projects.length === 0"
      class="px-3 py-2 text-xs text-(--d-faint)"
    >
      {{ t('projects.empty') }}
    </p>
    <!-- A listbox with aria-activedescendant, which no shadcn part provides outside a popup; groups and their header rows are
         its own rows, so the arrow keys move through both views alike. -->
    <div
      v-else
      :id="listId"
      ref="listbox"
      role="listbox"
      tabindex="0"
      data-testid="projects-list"
      :aria-label="t('projects.listLabel')"
      :aria-describedby="helpId"
      :aria-activedescendant="activeRow?.domId"
      class="group/list flex min-h-0 flex-1 flex-col gap-px overflow-x-hidden overflow-y-auto px-1.5 pt-0.5 pb-1.5 focus-visible:outline-none"
      @keydown="onKeydown"
      @pointerdown="onPointerDown"
      @click.capture="onClickCapture"
      @transitionend="onDragEnd"
    >
      <template v-if="!grouped">
        <ProjectRow
          v-for="(project, index) in projects"
          :id="`${listId}-p${index}`"
          :key="project.key"
          v-bind="dragAttrs(`p:${project.key}`)"
          :project="project"
          :selected="project.key === selectedKey"
          :active="activeRow?.id === `p:${project.key}`"
          :grouped="false"
          :host="hostOf(project.authority.key)"
          :class="{ 'd-row-drop': fresh.has(project.key) }"
          @click="select(project)"
          @contextmenu="onContextMenu(projectRow(project, index), $event)"
          @trust="trust(project)"
          @animationend="onRowAnimationEnd(project.key, $event)"
        />
      </template>
      <template v-else>
        <ProjectGroup
          v-for="(group, index) in groupViews"
          :key="group.key"
          :ref="(component) => setGroupComponent(group.key, component)"
          v-bind="dragAttrs(`group:${group.key}`)"
          :data-refuse="drag?.foreign === group.key || undefined"
          :group-key="group.key"
          :name="group.name"
          :connection="group.connection"
          :host="hostOf(group.key)"
          :collapsed="group.collapsed"
          :header-id="`${listId}-g${index}`"
          :active="activeRow?.id === `g:${group.key}`"
          :busy="group.busy"
          :renaming="renaming === group.key"
          @toggle="toggleGroup(group)"
          @rename-submit="submitRename(group, $event, true)"
          @rename-blur="submitRename(group, $event, false)"
          @rename-cancel="endRename(true)"
          @contextmenu="onContextMenu({ id: `g:${group.key}`, domId: `${listId}-g${index}`, kind: 'header', group }, $event)"
        >
          <TransitionGroup
            v-bind="revealing.has(group.key) ? { enterActiveClass: 'd-row-reveal' } : {}"
            leave-active-class="t-tuck-leave-active"
          >
            <ProjectRow
              v-for="(project, at) in group.collapsed ? [] : group.projects"
              :id="`${listId}-p${projectIndex.get(project.key)}`"
              :key="project.key"
              v-bind="dragAttrs(`p:${project.key}`)"
              :project="project"
              :selected="project.key === selectedKey"
              :active="activeRow?.id === `p:${project.key}`"
              :grouped="true"
              :host="hostOf(project.authority.key)"
              :class="{ 'd-row-drop': fresh.has(project.key) }"
              :style="{ '--reveal-index': at }"
              @click="select(project)"
              @contextmenu.stop="onContextMenu(projectRow(project, projectIndex.get(project.key)!), $event)"
              @trust="trust(project)"
              @animationend="onRowAnimationEnd(project.key, $event)"
            />
          </TransitionGroup>
        </ProjectGroup>
      </template>
    </div>
    <p
      :id="helpId"
      class="sr-only"
    >
      {{ t('projects.keyboardHelp') }}
    </p>
    <p
      v-if="refusal"
      role="alert"
      data-testid="projects-refusal"
      class="px-3 pb-2 text-xs text-(--d-danger-text)"
    >
      {{ refusal.text }}
      <Button
        v-if="refusal.action"
        type="button"
        variant="link"
        data-testid="projects-refusal-action"
        class="ml-1 h-auto p-0 text-xs font-semibold text-(--d-accent-text) underline-offset-2"
        @click="refusal.action.run()"
      >
        {{ refusal.action.label }}
      </Button>
    </p>
    <p
      data-testid="projects-announcement"
      class="sr-only"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
  </SidebarSection>
</template>
