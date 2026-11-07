<script setup lang="ts">
defineProps<{ columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; density?: 'comfortable' | 'compact' }>();
</script>

<template>
  <table class="w-full border-collapse text-sm">
    <thead>
      <tr>
        <th v-for="column in columns" :key="column.key" scope="col" class="border-b border-border px-3 py-2 text-left">{{ column.label }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, index) in rows" :key="index">
        <td v-for="column in columns" :key="column.key" class="border-b border-border px-3" :class="density === 'compact' ? 'py-1' : 'py-2'">
          <slot :name="column.key" :row="row">{{ row[column.key] }}</slot>
        </td>
      </tr>
    </tbody>
  </table>
</template>
