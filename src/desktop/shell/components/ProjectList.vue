<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderPlus, MessageSquarePlus, ShieldCheck, Star, Trash2 } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, ShellProject } from '../../preload/shell-channels';

const props = defineProps<{
  api: DamoclesShellApi;
  projects: readonly ShellProject[];
}>();
const { t } = useI18n();

// Only the latest refusal shows; any later action on the list clears it.
const refusal = ref<{ key: string; message: string } | undefined>();

async function remove(project: ShellProject): Promise<void> {
  refusal.value = undefined;
  const result = await props.api.removeProject(project.key);
  if (!result.ok) refusal.value = { key: project.key, message: t('projects.removeRefused', { name: project.name, reason: result.reason }) };
}

function act(action: () => Promise<void>): void {
  refusal.value = undefined;
  void action();
}
</script>

<template>
  <nav
    aria-labelledby="shell-projects-heading"
    class="flex w-60 shrink-0 flex-col border-r border-border bg-card"
  >
    <div class="flex h-9 shrink-0 items-center justify-between border-b border-border pl-3">
      <h2
        id="shell-projects-heading"
        class="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {{ t('projects.heading') }}
      </h2>
      <Button
        variant="ghost"
        size="icon-sm"
        class="h-9 w-9 rounded-none"
        :aria-label="t('projects.add')"
        :title="t('projects.add')"
        @click="act(() => api.addProject())"
      >
        <FolderPlus aria-hidden="true" />
      </Button>
    </div>
    <p
      v-if="projects.length === 0"
      class="p-3 text-xs text-muted-foreground"
    >
      {{ t('projects.empty') }}
    </p>
    <ul
      v-else
      class="min-h-0 flex-1 overflow-y-auto py-1"
    >
      <li
        v-for="project in projects"
        :key="project.key"
        class="group px-2 py-1.5 hover:bg-muted/60"
      >
        <div class="flex items-center gap-1">
          <div class="min-w-0 flex-1">
            <div
              class="truncate text-sm"
              :title="project.fsPath"
            >
              {{ project.name }}
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-1">
              <Badge
                v-if="project.isDefault"
                variant="secondary"
                class="px-1.5 py-0 text-[10px] font-medium"
              >
                {{ t('projects.default') }}
              </Badge>
              <Badge
                :variant="project.trusted ? 'outline' : 'destructive'"
                class="px-1.5 py-0 text-[10px] font-medium"
              >
                {{ project.trusted ? t('projects.trusted') : t('projects.untrusted') }}
              </Badge>
            </div>
          </div>
          <Button
            v-if="!project.isDefault"
            variant="ghost"
            size="icon-sm"
            class="size-7"
            :aria-label="t('projects.setDefault', { name: project.name })"
            :title="t('projects.setDefault', { name: project.name })"
            @click="act(() => api.selectProject(project.key))"
          >
            <Star aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="size-7"
            :aria-label="t('projects.newTabIn', { name: project.name })"
            :title="t('projects.newTabIn', { name: project.name })"
            @click="act(() => api.newTab(project.key))"
          >
            <MessageSquarePlus aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="size-7"
            :aria-label="t('projects.remove', { name: project.name })"
            :title="t('projects.remove', { name: project.name })"
            @click="remove(project)"
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
        <Button
          v-if="!project.trusted"
          variant="outline"
          size="sm"
          class="mt-1.5 h-7 w-full text-xs"
          :aria-label="t('projects.trustLabel', { name: project.name })"
          @click="act(() => api.grantTrust(project.key))"
        >
          <ShieldCheck aria-hidden="true" />
          {{ t('projects.trust') }}
        </Button>
        <p
          v-if="refusal?.key === project.key"
          role="alert"
          class="mt-1.5 text-xs text-error"
        >
          {{ refusal.message }}
        </p>
      </li>
    </ul>
  </nav>
</template>
