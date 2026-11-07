import { useI18n } from 'vue-i18n';

/**
 * `t` for a key built from a wire value (a status, a rule id): the value a newer core sends, which this build's catalog
 * lacks, shows `fallback` instead of a raw keypath.
 */
export function useTKnown(): (prefix: string, value: string, fallback: string) => string {
  const { t, te } = useI18n();
  return (prefix, value, fallback) => {
    const key = `${prefix}.${value}`;
    return te(key) ? t(key) : fallback;
  };
}
