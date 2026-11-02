// Builds ELF64 little-endian headers for the PT_LOAD alignment tests.

export interface Segment {
  type: number;
  offset: number;
  vaddr: number;
  filesz: number;
  align: number;
}

export const PT_LOAD = 1;
export const PT_INTERP = 3;
export const PT_GNU_STACK = 0x6474e551;

// node-v24.22.0-linux-x64's PT_LOAD segments as readelf -l lists them, with its interpreter and stack headers
export const NODE_LINUX_X64: Segment[] = [
  { type: PT_INTERP, offset: 0x350, vaddr: 0x400350, filesz: 0x1c, align: 0x1 },
  { type: PT_LOAD, offset: 0x0, vaddr: 0x400000, filesz: 0x34b8c8, align: 0x1000 },
  { type: PT_LOAD, offset: 0x34c000, vaddr: 0x74c000, filesz: 0x2200, align: 0x1000 },
  { type: PT_LOAD, offset: 0x350000, vaddr: 0x750000, filesz: 0x2921c74, align: 0x2000 },
  { type: PT_LOAD, offset: 0x2e00000, vaddr: 0x3200000, filesz: 0x6a1, align: 0x200000 },
  { type: PT_LOAD, offset: 0x2e01000, vaddr: 0x3201000, filesz: 0x397a4b2, align: 0x1000 },
  { type: PT_LOAD, offset: 0x677b5d0, vaddr: 0x6b7c5d0, filesz: 0x29f10, align: 0x1000 },
  { type: PT_GNU_STACK, offset: 0, vaddr: 0, filesz: 0, align: 0x10 },
];

const EHDR_SIZE = 64;
const PHDR_SIZE = 56;

/**
 * An x86-64 ELF executable whose program headers follow its ELF header. File offsets and sizes are divided by `scale`
 * so the file stays small; each p_vaddr moves with its offset, keeping p_vaddr - p_offset as given.
 */
export function elf(segments: Segment[], { type = 2, machine = 62, scale = 0x1000 }: { type?: number; machine?: number; scale?: number } = {}): Buffer {
  const scaled = segments.map((segment) => ({ ...segment, offset: Math.floor(segment.offset / scale), filesz: Math.ceil(segment.filesz / scale) }));
  const end = Math.max(EHDR_SIZE + segments.length * PHDR_SIZE, ...scaled.map((segment) => segment.offset + segment.filesz));
  const out = Buffer.alloc(end);
  out.writeUInt32BE(0x7f454c46, 0);
  out[4] = 2;
  out[5] = 1;
  out[6] = 1;
  out.writeUInt16LE(type, 0x10);
  out.writeUInt16LE(machine, 0x12);
  out.writeUInt32LE(1, 0x14);
  out.writeBigUInt64LE(BigInt(EHDR_SIZE), 0x20);
  out.writeUInt16LE(EHDR_SIZE, 0x34);
  out.writeUInt16LE(PHDR_SIZE, 0x36);
  out.writeUInt16LE(segments.length, 0x38);
  segments.forEach((segment, i) => {
    const at = EHDR_SIZE + i * PHDR_SIZE;
    out.writeUInt32LE(segment.type, at);
    out.writeBigUInt64LE(BigInt(scaled[i]!.offset), at + 8);
    out.writeBigUInt64LE(BigInt(segment.vaddr - segment.offset + scaled[i]!.offset), at + 16);
    out.writeBigUInt64LE(BigInt(segment.vaddr - segment.offset + scaled[i]!.offset), at + 24);
    out.writeBigUInt64LE(BigInt(scaled[i]!.filesz), at + 32);
    out.writeBigUInt64LE(BigInt(scaled[i]!.filesz), at + 40);
    out.writeBigUInt64LE(BigInt(segment.align), at + 48);
  });
  return out;
}

/** The p_align of every program header of `data`, in order. */
export function aligns(data: Buffer): number[] {
  const phoff = Number(data.readBigUInt64LE(0x20));
  return Array.from({ length: data.readUInt16LE(0x38) }, (_, i) => Number(data.readBigUInt64LE(phoff + i * PHDR_SIZE + 48)));
}
