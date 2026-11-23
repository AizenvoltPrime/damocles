// A status banner's border, fill and text per tone; the shell scans this file by name (src/desktop/shell/style.css @source).
export const BANNER_TONE = {
  warning: 'border-(--d-warning-fill)/25 bg-[color-mix(in_srgb,var(--d-warning-fill)_11%,var(--d-bg))] text-(--d-warning-text)',
  danger: 'border-(--d-danger-fill)/28 bg-[color-mix(in_srgb,var(--d-danger-fill)_11%,var(--d-bg))] text-(--d-danger-text)',
  success: 'border-(--d-success-fill)/28 bg-[color-mix(in_srgb,var(--d-success-fill)_11%,var(--d-bg))] text-(--d-success-text)',
  info: 'border-(--d-info-fill)/28 bg-[color-mix(in_srgb,var(--d-info-fill)_11%,var(--d-bg))] text-(--d-info-text)',
} as const;
