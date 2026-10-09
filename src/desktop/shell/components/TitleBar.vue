<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bell, BellOff, ChevronRight, Moon, PanelBottom, PanelLeft, PanelRight, Search, Settings, Sun } from 'lucide-vue-next';
import type { DamoclesShellApi, ShellState } from '../../preload/shell-channels';
import ProjectAvatar from './ProjectAvatar.vue';
import UpdatePill from './UpdatePill.vue';
import WindowControls from './WindowControls.vue';
import { ariaKeyshortcuts } from '../overlay/quick-pick';

const props = defineProps<{ api: DamoclesShellApi; state: ShellState }>();
const { t } = useI18n();

// Served by protocol.ts beside the shell; a bound URL, so vite does not treat it as a module import.
const LOGO_URL = 'app://damocles/resources/icon.png';
const APP_NAME = 'Damocles';

const logo = ref<HTMLElement | null>(null);
const projectName = computed(() => props.state.projects.find((entry) => entry.key === props.state.selected.projectKey)?.name ?? t('projects.home'));
const chatTitle = computed(() => {
  const chat = props.state.selectedChat;
  if (!chat) return undefined;
  return chat.title || t('chats.newChat');
});
const sidebarTitle = computed(() => t('titleBar.toggleSidebar', { shortcut: props.state.shortcuts.toggleSidebar }));
const settingsTitle = computed(() => t('titleBar.settings', { shortcut: props.state.shortcuts.settings }));
const themeTitle = computed(() => (props.state.effectiveTheme === 'dark' ? t('titleBar.themeToLight') : t('titleBar.themeToDark')));
const terminalTitle = computed(() => t('titleBar.toggleTerminal', { shortcut: props.state.shortcuts.toggleTerminal }));
const grid = computed(() => props.state.layout.grid);

function openAppMenu(): void {
  const rect = logo.value?.getBoundingClientRect();
  void props.api.openAppMenu({ x: Math.max(0, Math.round(rect?.left ?? 0)), y: Math.max(0, Math.round(rect?.bottom ?? 0)) });
}

const bell = ref<HTMLElement | null>(null);
const centerOpen = ref(false);
const bellState = computed(() => props.state.notifications);
const quiet = computed(() => bellState.value.doNotDisturb || bellState.value.popupsOff);
const BELL_TEXT = {
  on: { title: 'titleBar.notifications', unseen: 'titleBar.notificationsUnseen' },
  dnd: { title: 'titleBar.notificationsDnd', unseen: 'titleBar.notificationsUnseenDnd' },
  off: { title: 'titleBar.notificationsOff', unseen: 'titleBar.notificationsUnseenOff' },
} as const;
const bellText = computed(() => BELL_TEXT[bellState.value.doNotDisturb ? 'dnd' : bellState.value.popupsOff ? 'off' : 'on']);
const bellTitle = computed(() => t(bellText.value.title));
// The label keeps the pop-up state the title shows, with the count when there is one.
const bellLabel = computed(() => {
  const { unseen } = bellState.value;
  return unseen > 0 ? t(bellText.value.unseen, { count: unseen }, unseen) : bellTitle.value;
});

// The badge pops when the count rises and the bell rings for a new entry that asks for the user; each re-keys its
// element so the one-shot animation plays again. Nothing plays for the state the page loads with.
const badgePops = ref(0);
const rings = ref(0);
watch(() => bellState.value.unseen, (count, previous) => {
  if (count > previous) badgePops.value++;
});
watch(() => bellState.value.attention, (count, previous) => {
  if (count > previous) rings.value++;
});

async function openCenter(): Promise<void> {
  const rect = bell.value?.getBoundingClientRect();
  if (!rect || centerOpen.value) return;
  centerOpen.value = true;
  try {
    await props.api.requestOverlay({
      kind: 'notifications',
      anchor: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
    });
  } finally {
    centerOpen.value = false;
  }
}
</script>

<template>
  <header
    data-testid="title-bar"
    class="title-bar flex h-10 shrink-0 items-center border-b border-(--d-border) bg-(--d-panel)"
    :class="state.platform === 'darwin' ? 'title-bar-darwin' : ''"
  >
    <button
      ref="logo"
      type="button"
      data-testid="app-menu"
      class="title-bar-control flex h-7.5 shrink-0 items-center gap-2.25 rounded-7 pr-3 pl-3.5 hover:bg-(--d-hover)"
      :aria-label="t('titleBar.appMenu', { app: APP_NAME })"
      :title="t('titleBar.appMenu', { app: APP_NAME })"
      aria-haspopup="menu"
      @click="openAppMenu"
    >
      <img
        :src="LOGO_URL"
        alt=""
        class="size-4.5"
      >
      <span class="font-semibold tracking-[-.01em]">{{ APP_NAME }}</span>
    </button>
    <nav
      data-testid="breadcrumb"
      :aria-label="t('titleBar.breadcrumb')"
      class="flex min-w-0 items-center gap-1.5 text-12.5 text-(--d-muted)"
    >
      <span class="flex min-w-0 items-center gap-1.5 rounded-7 bg-(--d-hover) px-2 py-0.75">
        <ProjectAvatar
          :name="projectName"
          class="size-3.5 rounded text-[0.5625rem]"
        />
        <span
          class="truncate"
          data-testid="breadcrumb-project"
        >{{ projectName }}</span>
      </span>
      <template v-if="chatTitle !== undefined">
        <ChevronRight
          aria-hidden="true"
          class="size-3 shrink-0 text-(--d-faint)"
        />
        <span
          class="max-w-85 truncate text-(--d-text)"
          data-testid="breadcrumb-chat"
          aria-current="page"
        >{{ chatTitle }}</span>
      </template>
    </nav>
    <div class="flex h-full min-w-3 flex-1 items-center justify-center px-3">
      <button
        type="button"
        data-testid="quick-open-box"
        class="title-bar-control flex h-6.5 w-full max-w-90 min-w-0 items-center gap-2 rounded-7 border border-(--d-border2) bg-(--d-input) px-2.5 text-xs text-(--d-faint) transition-colors duration-150 hover:border-(--d-accent) hover:text-(--d-muted)"
        :title="t('titleBar.quickOpenTitle', { shortcut: state.shortcuts.quickOpen })"
        :aria-label="t('titleBar.quickOpen')"
        :aria-keyshortcuts="ariaKeyshortcuts(state.shortcuts.quickOpen)"
        @click="api.openQuickOpen()"
      >
        <Search
          aria-hidden="true"
          class="size-3.25 shrink-0"
        />
        <span class="min-w-0 flex-1 truncate text-left">{{ t('titleBar.quickOpen') }}</span>
        <kbd class="shrink-0 rounded-5 border border-(--d-border2) px-1.25 font-mono text-10.5">{{ state.shortcuts.quickOpen }}</kbd>
      </button>
    </div>
    <div class="flex shrink-0 items-center gap-0.5 px-2">
      <button
        type="button"
        data-testid="toggle-sidebar"
        class="title-bar-control flex h-7 w-7.5 items-center justify-center rounded-7 transition-all duration-150 hover:bg-(--d-hover)"
        :class="state.layout.sidebarVisible ? 'text-(--d-accent)' : 'text-(--d-muted)'"
        :aria-label="t('titleBar.toggleSidebarName')"
        :title="sidebarTitle"
        :aria-pressed="state.layout.sidebarVisible"
        @click="api.toggleSidebar()"
      >
        <PanelLeft
          aria-hidden="true"
          class="size-3.75"
        />
      </button>
      <button
        type="button"
        data-testid="toggle-terminal"
        class="title-bar-control flex h-7 w-7.5 items-center justify-center rounded-7 transition-all duration-150 hover:bg-(--d-hover)"
        :class="grid.visible.terminal ? 'text-(--d-accent)' : 'text-(--d-muted)'"
        :aria-label="t('titleBar.toggleTerminalName')"
        :title="terminalTitle"
        :aria-pressed="grid.visible.terminal"
        @click="api.toggleTerminal()"
      >
        <PanelBottom
          aria-hidden="true"
          class="size-3.75"
        />
      </button>
      <button
        type="button"
        data-testid="toggle-editor"
        class="title-bar-control flex h-7 w-7.5 items-center justify-center rounded-7 transition-all duration-150 hover:bg-(--d-hover)"
        :class="grid.visible.editor ? 'text-(--d-accent)' : 'text-(--d-muted)'"
        :aria-label="t('titleBar.toggleEditor')"
        :title="t('titleBar.toggleEditor')"
        :aria-pressed="grid.visible.editor"
        @click="api.toggleEditor()"
      >
        <PanelRight
          aria-hidden="true"
          class="size-3.75"
        />
      </button>
      <div
        aria-hidden="true"
        class="mx-1.5 h-4 w-px bg-(--d-border2)"
      />
      <UpdatePill
        :api="api"
        :platform="state.platform"
      />
      <button
        ref="bell"
        type="button"
        data-testid="notification-bell"
        class="title-bar-control relative flex h-7 w-7.5 items-center justify-center rounded-7 transition-colors duration-150 hover:bg-(--d-hover) hover:text-(--d-text)"
        :class="[bellState.unseen > 0 ? 'text-(--d-text)' : 'text-(--d-muted)', centerOpen ? 'bg-(--d-hover)' : '']"
        :aria-label="bellLabel"
        :title="bellTitle"
        aria-haspopup="dialog"
        :aria-expanded="centerOpen"
        @click="openCenter"
      >
        <span
          :key="rings"
          data-testid="notification-bell-icon"
          class="flex"
          :class="rings > 0 ? 'bell-ring' : ''"
        >
          <BellOff
            v-if="quiet"
            aria-hidden="true"
            class="size-3.75"
          />
          <Bell
            v-else
            aria-hidden="true"
            class="size-3.75"
          />
        </span>
        <span
          v-if="bellState.unseen > 0"
          :key="badgePops"
          aria-hidden="true"
          data-testid="notification-badge"
          class="absolute top-0.5 right-0.75 flex h-3.75 min-w-3.75 items-center justify-center rounded-full border-2 border-(--d-panel) bg-(--d-warning) px-0.75 text-[0.5625rem] leading-none font-bold text-(--d-on-warning)"
          :class="badgePops > 0 ? 'bell-badge-pop' : ''"
        >{{ bellState.unseen > 99 ? '99+' : bellState.unseen }}</span>
      </button>
      <button
        type="button"
        data-testid="toggle-theme"
        class="title-bar-control flex h-7 w-7.5 items-center justify-center rounded-7 text-(--d-muted) transition-all duration-150 hover:bg-(--d-hover) hover:text-(--d-text)"
        :aria-label="themeTitle"
        :title="themeTitle"
        @click="api.toggleTheme()"
      >
        <Sun
          v-if="state.effectiveTheme === 'dark'"
          aria-hidden="true"
          class="size-3.75"
        />
        <Moon
          v-else
          aria-hidden="true"
          class="size-3.75"
        />
      </button>
      <button
        type="button"
        data-testid="open-settings"
        class="title-bar-control flex h-7 w-7.5 items-center justify-center rounded-7 text-(--d-muted) transition-all duration-150 hover:bg-(--d-hover) hover:text-(--d-text)"
        :aria-label="t('titleBar.settingsName')"
        :title="settingsTitle"
        @click="api.openSettings()"
      >
        <Settings
          aria-hidden="true"
          class="size-3.75"
        />
      </button>
    </div>
    <WindowControls
      v-if="state.platform !== 'darwin' && state.windowState !== 'fullScreen'"
      :api="api"
      :window-state="state.windowState"
    />
  </header>
</template>
