<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bell, BellOff, ChevronRight, Moon, PanelLeft, PanelRight, Settings, Sun } from 'lucide-vue-next';
import type { DamoclesShellApi, ShellState } from '../../preload/shell-channels';
import ProjectAvatar from './ProjectAvatar.vue';

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
const paneTitle = computed(() => {
  const shortcut = props.state.paneShortcutLabel;
  return props.state.pane?.open ? t('pane.hide', { shortcut }) : t('pane.show', { shortcut });
});

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
      class="title-bar-control flex h-[30px] shrink-0 items-center gap-[9px] rounded-[7px] pr-3 pl-3.5 hover:bg-(--d-hover)"
      :aria-label="t('titleBar.appMenu', { app: APP_NAME })"
      :title="t('titleBar.appMenu', { app: APP_NAME })"
      aria-haspopup="menu"
      @click="openAppMenu"
    >
      <img
        :src="LOGO_URL"
        alt=""
        class="size-[18px]"
      >
      <span class="font-semibold tracking-[-.01em]">{{ APP_NAME }}</span>
    </button>
    <nav
      data-testid="breadcrumb"
      :aria-label="t('titleBar.breadcrumb')"
      class="flex min-w-0 items-center gap-1.5 text-[12.5px] text-(--d-muted)"
    >
      <span class="flex min-w-0 items-center gap-1.5 rounded-[7px] bg-(--d-hover) px-2 py-[3px]">
        <ProjectAvatar
          :name="projectName"
          class="size-3.5 rounded text-[9px]"
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
          class="max-w-[340px] truncate text-(--d-text)"
          data-testid="breadcrumb-chat"
          aria-current="page"
        >{{ chatTitle }}</span>
      </template>
    </nav>
    <div class="h-full min-w-3 flex-1" />
    <div class="flex shrink-0 items-center gap-0.5 px-2">
      <button
        type="button"
        data-testid="toggle-sidebar"
        class="title-bar-control flex h-7 w-[30px] items-center justify-center rounded-[7px] transition-all duration-150 hover:bg-(--d-hover)"
        :class="state.layout.sidebarVisible ? 'text-(--d-accent)' : 'text-(--d-muted)'"
        :aria-label="t('titleBar.toggleSidebarName')"
        :title="sidebarTitle"
        :aria-pressed="state.layout.sidebarVisible"
        @click="api.toggleSidebar()"
      >
        <PanelLeft
          aria-hidden="true"
          class="size-[15px]"
        />
      </button>
      <button
        v-if="state.pane"
        type="button"
        data-testid="toggle-pane"
        class="title-bar-control flex h-7 w-[30px] items-center justify-center rounded-[7px] transition-all duration-150 hover:bg-(--d-hover)"
        :class="state.pane.open ? 'text-(--d-accent)' : 'text-(--d-muted)'"
        :aria-label="t('pane.toggleName')"
        :title="paneTitle"
        :aria-pressed="state.pane.open"
        @click="api.togglePane()"
      >
        <PanelRight
          aria-hidden="true"
          class="size-[15px]"
        />
      </button>
      <div
        aria-hidden="true"
        class="mx-1.5 h-4 w-px bg-(--d-border2)"
      />
      <button
        ref="bell"
        type="button"
        data-testid="notification-bell"
        class="title-bar-control relative flex h-7 w-[30px] items-center justify-center rounded-[7px] transition-colors duration-150 hover:bg-(--d-hover) hover:text-(--d-text)"
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
            class="size-[15px]"
          />
          <Bell
            v-else
            aria-hidden="true"
            class="size-[15px]"
          />
        </span>
        <span
          v-if="bellState.unseen > 0"
          :key="badgePops"
          aria-hidden="true"
          data-testid="notification-badge"
          class="absolute top-0.5 right-[3px] flex h-[15px] min-w-[15px] items-center justify-center rounded-full border-2 border-(--d-panel) bg-(--d-warning) px-[3px] text-[9px] leading-none font-bold text-(--d-on-warning)"
          :class="badgePops > 0 ? 'bell-badge-pop' : ''"
        >{{ bellState.unseen > 99 ? '99+' : bellState.unseen }}</span>
      </button>
      <button
        type="button"
        data-testid="toggle-theme"
        class="title-bar-control flex h-7 w-[30px] items-center justify-center rounded-[7px] text-(--d-muted) transition-all duration-150 hover:bg-(--d-hover) hover:text-(--d-text)"
        :aria-label="themeTitle"
        :title="themeTitle"
        @click="api.toggleTheme()"
      >
        <Sun
          v-if="state.effectiveTheme === 'dark'"
          aria-hidden="true"
          class="size-[15px]"
        />
        <Moon
          v-else
          aria-hidden="true"
          class="size-[15px]"
        />
      </button>
      <button
        type="button"
        data-testid="open-settings"
        class="title-bar-control flex h-7 w-[30px] items-center justify-center rounded-[7px] text-(--d-muted) transition-all duration-150 hover:bg-(--d-hover) hover:text-(--d-text)"
        :aria-label="t('titleBar.settingsName')"
        :title="settingsTitle"
        @click="api.openSettings()"
      >
        <Settings
          aria-hidden="true"
          class="size-[15px]"
        />
      </button>
    </div>
  </header>
</template>
