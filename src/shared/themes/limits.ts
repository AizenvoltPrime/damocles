// The ranges, caps and patterns the theme schema shares with the code that clamps, parses and imports. Imports nothing, so the
// schema, the schedule and the renderers all read one definition.

// A theme's style.
export const LINE_HEIGHT_RANGE = { min: 0.9, max: 1.4 } as const;
export const RADIUS_RANGE = { min: 0, max: 2 } as const;
export const DENSITY_RANGE = { min: 0.85, max: 1.15 } as const;
export const CHAT_COLUMN_RANGE = { min: 36, max: 80 } as const;

// A look's wallpapers.
export const DIM_RANGE = { min: 0, max: 0.9 } as const;
export const MAX_BLUR_PX = 24;
export const SURFACE_OPACITY_RANGE = { min: 0.6, max: 1 } as const;
export const MAX_WALLPAPER_SETS = 8;

// A theme's window arrangement, CSS px. Must match MAX_SHELL_COORDINATE and MIN_SECTION_SIZE in
// src/desktop/preload/shell-channels.ts.
export const MAX_ARRANGEMENT_COORDINATE = 100_000;
export const MIN_ARRANGEMENT_SECTION = 60;

// A moving wallpaper's caps, checked from its header before anything decodes it.
export const MAX_MOVING_BYTES: number = 40 * 1024 * 1024;
export const MAX_ANIMATION_FRAMES = 1000;
export const MAX_VIDEO_MS = 60_000;

// A theme names at most this many assets, and a theme file holds at most this many entries (MAX_ARCHIVE_ENTRIES).
export const MAX_THEME_ASSETS = 512;

// How many theme files a listing or a collection reads at once.
export const READ_CONCURRENCY = 8;

// The most code points a theme's name, a wallpaper set's, its character set's and each character's may hold.
export const MAX_THEME_NAME_CHARS = 64;
// The most a theme's other details may hold.
export const MAX_THEME_DESCRIPTION_CHARS = 1000;
export const MAX_THEME_AUTHOR_CHARS = 200;
export const MAX_THEME_VERSION_CHARS = 64;
export const MAX_THEME_LICENSE_CHARS = 64;

// The most frames a character's strip is cut into.
export const MAX_STRIP_FRAMES = 256;

// A user theme's lowercase UUID or a built-in's damocles-*.
export const THEME_ID: RegExp = /^[a-z0-9-]{1,64}$/;

// A user theme's id, which is also its folder under themes/: a lowercase UUID. A folder of any other name is no theme.
export const USER_THEME_ID: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The undo history's file under themes/. The oldest entries go first once it would pass MAX_HISTORY_BYTES; a theme.json is at
// most 4 MB.
export const HISTORY_FOLDER = 'history';
export const HISTORY_FILE = 'index.json';
// The version the history file states. A file stating another is a newer Damocles' and is read as holding no entries.
export const HISTORY_VERSION = 1;
export const MAX_HISTORY_BYTES: number = 32 * 1024 * 1024;
export const HISTORY_LIMIT = 50;
// appearance.json, projects.json and a draft, which holds one theme
export const MAX_STATE_FILE_BYTES: number = 8 * 1024 * 1024;

// The latest instant a stored file may name. The schedule scans nine days past an instant, so this must stay more than that
// below ECMA-262's time limit of 8.64e15 ms.
export const MAX_INSTANT_MS: number = Date.UTC(9999, 11, 31);

// A one-line name, as a JSON Schema pattern: no control character, line or paragraph separator, or bidi control. Must refuse
// exactly what oneLine (src/core/pi-session/untrusted-text.ts) removes, so a name an install flattened always passes.
export const ONE_LINE_NAME = '^[^\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]*$';
