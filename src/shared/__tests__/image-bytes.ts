/** Leading bytes of each image format, enough for a signature check; shared by the MCP image tests. */
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const chunk = (type: string, length: number): number[] => [0, 0, 0, length, ...ascii(type), ...new Array<number>(length + 4).fill(0)];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const IMAGE_BYTES = {
  png: Uint8Array.from([...PNG_SIGNATURE, ...chunk('IHDR', 13), ...chunk('IDAT', 2)]),
  apng: Uint8Array.from([...PNG_SIGNATURE, ...chunk('IHDR', 13), ...chunk('acTL', 8), ...chunk('IDAT', 2)]),
  jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii('JFIF'), 0]),
  jpegLs: Uint8Array.from([0xff, 0xd8, 0xff, 0xf7, 0, 0]),
  gif: Uint8Array.from([...ascii('GIF89a'), 1, 0, 1, 0, 0]),
  webp: Uint8Array.from([...ascii('RIFF'), 20, 0, 0, 0, ...ascii('WEBPVP8 '), 0, 0, 0, 0]),
  tiff: Uint8Array.from([...ascii('II*'), 0, 8, 0, 0, 0]),
  bmp: Uint8Array.from([...ascii('BM'), 30, 0, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0, 12, 0, 0, 0, 1, 0, 1, 0, 1, 0, 24, 0, 0, 0, 0, 0]),
  svg: Uint8Array.from(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')),
};

export const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
