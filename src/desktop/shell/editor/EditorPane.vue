<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AtSign, CircleAlert, FileX2, FolderSearch, LoaderCircle, Maximize2, Minimize2, MousePointerClick, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, FileRef, ShellEditorTab, ShellState } from '../../preload/shell-channels';
import PaneGrip from '../layout/PaneGrip.vue';
import { EDITOR_STORE } from './editor-store';
import { fileSize } from './file-size';
import EditorTabs from './EditorTabs.vue';
import Breadcrumbs from './Breadcrumbs.vue';
import ConflictBar from './ConflictBar.vue';
import CodeEditor from './CodeEditor.vue';
import DiffEditor from './DiffEditor.vue';
import MarkdownPreview from './MarkdownPreview.vue';
import ImagePreview from './ImagePreview.vue';
import BrowserTab from './BrowserTab.vue';
import SearchEditorTab from './SearchEditorTab.vue';

const props = defineProps<{ api: DamoclesShellApi; state: ShellState }>();
const emit = defineEmits<{ revealInFiles: [file: FileRef] }>();
const { t, locale } = useI18n();
const store = inject(EDITOR_STORE)!;

const root = ref<HTMLElement | null>(null);
const tab = computed(() => store.activeTab.value);
const TEXT_KINDS: ReadonlySet<ShellEditorTab['kind']> = new Set(['code', 'untitled', 'settings', 'log']);
const projectName = computed(() => props.state.projects.find((project) => project.key === tab.value?.projectKey)?.name);
const notDisplayed = computed(() => {
  const documentId = tab.value?.kind === 'notDisplayed' ? tab.value.documentId : undefined;
  const content = documentId === undefined ? undefined : store.contents.value.get(documentId);
  return content?.kind === 'notDisplayed' ? content : undefined;
});
watch(tab, (current) => {
  if (current?.kind === 'notDisplayed' && current.documentId !== undefined) void store.load(current.documentId);
}, { immediate: true });

const diffTab = computed(() => (tab.value?.diff ? (tab.value as ShellEditorTab & { diff: NonNullable<ShellEditorTab['diff']> }) : undefined));
const searchEditorTab = computed(() => (tab.value?.searchEditor && tab.value.documentId !== undefined ? (tab.value as ShellEditorTab & { searchEditor: NonNullable<ShellEditorTab['searchEditor']> }) : undefined));
const browserTab = computed(() => (tab.value?.browser ? (tab.value as ShellEditorTab & { browser: NonNullable<ShellEditorTab['browser']> }) : undefined));
const canMention = computed(() => tab.value !== null && tab.value.kind !== 'untitled' && tab.value.kind !== 'diff' && tab.value.kind !== 'browser');
const formatting = computed(() => tab.value?.documentId !== undefined && store.formatting.value.has(tab.value.documentId));
const conflictBusy = ref(false);
// The file's own name: a Compare tab's title names the comparison, a path names the file on any tab.
const fileNameOf = (current: ShellEditorTab): string => current.displayPath.split(/[\\/]/).at(-1) || current.title;

async function resolve(action: 'compare' | 'overwrite' | 'revert'): Promise<void> {
  if (!tab.value) return;
  conflictBusy.value = true;
  try {
    await store.resolveConflict(tab.value, action);
  } finally {
    conflictBusy.value = false;
  }
}

// The focus overlay grows the pane over the window (d-zoom) and shrinks it back before it returns to its slot.
const focusPhase = ref<'off' | 'on' | 'leaving'>('off');
watch(store.focusOverlay, (open) => {
  focusPhase.value = open ? 'on' : focusPhase.value === 'on' ? 'leaving' : 'off';
});
function onAnimationEnd(event: AnimationEvent): void {
  if (event.target === root.value && focusPhase.value === 'leaving') focusPhase.value = 'off';
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !event.defaultPrevented && store.focusOverlay.value) {
    event.preventDefault();
    void store.setFocusOverlay(false);
  }
}

// F6 parts: focus anywhere in the pane is the editor part.
function onFocusIn(): void {
  props.api.reportFocusedPart('editor');
}

// Focus leaving the pane, the window's included, triggers auto save on focus change, as the editor control's blur does.
function onFocusOut(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && root.value?.contains(event.relatedTarget)) return;
  props.api.reportFocusedPart(null);
  store.saveOnFocusChange();
}

// A toggle keeps one name and says its state through aria-pressed; the tooltip names what a click does.
const focusTitle = computed(() => (store.focusOverlay.value ? t('editor.focus.back') : t('editor.focus.open')));
</script>

<template>
  <section
    ref="root"
    data-testid="editor-pane"
    :aria-label="t('editor.label')"
    :data-focus-overlay="focusPhase !== 'off' ? focusPhase : undefined"
    class="editor-pane flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-(--d-bg)"
    :class="focusPhase === 'off' ? '' : focusPhase === 'on' ? 'editor-focus' : 'editor-focus editor-focus-leave'"
    @keydown="onKeydown"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @animationend="onAnimationEnd"
  >
    <!-- The chat header's height (h-11.5), background and border, so the pane tops read as one row across the grid. -->
    <header class="flex h-11.5 shrink-0 items-stretch border-b border-(--d-border) bg-(--d-panel)">
      <span class="flex w-4 shrink-0 items-center justify-center">
        <PaneGrip
          pane="editor"
          class="h-5 w-3"
        />
      </span>
      <EditorTabs
        :api="api"
        :close-shortcut="state.shortcuts.closeEditor"
        @reveal-in-files="emit('revealInFiles', $event)"
        @focus-overlay="store.setFocusOverlay(true)"
      />
      <div class="flex shrink-0 items-center gap-0.5 border-l border-(--d-border) px-1.5">
        <Button
          variant="ghost"
          size="icon"
          data-testid="editor-mention"
          class="d-press size-6.5 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
          :disabled="!canMention"
          :aria-label="t('editor.mention')"
          :title="t('editor.mention')"
          @click="tab && api.mentionTab(tab.id)"
        >
          <AtSign aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-testid="editor-focus-toggle"
          class="d-press size-6.5 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
          :disabled="!tab"
          :aria-label="t('editor.focus.label')"
          :title="focusTitle"
          :aria-pressed="store.focusOverlay.value"
          @click="store.setFocusOverlay(!store.focusOverlay.value)"
        >
          <Minimize2
            v-if="store.focusOverlay.value"
            aria-hidden="true"
          />
          <Maximize2
            v-else
            aria-hidden="true"
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-testid="editor-close-pane"
          class="d-press size-6.5 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
          :aria-label="t('editor.closePane')"
          :title="t('editor.closePane')"
          @click="store.setFocusOverlay(false); api.toggleEditor()"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </header>

    <div
      v-if="!tab"
      data-testid="editor-empty"
      class="pane-empty d-fade-in flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center"
    >
      <span class="flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
        <MousePointerClick
          aria-hidden="true"
          class="size-5"
        />
      </span>
      <p class="text-12.5 text-(--d-muted)">
        {{ t('editor.empty') }}
      </p>
      <p class="text-11.5 text-(--d-faint)">
        {{ t('editor.emptyHint', { shortcut: state.shortcuts.quickOpen }) }}
      </p>
    </div>

    <template v-else>
      <Breadcrumbs
        :tab="tab"
        :project-name="projectName"
      >
        <!-- A status chip, which no shadcn part draws; the store sets formatting only past FORMATTING_INDICATOR_DELAY_MS. -->
        <span
          role="status"
          class="flex shrink-0 items-center"
        >
          <Transition name="t-pop">
            <span
              v-if="formatting"
              data-testid="editor-formatting"
              class="flex items-center gap-1 rounded-full bg-(--d-accent-soft) py-0.5 pr-2 pl-1.5 text-10.5 font-medium text-(--d-accent-text)"
            >
              <LoaderCircle
                aria-hidden="true"
                class="d-spinning size-2.75"
              />{{ t('editor.formatting') }}
            </span>
          </Transition>
        </span>
      </Breadcrumbs>
      <Transition name="t-up">
        <ConflictBar
          v-if="tab.conflict"
          :name="fileNameOf(tab)"
          :compare="tab.diff?.conflictCompare === true"
          :busy="conflictBusy"
          @resolve="resolve"
        />
      </Transition>
      <div
        v-if="store.saveError.value?.tabId === tab.id"
        role="alert"
        data-testid="editor-save-error"
        class="flex shrink-0 items-center gap-2 border-b border-(--d-border) bg-[color-mix(in_srgb,var(--d-danger)_10%,var(--d-bg))] px-3.5 py-1.5 text-12 text-(--d-danger-text)"
      >
        <CircleAlert
          aria-hidden="true"
          class="size-3.5 shrink-0"
        />
        <span class="min-w-0 flex-1 wrap-break-word">{{ store.saveError.value.message }}</span>
      </div>
      <div
        id="editor-panel"
        role="tabpanel"
        :aria-labelledby="`editor-tab-${tab.id}`"
        class="relative min-h-0 flex-1"
      >
        <CodeEditor
          v-if="TEXT_KINDS.has(tab.kind)"
          :api="api"
          :tab="tab"
          :menu-shortcuts="state.shortcuts.editorMenu"
        />
        <SearchEditorTab
          v-else-if="searchEditorTab"
          :api="api"
          :tab="searchEditorTab"
          :platform="state.platform"
          :settings="state.search"
          :details-shortcut="state.shortcuts.toggleQueryDetails"
          :menu-shortcuts="state.shortcuts.editorMenu"
        />
        <DiffEditor
          v-else-if="diffTab"
          :key="diffTab.id"
          :api="api"
          :tab="diffTab"
          :menu-shortcuts="state.shortcuts.editorMenu"
        />
        <MarkdownPreview
          v-else-if="tab.kind === 'markdownPreview'"
          :key="tab.id"
          :api="api"
          :tab="tab"
        />
        <ImagePreview
          v-else-if="tab.kind === 'image'"
          :key="tab.id"
          :tab="tab"
        />
        <BrowserTab
          v-else-if="browserTab"
          :api="api"
          :tab="browserTab"
        />
        <div
          v-else
          :key="tab.id"
          data-testid="editor-not-displayed"
          class="pane-empty d-fade-in absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center"
        >
          <span class="flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
            <FileX2
              aria-hidden="true"
              class="size-5"
            />
          </span>
          <p class="text-12.5 font-medium text-(--d-text)">
            {{ t('editor.notDisplayed.title') }}
          </p>
          <p class="max-w-80 text-11.5 text-(--d-muted)">
            {{ t(`editor.notDisplayed.${notDisplayed?.reason ?? 'binary'}`) }}
            <template v-if="notDisplayed?.bytes !== undefined">
              {{ fileSize(notDisplayed.bytes, locale) }}
            </template>
          </p>
          <Button
            size="sm"
            variant="outline"
            data-testid="editor-reveal"
            class="d-press mt-1 h-7 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-3 text-12 hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.5"
            @click="api.editorTab({ action: 'revealInExplorer', tabId: tab.id })"
          >
            <FolderSearch aria-hidden="true" />{{ t('editor.menu.revealInExplorer') }}
          </Button>
        </div>
      </div>
    </template>
  </section>
</template>
