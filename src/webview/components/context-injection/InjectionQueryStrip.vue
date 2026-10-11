<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { shortId } from './memory-display';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

const props = defineProps<{
  query: MemoryInjectionDisplay['query'];
}>();

const { t } = useI18n();

const isEmpty = computed(
  () => props.query.terms.length === 0 && props.query.dropped.length === 0
    && props.query.mentionedIds.length === 0 && props.query.files.length === 0,
);
</script>

<template>
  <section
    class="space-y-1.5"
    :aria-label="t('contextInjection.query.label')"
  >
    <p
      v-if="isEmpty"
      class="text-xs text-(--d-muted)"
      data-query-empty
    >
      {{ t('contextInjection.query.none') }}
    </p>

    <div
      v-if="query.terms.length > 0 || query.dropped.length > 0"
      class="flex flex-wrap items-center gap-1"
    >
      <span class="mr-1 text-11 text-(--d-muted)">{{ t('contextInjection.query.terms') }}</span>
      <Badge
        v-for="term in query.terms"
        :key="`t:${term}`"
        variant="secondary"
        class="px-1.5 py-0 text-10 font-normal"
        data-query-term
      >
        {{ term }}
      </Badge>
      <Badge
        v-for="item in query.dropped"
        :key="`d:${item.term}`"
        variant="outline"
        class="px-1.5 py-0 text-10 font-normal text-(--d-muted)"
        :title="t(`contextInjection.query.dropped.${item.reason}`)"
        :data-dropped-term="item.reason"
      >
        <s>{{ item.term }}</s>
        <span class="sr-only">{{ t('contextInjection.query.droppedReason', { reason: t(`contextInjection.query.dropped.${item.reason}`) }) }}</span>
      </Badge>
    </div>

    <div
      v-if="query.mentionedIds.length > 0"
      class="flex flex-wrap items-center gap-1"
    >
      <span class="mr-1 text-11 text-(--d-muted)">{{ t('contextInjection.query.mentioned') }}</span>
      <Badge
        v-for="id in query.mentionedIds"
        :key="id"
        variant="outline"
        class="px-1.5 py-0 font-mono text-10 font-normal"
        :title="id"
        data-mentioned-id
      >
        {{ shortId(id) }}
      </Badge>
    </div>

    <div
      v-if="query.files.length > 0"
      class="flex flex-wrap items-center gap-1"
    >
      <span class="mr-1 text-11 text-(--d-muted)">{{ t('contextInjection.query.files') }}</span>
      <Badge
        v-for="file in query.files"
        :key="`${file.source}:${file.path}`"
        variant="outline"
        class="max-w-full gap-1 px-1.5 py-0 text-10 font-normal"
        :data-query-file="file.source"
      >
        <span
          class="truncate font-mono"
          :title="file.path"
        >{{ file.path }}</span>
        <span class="shrink-0 text-(--d-muted)">{{ t(`contextInjection.query.fileSource.${file.source}`) }}</span>
      </Badge>
    </div>
  </section>
</template>
