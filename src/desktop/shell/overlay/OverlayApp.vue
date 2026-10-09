<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest, PaletteCommand, QuickOpenResponse, QuickOpenScope } from '../../preload/overlay-channels';
import { applyShellLocale } from '../i18n';
import ContextMenu from './components/ContextMenu.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import MessageDialog from './components/MessageDialog.vue';
import NotificationCenter from './components/NotificationCenter.vue';
import TagPicker from './components/TagPicker.vue';
import QuickPick from './components/QuickPick.vue';
import TerminalPick from './components/TerminalPick.vue';
import ListPick from './components/ListPick.vue';
import DropZones from './components/DropZones.vue';
import { commandsModel, quickOpenItemId, quickOpenModel, type QuickPickModel } from './quick-pick';
import OverlaySettings from './settings/OverlaySettings.vue';
import type { OverlaySettingsBridge } from './settings/overlay-bridge';

const props = defineProps<{ api: DamoclesOverlayApi; settingsBridge: OverlaySettingsBridge }>();
const { t, locale } = useI18n();

// In arrival order; the last one is on top and receives Escape.
const open = shallowRef<ReadonlyArray<{ readonly id: string; readonly request: OverlayRequest }>>([]);

function close(id: string): boolean {
  const before = open.value.length;
  open.value = open.value.filter((entry) => entry.id !== id);
  return open.value.length !== before;
}

// Answers held while their popup plays its exit; main hides the overlay on an answer, which would cut the exit short.
const leaving = new Map<string, OverlayAnswer>();

// Answers go back only for a request main sent and that is still open, so each request is answered at most once.
function answer(id: string, value: OverlayAnswer): void {
  const entry = open.value.find((candidate) => candidate.id === id);
  if (!entry || !close(id)) return;
  // The settings modal has already played its own exit when it reports closed.
  if (entry.request.kind === 'settings') props.api.answer(id, value);
  else leaving.set(id, value);
}

// A popup on its way out is already answered: it takes no input and is gone for assistive technology.
function onBeforeLeave(element: Element): void {
  element.setAttribute('inert', '');
  element.setAttribute('aria-hidden', 'true');
}

function onAfterLeave(element: Element): void {
  const id = (element as HTMLElement).dataset.overlayId;
  const value = id === undefined ? undefined : leaving.get(id);
  if (id === undefined || value === undefined) return;
  leaving.delete(id);
  props.api.answer(id, value);
}

// Kinds that handle Escape themselves, so the window's handler leaves it to them: the settings modal and the dialogs through
// the overlay stack (a search query clears first, a dialog above the modal cancels without closing it), and Quick Open, New
// Terminal and the quick pick in QuickPick's own keydown.
const OWN_ESCAPE: ReadonlySet<OverlayRequest['kind']> = new Set(['settings', 'confirm', 'message', 'quickOpen', 'newTerminal', 'quickPick']);

// Quick Open asks main for each query; the last answer names the files a pick may choose and how main parsed the query. A
// query starting with ">" is the command palette, as in VS Code: it lists main's commands once per open request.
let quickOpenGeneration = 0;
let lastQuickOpen: QuickOpenResponse | undefined;
let paletteCommands: Promise<readonly PaletteCommand[]> | undefined;
const paletteMode = ref(false);
// The folder main limited the open Quick Open to; its files list in path order, without groups.
let quickOpenScope: QuickOpenScope | undefined;

function scopeName(scope: QuickOpenScope): string {
  return scope.folder === '' ? scope.projectName : `${scope.projectName} / ${scope.folder}`;
}
const PALETTE_PREFIX = '>';

async function loadQuickOpen(query: string): Promise<QuickPickModel> {
  paletteMode.value = query.startsWith(PALETTE_PREFIX);
  if (paletteMode.value) {
    paletteCommands ??= props.api.listCommands();
    return commandsModel(await paletteCommands, query.slice(PALETTE_PREFIX.length), locale.value !== 'en', {
      recent: t('palette.recent'),
      other: t('palette.other'),
    });
  }
  const response = await props.api.queryQuickOpen({ query, generation: ++quickOpenGeneration });
  // QuickPick shows only the newest query's answer, so a pick reads only that one.
  if (response.generation === quickOpenGeneration) lastQuickOpen = response;
  return quickOpenModel(response, query.trim() === '' && quickOpenScope === undefined, {
    recent: t('quickOpen.recent'),
    current: (project) => t('quickOpen.current', { project }),
    other: (project) => project,
    goToLine: (line) => t('quickOpen.goToLine', { line }),
    mention: t('quickOpen.mention'),
  });
}

function pickQuickOpen(id: string, itemId: string): void {
  if (paletteMode.value) {
    answer(id, { kind: 'quickOpen', command: itemId });
    return;
  }
  const response = lastQuickOpen;
  const result = response?.results.find((candidate) => quickOpenItemId(candidate) === itemId);
  if (!response || !result) return;
  const line = response.line;
  answer(id, { kind: 'quickOpen', pick: { projectKey: result.projectKey, relativePath: result.relativePath, mention: response.mention, ...(line === undefined ? {} : { line }) } });
}

function onKeydown(event: KeyboardEvent): void {
  const top = open.value[open.value.length - 1];
  if (event.key !== 'Escape' || !top || OWN_ESCAPE.has(top.request.kind)) return;
  event.preventDefault();
  answer(top.id, { kind: 'dismissed' });
}

const stops: Array<() => void> = [];
onMounted(async () => {
  stops.push(props.api.onRequest((id, request) => {
    if (request.kind === 'quickOpen') {
      paletteCommands = undefined;
      quickOpenScope = request.scope;
    }
    open.value = [...open.value, { id, request }];
    // The acknowledgement tells main the request is on screen, so it goes out once Vue has rendered it.
    void nextTick(() => {
      if (open.value.some((entry) => entry.id === id)) props.api.ack(id);
    });
  }));
  stops.push(props.api.onCancel((id) => void close(id)));
  // Subscribed before the first read, so a language change between the two is not lost.
  stops.push(props.api.onState((state) => applyShellLocale(state.locale)));
  window.addEventListener('keydown', onKeydown);
  applyShellLocale((await props.api.getState()).locale);
});
onBeforeUnmount(() => {
  for (const stop of stops) stop();
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="h-full">
    <TransitionGroup
      name="overlay-pop"
      @before-leave="onBeforeLeave"
      @after-leave="onAfterLeave"
    >
      <template
        v-for="entry in open"
        :key="entry.id"
      >
        <div
          v-if="entry.request.kind === 'settings'"
          :key="entry.id"
          :data-overlay-id="entry.id"
        >
          <OverlaySettings
            :api="api"
            :bridge="settingsBridge"
            :generation="entry.request.generation"
            :section="entry.request.section"
            :account="entry.request.account"
            :release="entry.request.release"
            @closed="answer(entry.id, { kind: 'settings', closed: true })"
          />
        </div>
        <ConfirmDialog
          v-else-if="entry.request.kind === 'confirm'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <MessageDialog
          v-else-if="entry.request.kind === 'message'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <DropZones
          v-else-if="entry.request.kind === 'dropZones'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :api="api"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <div
          v-else
          :key="entry.id"
          :data-overlay-id="entry.id"
          data-testid="overlay-backdrop"
          class="fixed inset-0"
          @click.self="answer(entry.id, { kind: 'dismissed' })"
          @contextmenu.self.prevent="answer(entry.id, { kind: 'dismissed' })"
        >
          <ContextMenu
            v-if="entry.request.kind === 'menu'"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <NotificationCenter
            v-else-if="entry.request.kind === 'notifications'"
            :api="api"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <TagPicker
            v-else-if="entry.request.kind === 'tagPicker'"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <QuickPick
            v-else-if="entry.request.kind === 'quickOpen'"
            :label="paletteMode ? t('palette.label') : entry.request.scope ? t('quickOpen.scopedLabel', { scope: scopeName(entry.request.scope) }) : t('quickOpen.label')"
            :placeholder="paletteMode ? t('palette.placeholder') : entry.request.scope ? t('quickOpen.scopedPlaceholder') : t('quickOpen.placeholder')"
            :scope="!paletteMode && entry.request.scope ? { project: entry.request.scope.projectName, label: scopeName(entry.request.scope) } : undefined"
            :empty-text="paletteMode ? t('palette.empty') : undefined"
            :initial-query="entry.request.mode === 'commands' ? PALETTE_PREFIX : ''"
            :load="loadQuickOpen"
            @accept="pickQuickOpen(entry.id, $event)"
            @cancel="answer(entry.id, { kind: 'quickOpen', pick: null })"
          />
          <TerminalPick
            v-else-if="entry.request.kind === 'newTerminal'"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <ListPick
            v-else-if="entry.request.kind === 'quickPick'"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
        </div>
      </template>
    </TransitionGroup>
  </div>
</template>
