import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs helper, no types
import { clampLoadAlign } from '../elf-load-align.mjs';
import { aligns, elf, NODE_LINUX_X64, PT_LOAD, type Segment } from './elf-fixture';

const clamp = (data: Buffer): Buffer => clampLoadAlign(data, 'node') as Buffer;
const load = (offset: number, vaddr: number, align: number): Segment => ({ type: PT_LOAD, offset, vaddr, filesz: 0x1000, align });

describe('clampLoadAlign', () => {
  it('clamps Node 24\'s 2 MiB and 8 KiB PT_LOAD alignments to 4 KiB and changes no other byte', () => {
    const shipped = elf(NODE_LINUX_X64);
    const before = Buffer.from(shipped);
    const clamped = clamp(shipped);
    expect(aligns(shipped)).toEqual([0x1, 0x1000, 0x1000, 0x2000, 0x200000, 0x1000, 0x1000, 0x10]);
    expect(aligns(clamped)).toEqual([0x1, 0x1000, 0x1000, 0x1000, 0x1000, 0x1000, 0x1000, 0x10]);
    expect(shipped.equals(before)).toBe(true);
    const changed = [...clamped.keys()].filter((i) => clamped[i] !== shipped[i]);
    // bytes 1 and 2 of the p_align fields (64 + 56 * i + 48) of program headers 3 and 4
    expect(changed).toEqual([64 + 56 * 3 + 49, 64 + 56 * 4 + 49, 64 + 56 * 4 + 50]);
    expect(clamp(clamped).equals(clamped)).toBe(true);
  });

  it('clamps a position-independent executable too, as the musl Node is', () => {
    expect(aligns(clamp(elf([load(0, 0, 0x1000), load(0x3400000, 0x3400000, 0x200000)], { type: 3 })))).toEqual([0x1000, 0x1000]);
  });

  it('refuses a file that is no 64-bit little-endian x86-64 executable', () => {
    const good = elf(NODE_LINUX_X64);
    const edited = (at: number, byte: number) => Buffer.concat([good.subarray(0, at), Buffer.from([byte]), good.subarray(at + 1)]);
    expect(() => clamp(Buffer.from('#!/bin/sh\n'.padEnd(80)))).toThrow('node: not an ELF file');
    expect(() => clamp(edited(4, 1))).toThrow('not a 64-bit little-endian ELF file');
    expect(() => clamp(edited(5, 2))).toThrow('not a 64-bit little-endian ELF file');
    expect(() => clamp(edited(6, 0))).toThrow('not a 64-bit little-endian ELF file');
    expect(() => clamp(elf(NODE_LINUX_X64, { type: 1 }))).toThrow('ELF type 1 is not an executable');
    expect(() => clamp(elf(NODE_LINUX_X64, { machine: 183 }))).toThrow('machine 183 is not x86-64');
  });

  it('refuses program headers it cannot read whole', () => {
    const good = elf(NODE_LINUX_X64);
    const withField = (write: (data: Buffer) => void) => {
      const data = Buffer.from(good);
      write(data);
      return data;
    };
    expect(() => clamp(withField((data) => data.writeUInt16LE(64, 0x36)))).toThrow('program header size 64 is not 56');
    expect(() => clamp(withField((data) => data.writeUInt16LE(0, 0x38)))).toThrow('program header count 0 is not supported');
    expect(() => clamp(withField((data) => data.writeUInt16LE(0xffff, 0x38)))).toThrow('program header count 65535 is not supported');
    expect(() => clamp(withField((data) => data.writeUInt16LE(Math.floor(good.length / 56) + 1, 0x38)))).toThrow('its program headers lie outside the file');
    expect(() => clamp(withField((data) => data.writeBigUInt64LE(32n, 0x20)))).toThrow('its program headers lie outside the file');
    expect(() => clamp(withField((data) => data.writeBigUInt64LE(BigInt(good.length - 56 * 8 + 1), 0x20)))).toThrow('its program headers lie outside the file');
  });

  it('refuses a PT_LOAD outside the file, one it cannot map in 4 KiB pages, and a file with none', () => {
    const tail = elf([load(0, 0, 0x1000)]);
    expect(() => clamp(elf([load(0, 0, 0x1000), { ...load(0x2000, 0x2000, 0x1000), filesz: 0x10000 }], { scale: 1 }).subarray(0, 0x3000))).toThrow('PT_LOAD 1 lies outside the file');
    expect(() => clamp(elf([load(0, 0, 0x1000), load(0x1000, 0x2000, 0x3000)], { scale: 1 }))).toThrow('PT_LOAD 1 has p_align 12288, not a power of two');
    expect(() => clamp(elf([load(0, 0, 0x1000), load(0x1000, 0x2800, 0x200000)], { scale: 1 }))).toThrow('PT_LOAD 1 has p_vaddr and p_offset that differ within a page');
    expect(clamp(tail).equals(tail)).toBe(true);
    expect(() => clamp(elf(NODE_LINUX_X64.filter((segment) => segment.type !== PT_LOAD)))).toThrow('it has no PT_LOAD segment');
  });
});
