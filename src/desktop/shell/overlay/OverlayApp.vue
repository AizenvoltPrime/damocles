<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DamoclesOverlayApi, InputBrowseResult, OverlayAnswer, OverlayRequest, OverlayState, PaletteCommand, QuickOpenResponse, QuickOpenScope } from '../../preload/overlay-channels';
import type { ShellPlatform } from '../../preload/shell-channels';
import { applyShellLocale, createLocaleHold } from '../i18n';
import { answerOf } from './popup-answer';
import ContextMenu from './components/ContextMenu.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import MessageDialog from './components/MessageDialog.vue';
import NotificationCenter from './components/NotificationCenter.vue';
import TagPicker from './components/TagPicker.vue';
import RefPicker from '../graph/RefPicker.vue';
import QuickPick from './components/QuickPick.vue';
import TerminalPick from './components/TerminalPick.vue';
import ListPick from './components/ListPick.vue';
import QuickInput from './components/QuickInput.vue';
import DropZones from './components/DropZones.vue';
import NewChatMenu from './components/NewChatMenu.vue';
import WorktreeDialog from './components/WorktreeDialog.vue';
import ConnectDialog from './components/ConnectDialog.vue';
import CloseRemoteDialog from './components/CloseRemoteDialog.vue';
import GitConsentDialog from './components/GitConsentDialog.vue';
import DevcontainerTrustDialog from './components/DevcontainerTrustDialog.vue';
import AllowYoloDialog from './components/AllowYoloDialog.vue';
import ClientCertificateDialog from './components/ClientCertificateDialog.vue';
import ForgeChooseAccountDialog from './components/ForgeChooseAccountDialog.vue';
import ForgePublishDialog from './components/ForgePublishDialog.vue';
import ForgeForkDialog from './components/ForgeForkDialog.vue';
import ForgeProtectedBranchDialog from './components/ForgeProtectedBranchDialog.vue';
import PipelinePopover from './components/PipelinePopover.vue';
import ClonePicker from './components/ClonePicker.vue';
import { commandsModel, quickOpenModel, quickOpenPick, type QuickOpenLabels, type QuickPickModel } from './quick-pick';
import OverlaySettings from './settings/OverlaySettings.vue';
import { applySettingsLocale, settingsLocalePending } from './settings/settings-messages';
import type { OverlaySettingsBridge } from './settings/overlay-bridge';

const props = defineProps<{ api: DamoclesOverlayApi; settingsBridge: OverlaySettingsBridge }>();
const { t, locale } = useI18n();

// QuickInput's path check follows main's platform; win32's rules, the strictest, until main's state arrives
const platform = ref<ShellPlatform>('win32');

// Mounted before main's state arrives: main sends requests from did-finish-load and this page acknowledges them from its
// mount, so no load may hold the mount. The entry starts the catalogs' loads from <html lang>, each state loads the language
// it names, and requests wait for the shell's catalog, a settings request also for the settings' (createLocaleHold).
// Settings messages are not held across that load: their handlers store core's text for reactive rendering, and this page mounts no vue-sonner Toaster.
function applyState(state: OverlayState): void {
  void applyShellLocale(state.locale);
  void applySettingsLocale(state.locale);
  platform.value = state.platform;
}

// In arrival order; the last one is on top and receives Escape. shown settles once main has been told the popup is on screen.
const open = shallowRef<ReadonlyArray<{ readonly id: string; readonly request: OverlayRequest; readonly shown: Promise<void> }>>([]);

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
// the overlay stack (a search query clears first, a dialog above the modal cancels without closing it), the Connect dialog, the dev container confirmation
// and the Allow YOLO question through their reka dialogs, and Quick Open, New Terminal, the quick pick, the clone picker and the input box in their own keydown.
const OWN_ESCAPE: ReadonlySet<OverlayRequest['kind']> = new Set(['settings', 'connect', 'closeRemote', 'gitCredentialConsent', 'devcontainerTrust', 'allowYolo', 'clientCertificate', 'forgeChooseAccount', 'forgePublish', 'forgeFork', 'forgeProtectedBranch', 'confirm', 'message', 'worktreeDialog', 'quickOpen', 'newTerminal', 'quickPick', 'input', 'cloneFromAccount']);

// Quick Open asks main for each query; the last answer names the files a pick may choose and how main parsed the query. A
// query starting with ">" is the command palette, as in VS Code: it lists main's commands once per open request.
let quickOpenGeneration = 0;
let lastQuickOpen: QuickOpenResponse | undefined;
let paletteCommands: Promise<readonly PaletteCommand[] | undefined> | undefined;
const paletteMode = ref(false);
// The folder main limited the open Quick Open to; its files list in path order, without groups.
let quickOpenScope: QuickOpenScope | undefined;

function scopeName(scope: QuickOpenScope): string {
  return scope.folder === '' ? scope.projectName : `${scope.projectName} / ${scope.folder}`;
}
const PALETTE_PREFIX = '>';

// undefined: main answered that Quick Open closed, so the list on screen stays while it leaves. A failed read, or main's
// index answering failed, says the list could not load rather than that nothing matched.
async function loadQuickOpen(query: string): Promise<QuickPickModel | undefined> {
  paletteMode.value = query.startsWith(PALETTE_PREFIX);
  if (paletteMode.value) {
    const asked = (paletteCommands ??= answerOf(props.api.listCommands()));
    let commands: readonly PaletteCommand[] | undefined;
    try {
      commands = await asked;
    } catch {
      // Not kept, so the next palette query asks again.
      if (paletteCommands === asked) paletteCommands = undefined;
      return { rows: [], failure: t('palette.loadFailed') };
    }
    if (!commands) return undefined;
    return commandsModel(commands, query.slice(PALETTE_PREFIX.length), locale.value !== 'en', {
      recent: t('palette.recent'),
      other: t('palette.other'),
    });
  }
  const generation = ++quickOpenGeneration;
  let response: QuickOpenResponse | undefined;
  try {
    response = await answerOf(props.api.queryQuickOpen({ query, generation }));
  } catch {
    response = { generation, mention: false, results: [], failed: true };
  }
  if (!response) return undefined;
  // QuickPick shows only the newest query's answer, so a pick reads only that one.
  if (response.generation === quickOpenGeneration) lastQuickOpen = response;
  const model: QuickPickModel = response.failed ? { rows: [], failure: t('quickOpen.loadFailed') } : quickOpenModel(response, query.trim() === '' && quickOpenScope === undefined, quickOpenLabels());
  return response.pathPending ? { ...model, update: typedPathModel(generation) } : model;
}

// The typed path's row main resolved after the text search answered the query of generation; undefined when it has none.
async function typedPathModel(generation: number): Promise<QuickPickModel | undefined> {
  let response: QuickOpenResponse | null | undefined;
  try {
    response = await answerOf(props.api.quickOpenPath(generation));
  } catch {
    return { rows: [], failure: t('quickOpen.loadFailed') };
  }
  if (!response || response.generation !== quickOpenGeneration || paletteMode.value) return undefined;
  lastQuickOpen = response;
  return quickOpenModel(response, false, quickOpenLabels());
}

function quickOpenLabels(): QuickOpenLabels {
  return {
    recent: t('quickOpen.recent'),
    current: (project) => t('quickOpen.current', { project }),
    other: (project) => project,
    goToLine: (line) => t('quickOpen.goToLine', { line }),
    goToLineColumn: (line, column) => t('quickOpen.goToLineColumn', { line, column }),
    mention: t('quickOpen.mention'),
    truncated: (count) => t('quickOpen.folderTruncated', { count: new Intl.NumberFormat(locale.value).format(count) }, count),
    stopped: t('quickOpen.folderStopped'),
    noEntries: (name) => t('quickOpen.folderNoMatch', { name }),
    folderEmpty: t('quickOpen.folderEmpty'),
    denied: t('quickOpen.folderDenied'),
  };
}

function pickQuickOpen(id: string, itemId: string): void {
  if (paletteMode.value) {
    answer(id, { kind: 'quickOpen', command: itemId });
    return;
  }
  const pick = lastQuickOpen && quickOpenPick(lastQuickOpen, itemId);
  if (pick) answer(id, { kind: 'quickOpen', pick });
}

// An input box's folder button; undefined when main answered that the box closed.
const browseInput = (value: string): Promise<InputBrowseResult | null | undefined> => answerOf(props.api.browseInput(value));

function onKeydown(event: KeyboardEvent): void {
  const top = open.value[open.value.length - 1];
  if (event.key !== 'Escape' || !top || OWN_ESCAPE.has(top.request.kind)) return;
  event.preventDefault();
  answer(top.id, { kind: 'dismissed' });
}

const stops: Array<() => void> = [];
// A request, and a cancel ordered behind it, reach the list once the language main named before it has loaded.
const afterLocale = createLocaleHold();
onMounted(async () => {
  stops.push(props.api.onRequest((id, request) => {
    // Sent before the render, which can outlast main's deadline on a cold or busy renderer; the deadline proves only that this page answers.
    props.api.ack(id);
    afterLocale(() => {
      if (request.kind === 'quickOpen') {
        paletteCommands = undefined;
        quickOpenScope = request.scope;
      }
      let reported!: () => void;
      const shown = new Promise<void>((resolve) => (reported = resolve));
      open.value = [...open.value, { id, request, shown }];
      void nextTick(() => {
        if (!open.value.some((entry) => entry.id === id)) return;
        props.api.shown(id);
        reported();
      });
    }, request.kind === 'settings' ? settingsLocalePending : undefined);
  }));
  stops.push(props.api.onCancel((id) => afterLocale(() => void close(id))));
  // Subscribed before the first read, so a language change between the two is not lost.
  stops.push(props.api.onState(applyState));
  window.addEventListener('keydown', onKeydown);
  applyState(await props.api.getState());
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
            :page="entry.request.page"
            :section="entry.request.section"
            :account="entry.request.account"
            :release="entry.request.release"
            :forge-server="entry.request.forgeServer"
            :forge-sign-in="entry.request.forgeSignIn"
            :forge-account="entry.request.forgeAccount"
            :scopes="entry.request.scopes"
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
        <CloseRemoteDialog
          v-else-if="entry.request.kind === 'closeRemote'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :api="api"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <GitConsentDialog
          v-else-if="entry.request.kind === 'gitCredentialConsent'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <ClientCertificateDialog
          v-else-if="entry.request.kind === 'clientCertificate'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <ForgeChooseAccountDialog
          v-else-if="entry.request.kind === 'forgeChooseAccount'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :api="api"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <ForgePublishDialog
          v-else-if="entry.request.kind === 'forgePublish'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :api="api"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <ForgeForkDialog
          v-else-if="entry.request.kind === 'forgeFork'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :api="api"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <ForgeProtectedBranchDialog
          v-else-if="entry.request.kind === 'forgeProtectedBranch'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :api="api"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <!-- The wrapper's leave plays the dialog's exit, which renders in place for it. -->
        <div
          v-else-if="entry.request.kind === 'devcontainerTrust'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          class="devcontainer-trust-overlay"
        >
          <DevcontainerTrustDialog
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
        </div>
        <!-- The wrapper's leave plays the panel's exit, which renders in place for it. -->
        <div
          v-else-if="entry.request.kind === 'allowYolo'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          class="allow-yolo-overlay"
        >
          <AllowYoloDialog
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
        </div>
        <WorktreeDialog
          v-else-if="entry.request.kind === 'worktreeDialog'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :api="api"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <!-- The wrapper's leave plays the dialog's exit, which renders in place for it. -->
        <div
          v-else-if="entry.request.kind === 'connect'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          class="connect-overlay"
        >
          <ConnectDialog
            :api="api"
            :request="entry.request"
            :shown="entry.shown"
            @answer="answer(entry.id, $event)"
          />
        </div>
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
          <PipelinePopover
            v-else-if="entry.request.kind === 'pipeline'"
            :api="api"
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
          <RefPicker
            v-else-if="entry.request.kind === 'refPicker'"
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
            :api="api"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <ClonePicker
            v-else-if="entry.request.kind === 'cloneFromAccount'"
            :api="api"
            @answer="answer(entry.id, $event)"
          />
          <ListPick
            v-else-if="entry.request.kind === 'quickPick'"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <NewChatMenu
            v-else-if="entry.request.kind === 'newChatMenu'"
            :api="api"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <QuickInput
            v-else-if="entry.request.kind === 'input'"
            :request="entry.request"
            :platform="platform"
            :browse="entry.request.browse ? browseInput : undefined"
            @answer="answer(entry.id, $event)"
          />
        </div>
      </template>
    </TransitionGroup>
  </div>
</template>
