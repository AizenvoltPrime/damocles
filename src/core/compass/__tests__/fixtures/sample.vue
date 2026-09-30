<template>
  <div class="app">
    <h1>{{ title }}</h1>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { User } from './types';

const title = ref('Hello');
const count = ref(0);

function increment(): void {
  count.value++;
}

const doubled = computed(() => count.value * 2);

class UserService {
  getUser(id: number): User | null {
    return null;
  }
}
</script>
