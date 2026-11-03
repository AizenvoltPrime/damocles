import { describe, expect, it } from 'vitest';
import { canonicalHexColor, hexColorParts, isHexColor } from '../hex-color';
import { canonicalHostColor, HOST_TONES, hostColorLook, isHostColor } from '../host-colors';

describe('host colors', () => {
  it.each([...HOST_TONES, '#00808099', '#000000ff', '#ffffff01', '#0a1b2c3d'])('accepts the canonical %s', (value) => {
    expect(isHostColor(value)).toBe(true);
  });

  // A custom color lands in inline style, so anything beyond the exact #rrggbbaa form could carry CSS.
  it.each([
    '#008080',
    '#00A0A0FF',
    '#0080809A',
    '#088',
    '#0889',
    'teal',
    'muted',
    'none',
    '',
    'url(x)',
    '#00ff00ff;background:url(x)',
    '#00ff00ff ',
    ' #00ff00ff',
    '#00ff00ff\n',
    'rgb(0 128 128)',
    '#00ff00fff',
    '00ff00ff',
  ])('rejects %j', (value) => {
    expect(isHostColor(value)).toBe(false);
    expect(isHexColor(value)).toBe(false);
  });

  it.each([undefined, null, 0, 0x00ff00ff, true, {}, ['#00ff00ff'], { toString: () => '#00ff00ff' }])('rejects the non-string %j', (value) => {
    expect(isHostColor(value)).toBe(false);
    expect(isHexColor(value)).toBe(false);
  });

  it('reads a color at zero opacity as no color', () => {
    expect(isHexColor('#ffffff00')).toBe(true);
    expect(isHostColor('#ffffff00')).toBe(false);
    expect(canonicalHostColor('#FFFFFF00')).toBeNull();
    expect(canonicalHostColor(canonicalHexColor('#00809a00')!)).toBeNull();
  });

  it('splits a color into 0-255 channels and a 0-1 alpha', () => {
    expect(hexColorParts(canonicalHexColor('#00809a99')!)).toEqual({ r: 0, g: 128, b: 154, alpha: 0.6 });
    expect(hexColorParts(canonicalHexColor('#ffffff00')!)).toEqual({ r: 255, g: 255, b: 255, alpha: 0 });
  });

  it('canonicalizes a six- or eight-digit hex in any case, six digits at full opacity', () => {
    expect(canonicalHostColor('#00809A')).toBe('#00809aff');
    expect(canonicalHostColor('#00809A99')).toBe('#00809a99');
    expect(canonicalHostColor('#00809a99')).toBe('#00809a99');
    expect(isHostColor(canonicalHostColor('#ABCDEF'))).toBe(true);
    expect(canonicalHexColor('#ABCDEF00')).toBe('#abcdef00');
  });

  it.each(['#088', '#0889', '00809a', 'teal', '#00809a99;x', '#00809g', ''])('gives no canonical form for %j', (value) => {
    expect(canonicalHostColor(value)).toBeUndefined();
    expect(canonicalHexColor(value)).toBeUndefined();
  });

  it('gives a custom color only numbers in inline style', () => {
    expect(hostColorLook(canonicalHostColor('#00809a99')!)).toEqual({ class: 'd-tone-custom', style: { '--host-rgb': '0 128 154', '--host-alpha': '0.6' } });
    expect(hostColorLook('danger')).toEqual({ class: 'd-tone-danger' });
    expect(hostColorLook(undefined, 'info')).toEqual({ class: 'd-tone-info' });
  });
});
