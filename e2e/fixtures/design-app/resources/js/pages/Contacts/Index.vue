<script setup lang="ts">
import { ref } from 'vue';
import Button from '../../components/ui/Button.vue';
import Input from '../../components/ui/Input.vue';
import Badge from '../../components/ui/Badge.vue';
import Table from '../../components/ui/Table.vue';
import type { Contact } from '../../../../types/contact';

defineProps<{ contacts: Contact[] }>();
const search = ref('');
const columns = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'status', label: 'Status' },
];
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-6">
    <header class="flex items-center justify-between gap-4">
      <h1 class="text-xl font-semibold">Contacts</h1>
      <Button variant="primary">New contact</Button>
    </header>
    <Input v-model="search" label="Search contacts" type="search" placeholder="Name or email" />
    <Table :columns="columns" :rows="contacts">
      <template #status="{ row }">
        <Badge :tone="row.status === 'active' ? 'success' : 'neutral'">{{ row.status }}</Badge>
      </template>
    </Table>
  </main>
</template>
