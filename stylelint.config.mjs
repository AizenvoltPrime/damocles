// Webview sizes are rem so they follow the host font (docs/invariants.md "Design tokens"); px stays for border and outline
// widths, blur and shadows, none of which these properties carry.
const PX_SIZED = String.raw`/^(?:font-size|line-height|gap|row-gap|column-gap|top|right|bottom|left|flex|flex-basis)$|^(?:padding|margin|inset)(?:-|$)|^(?:min-|max-)?(?:width|height|inline-size|block-size)$|^border(?:-[a-z]+)*-radius$/`;

export default {
  extends: ['stylelint-config-recommended-vue'],
  rules: {
    'declaration-property-unit-disallowed-list': [
      { [PX_SIZED]: ['px'] },
      { message: (property) => `Use rem (px / 16) for "${property}" so it follows the host font (docs/invariants.md "Design tokens").` },
    ],
    // A media query's rem ignores the root font; query the panel with a container query (`@container app`) instead.
    'media-feature-name-disallowed-list': [
      [String.raw`/^(?:(?:min|max)-)?(?:device-)?(?:width|height)$/`],
      { message: (feature) => `Use a container query instead of the "${feature}" media feature, which ignores the host font (docs/invariants.md "Design tokens").` },
    ],
  },
};
