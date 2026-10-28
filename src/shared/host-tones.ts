// A host's safety color: a palette tone with a --d-<tone>-text shade and a --d-on-<tone> label color (safety-colors.test.ts).
export const HOST_TONES = ['accent', 'success', 'warning', 'danger', 'info'] as const;
export type HostTone = (typeof HOST_TONES)[number];

export const isHostTone = (value: unknown): value is HostTone => (HOST_TONES as readonly unknown[]).includes(value);
