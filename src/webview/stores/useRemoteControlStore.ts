import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { RemoteControlStatus, RemoteControlConnectionState } from '@shared/types/remote-control';

export const useRemoteControlStore = defineStore('remoteControl', () => {
  const enabled = ref(false);
  const connectionState = ref<RemoteControlConnectionState>('disconnected');
  const sessionUrl = ref<string | null>(null);
  const connectUrl = ref<string | null>(null);
  const environmentId = ref<string | null>(null);
  const error = ref<string | null>(null);

  function handleStatusChanged(status: RemoteControlStatus): void {
    enabled.value = status.enabled;
    connectionState.value = status.connectionState;
    sessionUrl.value = status.sessionUrl;
    connectUrl.value = status.connectUrl;
    environmentId.value = status.environmentId;
    error.value = status.error;
  }

  function $reset(): void {
    enabled.value = false;
    connectionState.value = 'disconnected';
    sessionUrl.value = null;
    connectUrl.value = null;
    environmentId.value = null;
    error.value = null;
  }

  return {
    enabled,
    connectionState,
    sessionUrl,
    connectUrl,
    environmentId,
    error,

    handleStatusChanged,
    $reset,
  };
});
