/**
 * asset-names.ts: the one alphabet for slash-invocable asset names.
 *
 * A SEGMENT is a single on-disk basename: a command file stem or a skill directory name. Dots are
 * separators only, so `..`, `.hidden` and `foo..bar` are not segments. pi derives a prompt-template
 * name by stripping `.md` from the filename and matches `/name` exactly, so a dotted stem really is
 * invocable and the alphabet has to admit it.
 *
 * An INVOCABLE NAME is a segment, optionally prefixed by the segment of its immediate parent
 * directory (`namespace:name`). The command scanner descends exactly one level, so at most one colon.
 *
 * The scanner, the skill-description reader and the chat slash intercept all key on these, so a name
 * the scanner lists is always a name the intercept can see and refuse.
 */

const SEGMENT = "[a-zA-Z0-9_-]+(?:\\.[a-zA-Z0-9_-]+)*";
const INVOCABLE = `${SEGMENT}(?::${SEGMENT})?`;

/** One on-disk basename: a command file stem or a skill directory name. */
export const ASSET_SEGMENT_RE: RegExp = new RegExp(`^${SEGMENT}$`);

/** A name as the user types it after the slash, namespace included. */
export const INVOCABLE_ASSET_NAME_RE: RegExp = new RegExp(`^${INVOCABLE}$`);

/** A whole single-line slash invocation. Group 1 is the invocable name, group 2 the arguments. */
export const SLASH_INVOCATION_RE: RegExp = new RegExp(`^/(${INVOCABLE})(?:\\s+(.*))?$`);
