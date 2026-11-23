// How core and main parse a file of the theme store, so both read the same bytes as the same value.

/**
 * The JSON a stored file's text holds; throws as JSON.parse does. A leading byte order mark is no part of the JSON (RFC 8259
 * section 8.1), so a reader reads past one and the file is never rewritten for it.
 */
export const parseStoredJson = (text: string): unknown => JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
