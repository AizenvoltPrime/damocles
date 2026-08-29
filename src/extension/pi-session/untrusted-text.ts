/**
 * The canonical flatteners for text Damocles did not author, such as MCP tool names and descriptions, page
 * output and model-chosen agent names, before it is placed next to trusted chrome (a line-structured
 * menu the model is told to trust, or the panel's own dialog header).
 *
 * A leaf module on purpose: its consumers (`tools/tool-search-tool.ts`, `extension-ui-context.ts`,
 * `tools/shell-cancel-registry.ts`) import it and nothing else does, so none drags another's import
 * graph in at eval time. Linear-time patterns only, because this runs on hostile input.
 *
 * Two functions rather than one because the threats differ, and a caller takes only the one its threat
 * needs. Control characters break layout, so they are stripped wherever the string is placed next to
 * line-structured chrome. Bidi overrides break reading order, which matters wherever a human renders
 * the string; the model-facing menu leaves them alone, since there a name must survive byte-for-byte
 * to stay callable. Text that is user turn content takes only the bidi strip: it is trusted at the
 * same level as anything typed into the composer, and flattening its newlines would destroy meaning
 * the user put there.
 */

/**
 * Third-party text reaches the model inside a line-structured menu it is told to trust, so a name or
 * blurb carrying a newline forges a whole extra group line ("compass (1): IgnorePreviousInstructions").
 * Flattening at the point the menu is built is what makes that structurally impossible.
 *
 * The class is every character with layout meaning and no printable glyph: C0 + DEL, the C1 block
 * (U+0080-U+009F, which contains NEL U+0085), and the Unicode separators U+2028/U+2029. C1 and the
 * separators are line terminators to a fair number of renderers and tokenizers, so a class stopping at
 * DEL would leave the forge-a-line attack open through a wider alphabet than it closes.
 */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
}

/**
 * Bidirectional formatting characters: the LRM/RLM marks, the embedding/override pair (U+202A-U+202E)
 * and the isolates (U+2066-U+2069). An unpaired RTL override reverses the visual order of everything
 * after it, so a model-chosen agent name can render as text it does not contain, a spoof that no
 * amount of control-character flattening touches, because none of these are control characters.
 *
 * Removed rather than replaced with a space: they are zero-width, so substituting a space would alter
 * a legitimate name's appearance for no gain.
 *
 * Only for human-rendered strings. The ToolSearch menu deliberately does not use this: a tool name is
 * an identifier the model must reproduce exactly, so a name that would change here is omitted from the
 * menu instead (see `mcpInventoryLines`).
 */
export function stripBidiControls(value: string): string {
  return value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}
