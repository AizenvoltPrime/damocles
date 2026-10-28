import type { ComputedRef, InjectionKey } from 'vue';

// The host a settings request named (Host settings on a host card), which Remote hosts shows first.
export const REMOTE_HOSTS_TARGET: InjectionKey<ComputedRef<string | undefined>> = Symbol('remoteHostsTarget');
