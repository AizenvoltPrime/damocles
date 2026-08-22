/**
 * Vue's props object always carries every declared key, holding `undefined` where the prop was not
 * passed (`LooseRequired`). reka-ui declares its props as genuinely optional (`as?: AsTag`), and
 * under `exactOptionalPropertyTypes` "present but undefined" is not "absent", so forwarding a props
 * object straight through with `v-bind="props"` never typechecks.
 *
 * Dropping the undefined-valued keys makes the forwarded object match the declaration. It also
 * matches what Vue does at runtime: a prop bound to `undefined` already falls back to the target's
 * default, so removing the key changes nothing about what renders.
 */
export function definedProps<T extends object>(props: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key in props) {
    const value = props[key];
    if (value !== undefined) out[key] = value;
  }
  // The loop cannot be expressed as the mapped return type, so the built object is asserted once here.
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
