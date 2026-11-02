<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { MessageSquarePlus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, ShellHost, ShellProject } from '../../preload/shell-channels';
import ConnectionBanner from './ConnectionBanner.vue';

// The chat slot while no chat view covers it: a chat page's header row (the gutter's grip cell continues it), then the host's banner.
const props = defineProps<{ api: DamoclesShellApi; project: ShellProject | undefined; host: ShellHost | undefined }>();
const { t } = useI18n();

const hostName = computed(() => (props.project && props.project.authority.kind !== 'local' ? props.project.authority.name : undefined));
</script>

<template>
  <div
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    data-testid="chat-placeholder"
  >
    <header
      v-if="project"
      class="flex h-11.5 shrink-0 items-center border-b border-(--d-border) bg-(--d-panel) ps-4 pe-2.5 text-(--d-text)"
      data-testid="chat-placeholder-header"
    >
      <div class="flex min-w-0 items-baseline gap-1.5">
        <span class="truncate text-13.5/5 font-semibold tracking-[-.005em]">{{ project.name }}</span>
        <span
          v-if="hostName !== undefined"
          class="shrink-0 text-12 text-(--d-faint)"
        >{{ t('content.onHost', { host: hostName }) }}</span>
      </div>
    </header>
    <ConnectionBanner
      :key="host?.hostId ?? 'none'"
      :host="host"
      @reconnect="api.reconnectHost($event)"
      @sign-in="api.signInHost($event)"
      @show-log="api.showHostLog($event)"
      @edit-host="api.renameHostOnCard($event)"
      @switch-when-idle="api.switchHostWhenIdle($event)"
      @switch-now="api.switchHostNow($event)"
    />
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p class="text-sm font-medium">
        {{ t('content.empty') }}
      </p>
      <Button
        type="button"
        class="h-auto gap-1.5 rounded-lg px-3 py-1.5 text-xs hover:bg-primary [&_svg]:size-3.5"
        @click="api.newChat()"
      >
        <MessageSquarePlus
          aria-hidden="true"
          class="size-3.5"
        />
        {{ t('content.newChat') }}
      </Button>
    </div>
  </div>
</template>
