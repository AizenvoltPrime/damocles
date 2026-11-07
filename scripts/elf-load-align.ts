// WSL 1's ELF loader returns ENOEXEC for a PT_LOAD whose p_align exceeds its 4 KiB page (nodejs/node#63735). Adapted from
// VS Code's build/gulpfile.reh.ts `patchElfLoadAlign` (MIT); it throws on any layout it was not written for, so a changed
// Node fails the build.

export const PAGE_SIZE = 0x1000;

const ELF_MAGIC = 0x7f454c46;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EV_CURRENT = 1;
const ET_EXEC = 2;
const ET_DYN = 3;
const EM_X86_64 = 62;
const EHDR_SIZE = 64;
const PHDR_SIZE = 56;
// e_phnum 0xffff means the count lives in section header 0, which this reader does not follow
const PN_XNUM = 0xffff;
const PT_LOAD = 1;

/** A `Buffer` copy of `elf` whose PT_LOAD segments have p_align at most PAGE_SIZE; throws on any other layout. */
export function clampLoadAlign(elf: Buffer, name = 'ELF file'): Buffer {
  const fail = (why: string): never => {
    throw new Error(`${name}: ${why}, so its PT_LOAD alignment cannot be clamped`);
  };
  if (elf.length < EHDR_SIZE || elf.readUInt32BE(0) !== ELF_MAGIC) fail('not an ELF file');
  if (elf[4] !== ELFCLASS64 || elf[5] !== ELFDATA2LSB || elf[6] !== EV_CURRENT) fail('not a 64-bit little-endian ELF file');
  const type = elf.readUInt16LE(0x10);
  if (type !== ET_EXEC && type !== ET_DYN) fail(`ELF type ${type} is not an executable`);
  const machine = elf.readUInt16LE(0x12);
  if (machine !== EM_X86_64) fail(`machine ${machine} is not x86-64`);
  const phoff = elf.readBigUInt64LE(0x20);
  const phentsize = elf.readUInt16LE(0x36);
  const phnum = elf.readUInt16LE(0x38);
  if (phentsize !== PHDR_SIZE) fail(`program header size ${phentsize} is not ${PHDR_SIZE}`);
  if (phnum === 0 || phnum === PN_XNUM) fail(`program header count ${phnum} is not supported`);
  if (phoff < BigInt(EHDR_SIZE) || phoff + BigInt(phnum * PHDR_SIZE) > BigInt(elf.length)) fail('its program headers lie outside the file');

  const out = Buffer.from(elf);
  let loads = 0;
  for (let i = 0; i < phnum; i++) {
    const at = Number(phoff) + i * PHDR_SIZE;
    if (out.readUInt32LE(at) !== PT_LOAD) continue;
    loads++;
    const offset = out.readBigUInt64LE(at + 8);
    const vaddr = out.readBigUInt64LE(at + 16);
    const filesz = out.readBigUInt64LE(at + 32);
    const align = out.readBigUInt64LE(at + 48);
    if (offset + filesz > BigInt(out.length)) fail(`PT_LOAD ${i} lies outside the file`);
    if (align <= BigInt(PAGE_SIZE)) continue;
    if ((align & (align - 1n)) !== 0n) fail(`PT_LOAD ${i} has p_align ${align}, not a power of two`);
    // mapping a segment page by page needs its address and offset congruent modulo the page size
    if ((vaddr - offset) % BigInt(PAGE_SIZE) !== 0n) fail(`PT_LOAD ${i} has p_vaddr and p_offset that differ within a page`);
    out.writeBigUInt64LE(BigInt(PAGE_SIZE), at + 48);
  }
  if (loads === 0) fail('it has no PT_LOAD segment');
  return out;
}
