// A status banner's border, fill and text per tone; the shell scans this file by name (src/desktop/shell/style.css @source).
export const BANNER_TONE = {
  warning: 'border-(--d-warning)/25 bg-[color-mix(in_srgb,var(--d-warning)_11%,var(--d-bg))] text-(--d-warning-text)',
  danger: 'border-(--d-danger)/28 bg-[color-mix(in_srgb,var(--d-danger)_11%,var(--d-bg))] text-(--d-danger-text)',
  success: 'border-(--d-success)/28 bg-[color-mix(in_srgb,var(--d-success)_11%,var(--d-bg))] text-(--d-success-text)',
  info: 'border-(--d-info)/28 bg-[color-mix(in_srgb,var(--d-info)_11%,var(--d-bg))] text-(--d-info-text)',
} as const;
