# Desktop themes

A theme changes the colors, fonts, line spacing, corners, density, chat column width, wallpapers and project characters of the Damocles desktop app. This
page is the reference for theme authors: where themes live, the file format and its limits. The VS Code extension keeps VS
Code's own theme and reads no theme file.

## Where themes live

Each theme is a folder under `~/.damocles/themes/themes/`, named by the theme's id, holding `theme.json`:

```
~/.damocles/themes/
  themes/<id>/theme.json
  blobs/<sha256>          font files, wallpapers and character sprites a theme bundles, named by their SHA-256
  cache/<sha256>/         what Damocles derived from a wallpaper: thumb-480.webp, stats.json, palette.json, and for a
                          moving one still.png and flash.json; from a sprite, flash.json and a still.png
  history/index.json      the last 50 theme changes, which Undo and History read
  drafts/<id>.json        themes the agent has drafted in a chat and not applied yet
  store/                  the community store's signed list (list.json) and its thumbnails (thumbs/<sha256>)
  appearance.json         the schedule, a pick that holds over it, and the countdown a keep-changes banner is counting
  projects.json           this computer's character pins and project looks, by project
  .lock                   held while a Damocles writes to this folder
  .countdown-<app>/       held by a Damocles app while its keep-changes banner counts, so another running Damocles
                          never reverts the change being counted
```

Damocles also ships read-only example themes: Aurora (`damocles-aurora`, a night look and a dawn look with one image of
northern lights across the window), Paper (`damocles-paper`, a warm light look with square corners, density 0.9 and a
40rem chat column) and Arcade (`damocles-arcade`, a neon dark look with six pixel characters for your projects). Duplicate
one to edit a copy.

Damocles writes these files itself (Settings › Appearance: Duplicate, the color editor, Rename and Delete) and reads every
file again before it uses it. You may write a theme folder by hand: Damocles picks it up within a moment. The folder's
name must be the theme's `id`, a lowercase UUID; Damocles leaves a folder of any other name (a copy, a backup) as it is
and does not list it. A file it cannot read or that breaks a rule below is listed as broken in Settings with the reason,
is never applied and is never rewritten. A file may start with a byte order mark, as some editors write one: Damocles
reads past it and leaves the file as it is. `appearance.json` and `projects.json` are Damocles' own state: one that is not
readable JSON is copied to `appearance.json.bad` or `projects.json.bad` by the next change and started again, and one
written by a newer Damocles is left as it is, with the change that needed it saying so. The same holds for the undo
history (`history/index.json`): while a newer Damocles' history is there, this one lists no history and makes no theme
change, Undo or Restore, each saying so.

Settings › Appearance picks one theme for the dark look and one for the light look (`damocles.desktop.themes.dark` and
`damocles.desktop.themes.light`, default `damocles`, the built-in theme); the Mode row (`damocles.desktop.theme`: System,
Dark or Light) decides which of the two shows. A picked theme that is missing, broken or has no look of that kind shows the
Damocles look instead, and Settings names it. Reset Theme to Default (View menu, the command palette, or
Ctrl+Alt+Shift+0, Cmd+Alt+Shift+0 on macOS) sets both back to Damocles. Under a Windows contrast theme the built-in look
always shows.

## The file

`theme.json` is JSON. `schemas/theme.schema.json` in the Damocles repository is its JSON Schema, for editors; the rules
the schema cannot state are listed after it.

```json
{
  "schemaVersion": 1,
  "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "name": "Midnight",
  "looks": {
    "dark": {
      "colors": {
        "background": "#1a1033",
        "panel": "#22163f",
        "text": "#f0e8ff",
        "accent": "#ff7ad9",
        "success": "#5be3a0",
        "warning": "#ffc857",
        "danger": "#ff6b6b",
        "info": "#8fb8ff"
      }
    }
  }
}
```

| Field | Rule |
| --- | --- |
| `schemaVersion` | `1`. A file with a higher number is listed "Needs a newer Damocles" and not applied. |
| `id` | A lowercase UUID, equal to the folder name. `damocles` and `damocles-*` are reserved for built-in themes. |
| `name` | 1 to 64 characters, not only spaces, on one line: no control character, no line or paragraph separator and no text direction control (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069). The zero-width joiner and non-joiner are allowed. A wallpaper set's name, a character set's name and a character's name follow the same one-line rule. |
| `description`, `author`, `version` | Optional text (1000, 200 and 64 characters at most). |
| `license` | Optional SPDX id, or `LicenseRef-...`. |
| `looks` | A `dark` look, a `light` look, or both; at least one. |
| `looks.<kind>.colors` | The 8 main colors, each an opaque `#rrggbb`: `background`, `panel`, `text`, `accent`, `success`, `warning`, `danger`, `info`. |
| `looks.<kind>.tokens` | Optional overrides of single design tokens (`--d-*`, `--s-*`, `--d-ansi-0` to `--d-ansi-15`), each `#rrggbb` or `#rrggbbaa` (`--d-shadow` takes two to four lengths, each `0` or a px value, and then a hex color, as in `0 18px 48px #00000080`; no `inset`). Fonts, sizes, the style scales and the host safety tokens cannot be overridden. |
| `looks.<kind>.wallpapers`, `looks.<kind>.cycle`, `looks.<kind>.surfaceOpacity` | Optional; see Wallpapers below. |
| `style` | Optional; see Style below. |
| `css` | Optional custom CSS per region (`transcript`, `sidebar`, `editorChrome`, `terminalChrome`, `titlebar`); see Custom CSS below. |
| `characters` | Optional set of project characters; see Characters below. |
| `assets` | The files a theme bundles, at most 512, keyed by their SHA-256 (any other key is refused): `kind` (`font`, `image`, `animated`, `video` or `sprite`), `mime`, `bytes`, `family` (a font), `width` and `height` (a wallpaper or sprite), `frames` (an animated image, or a sprite strip's frames), `durationMs` (a video, or one loop of a sprite strip), `flash` (a moving wallpaper's or sprite's flash check, below) and `license` (`spdx`, `text`, `author`, `source`). Every bundled font the style names, every wallpaper a set names and every sprite a character names must be listed here. |

A theme never sets the size of text: any key holding `size` in its name, at the top level, in `style` or in `style.fonts`,
is refused. Text size is the user's own setting (`damocles.desktop.textSize`, Settings › Appearance › Text size, 11 to 20 px).

Keys the format does not know are ignored, and kept in the file when Damocles saves it. `layout` is the window arrangement
(the grid's `slots`, `visible` panes and sizes, `sidebarWidth`, `sectionOrder` and `sections`). `sectionOrder` names every
sidebar section once (`projects`, `chats`, `files`, `scm`, `graph`, `repos`, `search`); an order of the other six without
`graph`, as Damocles 3.9.0 saved it, is read with the Graph after Source control, and any other order is refused. The
arrangement applies only when you pick
the theme yourself in Settings, clamped to the window, never on a schedule or a project switch, and the theme editor saves
one only while Save a window arrangement with this theme is on: the one the theme had, or the window's once you choose
Capture the current window arrangement. The schema also describes `origin`, which only Damocles writes;
this version paints the colors, the style, the wallpapers, the custom CSS and the characters of the shown look.

## Style

```json
"style": {
  "fonts": { "ui": { "installed": "Georgia" }, "mono": { "asset": "<sha256>", "family": "Iosevka" } },
  "lineHeight": 1.1,
  "radius": 0.6,
  "density": 0.9,
  "chatColumn": 40
}
```

| Field | Rule |
| --- | --- |
| `fonts.ui`, `fonts.mono` | The UI and the code font: `{ "installed": "<name>" }`, a font installed on the computer, or `{ "asset": "<sha256>", "family": "<name>" }`, a font file the theme bundles. A name is 1 to 64 letters, digits, spaces and `. _ ' & -`. An installed name may not be one of Damocles' own families (`Geist Variable`, `Geist Mono Variable`, `Inter Variable`) or start with `dt-`. Damocles' own fonts follow yours, for the characters yours lack. |
| `lineHeight` | Line spacing, 0.9 to 1.4 times Damocles' (1). |
| `radius` | Corner radius, 0 (square) to 2 times Damocles' (1). |
| `density` | Spacing, 0.85 to 1.15 times Damocles' (1): padding, gaps and the sizes of controls and icons; text does not change. Below 1 every button, tab, menu item and option keeps at least a 1.5rem target, except the small buttons inside fixed-height list rows (a job log's fold arrow, a search result's replace and dismiss), which keep their usual size; each has a menu item that does the same. |
| `chatColumn` | The widest the chat's messages and composer grow: 36 to 80 (rem), or `"full"` for the chat pane's whole width. Default 50. |

Menus, dialogs, Settings, the theme editor and the chat's approval cards take your corners, density, line spacing and chat
column, but always Damocles' own fonts, so a theme's font can never disguise them.

## Fonts

A bundled font is a WOFF2, WOFF, TrueType or OpenType file of at most 10 MB, one face per file (a font collection, `.ttc`,
is refused), and a theme bundles at most 8. Damocles stores the file once under `blobs/<sha256>` and renames its family
`dt-<first 8 hex of the sha256>-<family>`, so a theme's font never replaces Damocles' own fonts or another theme's. It is
served to the window only while an installed theme (or the theme editor's draft) names it.

In the theme editor's Type section, Add a font file… reads a file you pick; an installed font is listed by name and
Bundle with the theme copies its file into the theme. A bundled font leaves the theme once neither the UI font nor the
mono font is that font. Damocles reads the font's OS/2 embedding rights (`fsType`) and its
names (family, style, full name, PostScript name, license and license URL): a font whose rights restrict embedding is
refused (pick it as an installed font instead), and the license it declares is kept in `assets`. A font with an unknown
license is bundled with a note that sharing it is your responsibility. Unused font files are removed a day after no theme or
undo history entry names them.

## Wallpapers

A look shows images behind the window's panels: the title bar, the sidebar, the chat, the editor and the terminal. Each
panel has its own image, or one image spans the panels you choose and lines up across them as one picture; a panel's own
image wins over a spanning one.

```json
"wallpapers": [
  {
    "name": "Night",
    "span": { "asset": "<sha256>", "panels": ["titlebar", "sidebar", "chat", "editor", "terminal"], "fit": "fill" },
    "spanLook": { "chat": { "dim": 0.6, "blur": 2 } },
    "panels": { "sidebar": { "asset": "<sha256>", "fit": "tile", "dim": 0.4, "blur": 0 } }
  }
],
"cycle": { "minutes": 15 },
"surfaceOpacity": 0.9
```

| Field | Rule |
| --- | --- |
| `wallpapers` | Up to 8 sets; the window shows one at a time, from the first. A set's optional `name` is at most 64 characters on one line, as a theme's name is. |
| `cycle` | How the window moves through the sets: `{ "minutes": n }` (1 to 1440) moves on every n minutes; `{ "minutes": null }`, or no `cycle`, moves on only with Next Wallpaper (View menu, the command palette, or Ctrl+Alt+Shift+., Cmd+Alt+Shift+. on macOS). The set each look shows is kept on this computer (`theme-state.json` in Damocles' user data folder), so a relaunch shows the same one. |
| `span` | One image (`asset`) across `panels`, each at most once, laid out with `fit`. `spanLook` gives each spanned panel its `dim` and `blur` (default 0.55 and 4). |
| `panels.<panel>` | A panel's own image: `asset`, `fit`, `dim` and `blur`. |
| `fit` | `fill` covers the panel (or the spanned panels' box), `fit` shows the whole image, `center` keeps its size, `tile` repeats it from the corner. |
| `dim` | 0 to 0.9: an overlay in the panel's own color over the image. |
| `blur` | 0 to 24 px; a moving wallpaper shows at most 8 px, since blurring every frame costs battery. |
| `surfaceOpacity` | 0.6 to 1 (default 1): how opaque bubbles, the composer, code blocks, quotes, tables and tool cards are over a wallpaper. It is their background's alpha, never an `opacity`. Only the block that touches the wallpaper lets it through: a pane inside one (a tool card's diff or live output) stays opaque, so each block shows exactly the opacity you set. Cards that ask for your answer stay at 0.92 or more, and the title bar's host chip and window controls keep an opaque backdrop of the panel color over its image. |

A still wallpaper is a PNG, JPEG, WebP or AVIF image of at most 20 MB, 8192 pixels on a side and 40 megapixels. A moving
wallpaper is a GIF, an animated WebP or an animated PNG of at most 1000 frames, or a muted, looping MP4 (H.264 `avc1` or
AV1 `av01`) or WebM (VP8 `vp08`, VP9 `vp09` or AV1) of at most 60 seconds and 3840 x 2160; either is at most 40 MB. Damocles
reads the size, the frame count, the codec and the duration from the file's header (an MP4's boxes, its `moov` at the start
or the end; a WebM's EBML elements) and refuses a file past a limit before anything decodes it; an AVIF image sequence is
refused, and so are a GIF with a frame that reaches outside its image and an animated PNG or WebP that holds no frame. The
bytes decide the type: a file named `.png` that holds a JPEG is refused. Damocles then decodes the file once in a sandboxed
page, refuses it when the decoded size is not the one its header declared or a video's frames run longer than its header
declared or the 60 seconds allow, and keeps a 480 px thumbnail (for the
gallery's miniatures), the 10th and 90th percentiles of its luminance (for readability, below; five frames of a moving one;
fully transparent pixels are left out, since they show the panel's own color, and partly transparent ones count by their
color)
and a palette proposed from it under `cache/<sha256>/`, with a moving one's first frame (`still.png`) and its flash check
(`flash.json`).

A moving wallpaper plays once however many panels it spans, and shows its first frame instead while the window is in the
background, covered or minimized, while the computer runs on battery or under Windows battery saver, with Reduce motion (the
Settings switch or the operating system's), under a Windows contrast theme and while wallpapers are off.

Flashing: every frame of a moving wallpaper is checked against WCAG 2.3.1 when it is added, whatever its frame rate, over its
whole length and on into its loop. Damocles decodes the frames itself, one by one, and plays nothing, so a slow computer
checks the same frames as a fast one, only later. A video is read from the frames its file lists: if one of them cannot be
decoded, comes out of order or is missing, the file is refused instead of being checked in part, and so is a video that
holds a second video track or more than 14,400 frames (60 seconds at 240 frames a second). The area is WCAG's: a quarter of a 10 degree visual field, which WCAG gives as a 341 x 256 pixel rectangle anywhere on
a 1024 x 768 screen. A wallpaper fills the window, so the field is a square a third of the picture across, placed anywhere
in it: a file that flashes more than three times in any second over a quarter or more of any such square, in general flashes
or in saturated red, is blocked. That is far less than a quarter of the whole picture: a flashing strip a tenth of the
picture high is enough. A transparent part of a frame is measured over a black backdrop and over a white one, since it
shows what is under the wallpaper, and must pass over both. A check made by an earlier Damocles under another area rule
does not count: the file shows its still frame until Damocles has checked it again, which it does when it next starts, and
an allowance you gave it stays. For a blocked file the window shows its still frame, and the theme editor's Wallpapers section says "Blocked: flashes"
with the time the first failing second starts, a seizure warning and Allow flashing for this file. That allowance is yours, on
this computer only: it is kept beside the file's flash check, never in `theme.json`, so a shared theme, an archive or the
agent can never carry or give it (a `flash.allowed` key in a theme file is ignored and dropped). Reduce motion still pauses an
allowed file.

Text stays readable over a wallpaper. Settings › Appearance › Text over wallpapers (`damocles.desktop.themes.wallpaperContrast`,
yours alone) decides how: Raise dim (the default) dims an image further, in the window only, until muted text reaches 4.5:1
over its darkest and lightest tenths; Warn only keeps your dim and the theme editor's Wallpapers section says where text falls
short. Show wallpapers (`damocles.desktop.themes.showWallpapers`) and Toggle Wallpapers (View menu, the command palette, or
Ctrl+Alt+Shift+W, Cmd+Alt+Shift+W on macOS) turn them off and on; the agent may propose turning them off, through its card or
the keep-changes banner like any change, never on. Wallpapers stay off
under a Windows contrast theme, without GPU compositing and in safe start, and with the operating system's reduced
transparency every surface stays opaque over them. Settings, menus, dialogs and the theme editor never show a wallpaper.

In the theme editor's Wallpapers section, choose None, One image per panel or One image across panels; the panel map picks
the panel to edit, or the panels an image spans; Choose image or video… reads a file you pick, and shows how far its flash
check is while a moving one is checked. Wallpaper sets lists the look's sets: add, rename, reorder and remove them, and pick
the one to edit, which the window shows while you edit; Cycle chooses a timer or Next Wallpaper only. Palette from wallpaper
proposes the 8 colors of the look from the image, which you apply or keep yours.

## Characters

A theme's character set replaces each project's letter with a small character in the sidebar, the title bar's breadcrumb,
the notifications and Quick Open. The character moves with the project's state: `waiting` while one of its chats waits on
you, else `running` while one runs, else `idle`; the running and waiting badges stay. A character whose image does not load
shows the project's letter until the theme names another image.

```json
"characters": {
  "name": "Arcade",
  "characters": [
    {
      "name": "Pip",
      "states": {
        "idle": { "strip": { "asset": "<sha256>", "frameWidth": 10, "frameHeight": 10, "frames": 2, "fps": 2 } },
        "running": { "strip": { "asset": "<sha256>", "frameWidth": 10, "frameHeight": 10, "frames": 4, "fps": 6 } },
        "waiting": { "asset": "<sha256>" }
      }
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `name` | The set's name, 1 to 64 characters, not only spaces, on one line as a theme's name is. |
| `characters[].name` | 1 to 64 characters, not only spaces, on one line, unique in the set: a pin names a character by it. |
| `characters[].alt` | Optional, at most 200 characters. |
| `characters[].states.idle` | Required. `running` and `waiting` are optional; a state a character lacks shows its idle image. |
| a state | `{ "asset": "<sha256>" }`, one image, or `{ "strip": { "asset", "frameWidth", "frameHeight", "frames", "fps" } }`, the frames side by side in one image, stepped `fps` times a second (1 to 60). A strip's image is exactly `frames` × `frameWidth` wide and `frameHeight` high, and steps no faster than the rate its flash check ran at (its asset's `durationMs` is one loop at that rate). A strip's image is one still sprite: an animated image is refused under a strip, of one frame too, and every strip that names an image cuts it into the `frames` its asset states. |

A sprite is an asset of kind `sprite`: a PNG, GIF, WebP (animated ones included) or SVG of at most 256 KB, at most 256
pixels a side for each frame, and at most 1,048,576 pixels for a strip's whole image. Damocles reads its type and size from
its header before anything decodes it, and refuses a file past a cap. An SVG is shown only as an image (never inline), and
must be a plain still drawing: UTF-8 XML whose root is `svg`, holding only the elements `svg`, `g`, `defs`, `symbol`, `use`,
`title`, `desc`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `linearGradient`,
`radialGradient`, `stop`, `pattern`, `clipPath` and `mask`, under any namespace prefix. Any other element is refused (a
script, a style, an image, an animation, a filter, an editor's `metadata`), and so are a DOCTYPE, a processing instruction,
an event handler, an `href` or a `url()` that leaves the file, an `animation` in a `style` attribute, and a character
reference (`&#...;`) or a backslash in any attribute. Every character image is drawn with square pixels
(`image-rendering: pixelated`).

Every sprite is checked for flashing when you add it, as moving wallpapers are: each frame of an animated image, and each
frame of a strip at its own rate. A sprite that flashes more than three times a second over a quarter of its picture or
more (it is drawn far smaller than WCAG's 10 degree field, so the whole sprite is the field) is blocked, held on its first frame
with "Blocked: flashes" and a seizure warning in the theme editor, until you choose Allow flashing for this file, which
stays on this computer. A strip of 6 frames a second or fewer cannot flash more than three times a second and moves without
a check. An animated image or an SVG also gets its first frame drawn as `still.png`.

Each project gets one character of the shown theme's set by a hash of its project key, so it keeps the same one across
restarts. The theme editor's Characters section pins one per project for that theme, or keeps it in every theme ("Keep in
every theme"): that character then shows in every theme without a pin of its own, the built-in look included, and stays
after the theme it came from is deleted. Pins are this computer's (`~/.damocles/themes/projects.json`), written only by
Damocles, never part of a theme file or an export.

Characters move as Settings › Appearance › Character motion says (`damocles.desktop.themes.characterMotion`): Always (the
default), On hover (only while the pointer is over the character or its row) or Selected project. Reduce motion, the
operating system's reduced motion and a Windows contrast theme hold every character on its first frame. In safe start no
character shows.

The theme editor's Characters section picks the set (None, the theme's own, or a copy of another theme's), shows each
character in idle, running and waiting, adds a character from an image (Frames in the image cuts a strip; 1 is a still
image), replaces a state's image, removes a character, and edits the pins; pins are saved with the theme. A pick of another set,
or of None, in place of the theme's own can be undone there until the set is edited again. The agent's
ThemeSet sets `characters` from sprites it draws as pixel grids (`asset.from.pixels`: up to 32 x 32 pixels, 16 colors and
12 frames), which Damocles turns into a sprite-strip SVG with crisp edges.

## How the colors are used

Damocles derives every other color from the 8 main colors: card, hover, border, input and code surfaces step from `panel`;
text, muted and faint text are moved until they reach WCAG AA (4.5:1) on every surface; each tone's text shade keeps its hue
and moves in lightness until it reaches 4.5:1; syntax and terminal colors, and the design hue, take the built-in hues of the
look's kind. Your tone colors are used as given for fills, borders and rings; Settings warns when one is below 3:1 on the
background or panel. Text on a fill is white or a near-black, whichever contrasts more; when neither reaches 4.5:1, the fill
moves in lightness, hue and chroma kept, to the nearest value where one does. The switch knob is the accent's text on the
switch's faint off track: when faint text cannot both reach 4.5:1 and stay 3:1 from that knob, the knob takes the other
label, and the accent fill moves the same way when that label is below 4.5:1 on it. The theme editor shows "Shown as #... in text" or "Shown as #... in fills"
beside a color the derivation moved. Token overrides apply last and are not adjusted.

The color editor lists every contrast rule a look fails, such as "Text on Panel 3.8:1, needs 4.5:1". While a text rule
fails, menus, dialogs, Settings and the chat's approval cards keep the Damocles colors of the look's kind, so they stay
readable; the rest of the window shows your colors. A remote host's color stripe, chip and badges always use Damocles' own
colors.

## Custom CSS

```json
"css": {
  "transcript": "[data-tool-card][data-tool-status=\"error\"] { border-color: var(--d-danger-fill); }",
  "sidebar": "[role=\"option\"][aria-selected=\"true\"] { font-weight: 600; }"
}
```

A theme's CSS restyles five content areas, one region each. Everything else (Settings, menus, dialogs, the notifier, the
theme editor, the banners under the title bar, and every chat card that asks for your answer) is trusted UI and never takes
theme CSS. Neither do the code editor (Monaco) and the terminal's screen (xterm).

| Region | What it reaches |
| --- | --- |
| `transcript` | Each block of the chat transcript on its own: a message bubble, a block of the reply, each tool card, the notices, the empty chat's welcome. The plan card is trusted UI and takes none, and neither do the agent, team agent and tool dialogs, which show an agent's messages and tool cards outside the transcript. |
| `sidebar` | The body of each sidebar section (Projects, Chats, Files, Search, Repositories, Source Control, Graph), not the section headers. |
| `editorChrome` | The editor's tab strip and its breadcrumbs. |
| `terminalChrome` | The terminal list beside the terminals. |
| `titlebar` | The title bar's Damocles button and its project and chat breadcrumb. Its host chip and window controls are trusted UI. |

Each region's CSS applies to what is inside each element of that region, on its own (`@scope`), never to the element itself.
It stops at trusted UI and at safety marks inside it (host badges, the Untrusted badge, a host group's icon and color dot),
which always paint above the content around them, and it cannot reach outside the element: the element clips what it
paints, so nothing a theme draws can cover another part of the window. A tool card and a message bubble are inside their
region's element, so a theme styles their own background, border and corners. Rules sit in the last CSS layer, so they
win over Damocles' utility classes; the few app rules outside a layer win unless the theme's rule is `!important`, which is
kept.

### Hooks

Tool cards in the transcript carry attributes a theme may select on, which keep their names and values across versions.
`data-tool-status` may gain values in a later version, so style the card itself first and a status on top of it, and never
treat the values below as the only ones:

| Attribute | Values |
| --- | --- |
| `data-tool-card` | On every tool card. |
| `data-tool` | The tool's own name: `Bash`, `Read`, `Edit`, `Agent`, `ThemeSet`, an MCP tool's full name, and so on. |
| `data-tool-status` | `running` (started or about to), `done`, `error` (failed or denied), `stopped` (cancelled, never ran, or its outcome was not recorded) or `blocked` (waiting for your answer, or blocked by a rule). An agent or team card has the status of its agent or its run, not of the call that started it: a background agent's card is `running` until the agent ends, and a team's is `blocked` while a member waits for your answer. |
| `data-part` | `header` (the card's top row), `tile` (the icon tile in it), `summary` (the call's one-line argument in it) and `body` (what the card shows below its header; a card with nothing there has none, and a folded detail still counts). Agent and team cards have `header` and `tile`. |

### Limits and rules

The theme editor's CSS section and the agent's ThemeSet run every region through one sanitizer, and Damocles runs it again
before it paints. What it removes is listed with its reason ("Removed when saved" in the editor, the dropped CSS on the
agent's card) and never saved; the list holds the first 100 parts, and the editor says how many more there are. A theme
whose stored CSS would lose anything when painted is listed broken. What a page paints is written out again from what was
checked, each name in its plain spelling (`\63 olor` becomes `color`), never your source text; a region whose written
form would not read back as what was checked is removed whole.

- Size: 32 KB per region, 64 KB in all regions, counted on what is kept, 400 rules, 512 characters per selector. A region
  over its size is removed whole. Nested rules are removed, and so is a region that nests blocks, functions, parentheses
  and brackets more than 32 deep. A comment after a removed part stays; one inside it goes with it.
- At-rules: `@media`, `@supports` and `@container` only. A media query may test only `prefers-reduced-motion`,
  `prefers-contrast`, `forced-colors`, `hover` and `pointer`. A condition that holds a `url()` is removed with its block.
  `@import`, `@font-face`, `@layer`, `@scope`, `@keyframes`, `@property` and every other at-rule are removed.
- Selectors: a selector naming `:root`, `html`, `body`, `:host`, `:host-context()`, `::part`, `::slotted`, `:scope`, `&`,
  `:has()`, `[data-theme-scope]`, `[data-trusted]`, any `[class]` attribute, or a class starting with `monaco`, `mtk`,
  `view-line` or `xterm` is removed, and so is a selector that starts with a combinator (`> p`, `~ p`). Pseudo-elements: only
  `::selection`, `::placeholder` and `::marker`; `::before`, `::after` and their one-colon forms are removed. A selector
  the browser would refuse its whole rule for is removed too: a namespace prefix other than `*|` (`svg|a`), a type name
  that is not first in its compound, a doubled or trailing combinator, attribute flags other than `i` and `s`, a
  pseudo-class that is not in the list below, and anything written after a pseudo-element (`p::selection:hover`) or a
  pseudo-element inside `:is()`, `:where()` or `:not()`. Every kept selector matches only inside a region's element, never
  the element itself, so a theme cannot change the element's own margin, padding, border or shadow.
- Pseudo-classes: `:active`, `:any-link`, `:autofill`, `:checked`, `:default`, `:defined`, `:disabled`, `:empty`,
  `:enabled`, `:first-child`, `:first-of-type`, `:focus`, `:focus-visible`, `:focus-within`, `:fullscreen`, `:hover`,
  `:in-range`, `:indeterminate`, `:invalid`, `:last-child`, `:last-of-type`, `:link`, `:modal`, `:only-child`,
  `:only-of-type`, `:open`, `:optional`, `:out-of-range`, `:picture-in-picture`, `:placeholder-shown`, `:popover-open`,
  `:read-only`, `:read-write`, `:required`, `:target`, `:user-invalid`, `:user-valid`, `:valid` and `:visited`; `:is()`,
  `:where()` and `:not()` with at least one selector; `:nth-child()` and `:nth-last-child()`, also with `of` and a
  selector list; `:nth-of-type()` and `:nth-last-of-type()`; `:dir()` and `:lang()` with one name (`:lang(en)`, not
  `:lang("en")` or `:lang(en, fr)`). Any other pseudo-class is removed with its selector: the browser would ignore the
  whole rule for it.
- Images: `url()` only for a `data:` URL of a still image up to 16 KB; nothing loads from the network. The image is a PNG,
  JPEG, GIF or WebP, read from its bytes whatever type the URL declares, or an SVG declared `image/svg+xml` that keeps the
  rules of a character's SVG (see Characters: plain shapes, no animation, style, script or link). An animated GIF, an
  animated WebP and an animated PNG are removed: an image in CSS has no flash check and reduce motion cannot pause it. The
  URL may carry `;charset=utf-8` and `;base64` and nothing else, and no `#` (write `%23` in an SVG's colors).
- Values: functions are limited to colors, gradients, easing and `var()`: `calc()` and the other math functions,
  `image-set()`, `cross-fade()`, `element()`, `paint()`, `attr()` and `env()` are removed, and so are a declaration with no
  value and any custom property (`--name: ...`). `var()` takes only a color token (a `--d-*` or `--s-*` token whose value is
  a color, so not `--d-chat-column`, `--d-font-size` or `--d-shadow`), with no fallback, or `--d-font` and `--d-mono` in
  `font-family`. A text `color` needs at least 40% opacity, or an opaque color token. Lengths count 1em and 1rem as 16px;
  viewport and container units and percentages are removed, except in a corner radius and in backgrounds, gradients and
  color functions. A shadow or a background takes at most 8 comma-separated layers.

### Allowed properties

| Properties | Values |
| --- | --- |
| `color` | A color of at least 40% opacity, or an opaque color token. |
| `background` and its longhands (`-color`, `-image`, `-position`, `-size`, `-repeat`, `-origin`, `-clip`, `-attachment`, `-blend-mode`) | Colors, gradients, still `data:` images; at most 8 layers. |
| `border`, `border-<side>`, their `-width`, `-style` and `-color`, `border-collapse`, `border-spacing` | Widths up to 4px. |
| `border-radius` and its corners | Up to 2rem or 50%. |
| `outline`, `outline-width`, `-style`, `-color`, `-offset` | Widths and offsets up to 4px. |
| `box-shadow`, `text-shadow` | Offsets and blur up to 1.5rem; at most 8 shadows. |
| `padding`, `margin` and their sides | 0 to 4rem; margins may be `auto`. |
| `gap`, `row-gap`, `column-gap` | 0 to 4rem. |
| `font-weight`, `font-style`, `font-variant` and its longhands, `font-feature-settings` | Weights 1 to 1000; oblique within 90deg; feature tags with `on`, `off` or a whole number. |
| `font-family` | `var(--d-font)`, `var(--d-mono)`, a family the theme's style declares, or a generic family. |
| `letter-spacing` | Within 0.2em either way. |
| `line-height` | A number from 1 to 2.5, or `normal`. |
| `text-decoration` and its longhands, `text-transform`, `text-align`, `list-style-type` | Decoration thickness up to 4px. |
| `cursor` | Any cursor but `none`. |
| `caret-color`, `accent-color`, `scrollbar-color`, `scrollbar-width` | Colors; `auto`, `thin` or `none`. |
| `transition` | Each item names one color property (never `all`, never none at all), up to 300 ms; or `none`, `initial` or `unset`. The longhands (`transition-property`, `-duration`, `-delay`, `-timing-function`) are removed: a duration alone would transition every property. |

Every other property is removed: among them `display`, `visibility`, `position`, `inset`, `z-index`, `transform`,
`translate`, `scale`, `rotate`, `opacity`, `filter`, `backdrop-filter`, `mask`, `clip-path`, `overflow`, `width`, `height` and their
`min-` and `max-` forms, `font-size`, `font`, `zoom`, `pointer-events`, `user-select`, `animation`, `content` and
`content-visibility`.

### What may change between versions

The regions, the hook attributes above and the `--d-*` tokens are kept across versions. Everything else is the app's own
markup: element names, Tailwind classes, ARIA roles, the order and nesting of elements inside a region, and which component
draws what. A theme that selects on them may stop matching after an update; the window stays usable, because the theme
cannot reach trusted UI. A later version may also allow more, or narrow what it allows when a property turns out to reach
outside its region; a part a newer sanitizer removes is listed as removed the next time the theme is edited or painted.

### Safety

A trusted card's buttons act only while Chromium reports the card fully visible, not covered and not faded or distorted
(IntersectionObserver v2); until then the card ignores clicks and keys, and says that it must be fully visible and to
scroll it into view or move what covers it.
A card that has just appeared, or has just replaced the one you answered, ignores them for half a second as well.
Inside a content area a theme can still make text hard to read; the theme's preview card, the keep-changes banner, Undo
theme change, Reset Theme to Default and safe start bring a readable window back. Under a Windows contrast theme and in
safe start no custom CSS is painted.

## Sharing

### The theme file

A `.damocles-theme` file is a zip holding exactly these entries and nothing else:

- `theme.json`: the theme, in the format above.
- `assets/<sha256>.<ext>`: each image, video, sprite or font the theme names, under the SHA-256 of its bytes. The extension
  is one of `png`, `apng`, `jpg`, `jpeg`, `webp`, `avif`, `gif`, `mp4`, `m4v`, `webm`, `svg`, `woff2`, `woff`, `ttf`, `otf` and
  must match what the bytes are.
- `LICENSES/<name>.txt`: license texts, UTF-8, at most 256 KB each (an exported installed font's license, a built-in
  example's license as `theme.txt`).

Zip the files only. A folder entry (`assets/`, `LICENSES/`), a macOS `__MACOSX/` entry, a symbolic link or any other name
makes Damocles refuse the whole file. Damocles reads it with these limits, checked as it unpacks, never from the sizes the
zip claims:

| Limit | Value |
| --- | --- |
| File size | 100 MB |
| Unpacked total | 256 MB |
| Entries | 512 |
| Unpacked size of one entry | 100 times its packed size |
| `theme.json` | 4 MB |
| One asset | 40 MB, and its kind's own caps (Wallpapers, Characters, Fonts) |
| An entry's name | 1024 bytes |

Names are refused when they hold `..`, `.`, a leading `/`, a drive letter, a backslash, a NUL, a space or anything outside
printable ASCII, and when two differ only in case. Each entry's bytes must match the checksum (CRC-32) the zip records for it. Each asset's SHA-256 must match its name and its bytes must pass the same
header checks as a file picked in the theme editor. ZIP64, encrypted entries and compression other than stored or deflate are
refused. A name inside the file never reaches the disk: assets are stored by their hash.

### Installing

Settings › Appearance › Import, Install from link, a `damocles://theme/install?url=<https URL>` link (the URL
percent-encoded, as `encodeURIComponent` writes it; an unencoded `+` reads as a space, and such a link is refused) and the agent's
ThemeSet `install` all end at the same install card, which lists what the file holds: its looks and contrast, fonts with
their licenses, wallpapers with their flash check (its progress while it runs, then clear or flagged; a flagged file shows
the seizure warning and Allow flashing for this file), custom CSS with what the sanitizer would drop,
characters, and a window arrangement with "Use this theme's window arrangement", off by default. Nothing is installed before
Install. A card left unanswered for an hour closes, since Damocles drops the file it read: Settings says so, a chat's
ThemeSet ends as expired, and starting the install again reads the file again. The install:

- always gives the theme a new id; the file's id and `origin` are ignored, and Damocles writes the origin itself (`import` for
  a file, `vscode` for a VS Code theme, `link` for a download);
- never reads a flash allowance from the file: a flagged wallpaper or sprite arrives blocked, and only you allow it on this
  computer, on the install card's Allow flashing for this file or later in the theme editor, never the file or the agent;
- stores the theme under its name flattened to one line, without control or bidi characters, as the card showed it, and
  flattens the names of its wallpaper sets, its character set and its characters the same way;
- on a name clash offers Keep both (installs as "Name 2", the next free number) or Replace (keeps the replaced theme's id, so
  your settings, schedule rules and project looks naming it still hold; if you changed that theme, your version is kept as a
  copy under the Keep both name);
- is one entry of the theme history, which Undo reverses.

A link or URL is downloaded only over https. Redirects are followed only to https on the same host as the link, each hop
through the same guard against private and local addresses as WebFetch; a redirect to another host is refused and named, so
the host on the card is where the file came from. The download stops past 100 MB, after 30 seconds without data, or after 10
minutes in all. The agent's ThemeSet `install` follows the chat's WebFetch rules and runs only while Web search is on. In a chat
on a remote host the computer the message came from downloads and installs the file, only while its own Web search is on too,
and another computer showing the chat sees the card name that computer, with Cancel only. That computer installs only after
you press Install on its own card, with the choices you made there; the remote host can ask, but it cannot answer for you.

### Fonts and licenses

Export packs every bundled font, and every installed font the theme names whose file the app can read, as a bundled font.
Damocles reads each font's OS/2 embedding rights and its license and license URL (name IDs 13 and 14):

- Restricted License embedding (`fsType` bit 1 with no less restrictive bit) is refused: the theme is not exported with it.
- The SIL Open Font License, the Apache License and the Ubuntu Font Licence pack after one confirm.
- Any other license, or none, packs after a warning that sharing the font is your responsibility.

An installed font larger than 10 MB, or one the app could not read, is exported by name only, and shows only on a computer that
has it installed.

### Exporting

The card's More menu › Export writes one `.damocles-theme` file, built-in themes included. The file name is the theme name
without the characters Windows refuses (`< > : " / \ | ? *`, control and bidi characters), trailing dots and spaces, and device
names Windows reserves (`CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM1` to `COM9`, `LPT1` to `LPT9`), or `theme` when
nothing is left. The export never holds the theme's origin, your flash allowances, per-project looks, character pins or the
theme history, and Damocles reads the file back as an import would, with every check of one, before it writes it.

### Importing VS Code themes

Import also takes a VS Code color theme: a `.json` file (JSON with comments and trailing commas too) or a `.vsix`. A `.vsix`
is read from its `extension/package.json` `contributes.themes`; its first dark theme and its first light theme become one
Damocles theme with two looks, and the others are named on the card without being read. A theme the `.vsix` lists that
cannot be read (a `.tmTheme`, a file it does not hold, a bad `include`) is left out and named on the card too; the import is
refused only when none of its themes can be read. `include` is followed inside the `.vsix` only: a path that
leaves its `extension/` folder, an include cycle, or more than 16 levels is refused, as is `include` in a lone `.json` file
(import the `.vsix`). A `.tmTheme` file is not read, and neither is a file whose JSON nests more than 64 levels deep.

The colors map back the way Damocles reads VS Code's colors when it runs inside VS Code (`src/webview/styles/tokens.css`):

| Damocles | VS Code color |
| --- | --- |
| background | `editor.background` |
| panel | `sideBar.background`, else `editor.background` |
| text | `foreground` |
| accent | `textLink.foreground` |
| success | `terminal.ansiGreen` |
| warning | `editorWarning.foreground` |
| danger | `errorForeground` |
| info | `editorInfo.foreground` |

`editorWidget.background`, `list.hoverBackground`, `panel.border`, `widget.border`, `editorWidget.border`, `descriptionForeground`,
`editorLineNumber.foreground`, `charts.purple`, `textCodeBlock.background`, `input.background` and the diff editor's inserted and
removed backgrounds become the look's token overrides, as tokens.css pairs them; `terminal.ansi*` become `--d-ansi-0` to
`--d-ansi-15`. The six syntax tokens read `semanticTokenColors` first, then `tokenColors`, by the scopes Damocles' own code theme
paints each with (`--s-kw` keywords, `--s-str` strings, `--s-num` numbers and constants, `--s-com` comments, `--s-fn`
functions, `--s-type` types); the most specific selector wins. A color the theme leaves out comes from VS Code's default for
its base (`uiTheme` `vs-dark`, `vs`, `hc-black` or `hc-light`). A high contrast theme becomes a dark or light look and the card
says so; Windows contrast themes are the way to keep high contrast everywhere.

## Community store

Settings › Appearance › Browse lists the themes of the community store,
[AizenvoltPrime/damocles-themes](https://github.com/AizenvoltPrime/damocles-themes). Each card is drawn from the entry's own
colors, with its wallpaper thumbnails once they matched their pinned SHA-256.

### Installing from the store

Install… and Update… open the same install card as a file or link, after Damocles:

- downloads the entry's file only from a GitHub release host (`github.com`, `objects.githubusercontent.com`,
  `release-assets.githubusercontent.com`), over https, every redirect checked against those hosts and the guard against private
  and local addresses;
- refuses the bytes before reading them when their size or SHA-256 differs from the entry's pin in the signed list;
- refuses an entry whose `minAppVersion` is newer than this Damocles ("Needs a newer Damocles").

While a file downloads, its Browse card shows Cancel; closing Settings ends the download too.

The installed theme's origin is `store`, with the entry's id, version and file SHA-256. Update replaces the installed theme and
keeps its id, so your settings, schedule rules and project looks still name it. If you changed the theme since you installed
it, Update first saves your version as "Name (your edits)", in the same history entry. A card shows an update badge while the
list names another version of its entry.

### Removed themes

The list's `removed` section takes a theme out of the store, by its entry id, and by its file's SHA-256 or its version when it
names them. An installed theme it matches is marked "Removed from the store" with the reason, and every preferred look,
schedule rule, held pick and project look that named it moves to the built-in theme, as one history entry; nothing is
deleted, and the card offers Delete. A theme stays marked until you delete it or install it from the store again (Browse and
its card offer Update… once the list names its entry again, at the same version too); picking it again keeps it, since a
repeat of the same list changes nothing.

### When Damocles fetches the list

The signed list (`community.signed.json`) comes from GitHub when you open Browse (a list fetched within the last day is used
again), when you choose Check for updates, when you choose Install… or Update… and the saved list is over a day old, and,
only while a store theme is installed and only in the installed app, beside
the app's own update check: Help › Check for Updates… and Settings › About's check, and the automatic checks at start, every
4 hours and after sleep, which never run when "Check for updates automatically" is off. That last check reads the list only,
never thumbnails, and is what applies removed entries for people who never open Browse.
Settings › Appearance › Community store (`damocles.desktop.themes.store`) off means no store request at all, and turning it
off ends a list request or a download that is under way. Damocles refuses an unsigned list, a wrong signature, an unknown key,
a list older than one it already saw, an expired one and one with a malformed entry (a file that is not on a GitHub release
host included), and shows nothing from it. After a refusal it asks GitHub again each time the list is needed, also after a
restart, and keeps showing the reason until a list verifies. The highest list number it has seen is kept with the key that
signed it, and forgotten once a release of Damocles stops trusting that key.

When the request itself fails (no connection, an HTTP error, no answer within 30 seconds), Browse says the check failed and
why, and shows the last verified list with the time it was saved. You can still install and update from that list until it
expires; if the download fails too, the card's error says why.

### Submitting a theme

1. Export the theme (Export… in its card's menu) with a name, description, author, version and license in the theme editor's
   Details, and a license on every image, sprite and font it bundles.
2. Publish the file as an asset of a GitHub release in a repository you own, and never replace that asset.
3. Open a pull request on the store repository adding `themes/<id>.json`:
   `{ "id", "version", "author", "url", "sha256", "minAppVersion" }`, as its CONTRIBUTING.md describes.

The store's CI downloads the file, checks its SHA-256 and runs the Damocles theme validator on it,
`node dist/theme-validate.js <file> --thumbs <dir>` (built with `npm run build:theme-validator`, never part of the app). The
validator reads the file as an install does (format, the limits above, every asset's hash and type, and the CSS sanitizer,
where any dropped CSS is refused), requires the licenses, refuses a name, description, license or font name that is empty
once control and bidi characters are removed, and runs the app's own theme renderer under the Electron that Damocles version
pins (its hidden render window, render page and software rendering, as on a computer without a GPU) to check every moving
wallpaper and sprite for flashing (a flagged one is refused; the store never allows flashing) and to make 320 px wide WebP
thumbnails of each look's first wallpaper set. So the store decodes exactly the video the app plays: H.264, VP8, VP9 and AV1.
It prints one JSON verdict, `{ ok, sha256, bytes, entry }` or `{ ok: false, sha256, bytes, errors }` (a file past the
archive's size cap is refused unread, so its verdict has `bytes` and no `sha256`), and exits 0 when accepted, 1 when
refused and 2 on a usage or internal error; it exits 0 or 1 only when the verdict it printed says the same, and prints
nothing on stdout otherwise. Running it needs the checkout's Electron (`npx install-electron`,
since `npm ci` downloads no binary) and the shell build, which `npm run build:theme-validator` makes; on Linux, a display
(`xvfb-run`).
`node scripts/theme-validator-fixtures.ts <dir>` writes an accepted, a flashing and an over-limit fixture to try it on.

The content rule: your own or licensed art with a license for each image and font, and no copyrighted characters without the
rights holder's permission. To report a listed theme, open a Takedown issue on the store repository, or send GitHub a
copyright or trademark report as the store's CONTRIBUTING.md "Takedown" describes.
