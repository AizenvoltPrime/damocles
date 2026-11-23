// Renderer sizes are rem so they follow the host font (docs/invariants.md "Design tokens"); px stays for border and outline
// widths, blur and shadows, none of which these properties carry.
const PX_SIZED = String.raw`/^(?:font-size|line-height|gap|row-gap|column-gap|top|right|bottom|left|flex|flex-basis)$|^(?:padding|margin|inset)(?:-|$)|^(?:min-|max-)?(?:width|height|inline-size|block-size)$|^border(?:-[a-z]+)*-radius$/`;

// A corner follows the theme's radius scale: a ramp variable (--radius-*), or calc(<rem> * var(--d-radius-scale, 1)) where the
// ramp has no step. A bare length ignores the scale; 0, a percentage and the 999rem pill do not scale and stay.
const RADIUS = String.raw`/^border(?:-[a-z]+)*-radius$/`;
const BARE_LENGTH = String.raw`/(?:^|\s)(?!999rem(?:\s|$))(?:\d*\.)?\d*[1-9]\d*(?:rem|em|px)(?=\s|$)/`;

export default {
  extends: ['stylelint-config-recommended-vue'],
  rules: {
    'declaration-property-unit-disallowed-list': [
      { [PX_SIZED]: ['px'] },
      { message: (property) => `Use rem (px / 16) for "${property}" so it follows the host font (docs/invariants.md "Design tokens").` },
    ],
    'declaration-property-value-disallowed-list': [
      { [RADIUS]: [BARE_LENGTH] },
      { message: (property) => `Take "${property}" from the radius ramp (var(--radius-*)) or scale it by var(--d-radius-scale, 1), so it follows the theme's corners (docs/invariants.md "Design tokens").` },
    ],
    // A media query's rem ignores the root font; query the panel with a container query (`@container app`) instead.
    'media-feature-name-disallowed-list': [
      [String.raw`/^(?:(?:min|max)-)?(?:device-)?(?:width|height)$/`],
      { message: (feature) => `Use a container query instead of the "${feature}" media feature, which ignores the host font (docs/invariants.md "Design tokens").` },
    ],
  },
};
