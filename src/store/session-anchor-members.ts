import { createHash } from 'node:crypto';

/** Last-property match contributions, with compact native storage for large JSON objects. */
export class AnchorMemberMatches {
  private small = new Map<string, bigint>();
  private table?: Buffer;
  private buckets = 256;
  private occupied = 0;
  private readonly bytes: number;
  private readonly width: number;
  private readonly counts: Float64Array;
  flags = 0n;

  constructor(terms: number, private readonly compactAfter = 100_000) {
    this.bytes = Math.ceil(terms / 8);
    this.width = 33 + this.bytes;
    this.counts = new Float64Array(terms);
  }

  set(key: string, flags: bigint): void {
    if (!this.table) {
      const old = this.small.get(key) ?? 0n;
      this.adjust(old, flags);
      if (flags) this.small.set(key, flags);
      else this.small.delete(key);
      if (this.small.size > this.compactAfter) this.compact();
      return;
    }
    this.put(createHash('sha256').update(key, 'utf16le').digest(), flags);
  }

  private adjust(old: bigint, flags: bigint): void {
    const changed = old ^ flags;
    if (!changed) return;
    for (let i = 0; i < this.counts.length; i++) {
      const bit = 1n << BigInt(i);
      if (!(changed & bit)) continue;
      this.counts[i] += flags & bit ? 1 : -1;
      if (this.counts[i] === 1 && flags & bit) this.flags |= bit;
      else if (this.counts[i] === 0) this.flags &= ~bit;
    }
  }

  private compact(): void {
    while (this.buckets * 0.7 < this.small.size) this.buckets *= 2;
    this.table = Buffer.alloc(this.buckets * this.width);
    this.counts.fill(0);
    this.flags = 0n;
    for (const [key, flags] of this.small) this.put(createHash('sha256').update(key, 'utf16le').digest(), flags);
    this.small.clear();
  }

  private slot(digest: Buffer): number {
    let bucket = digest.readUInt32LE(0) & (this.buckets - 1);
    for (;;) {
      const offset = bucket * this.width;
      if (!this.table![offset]) return offset;
      let equal = true;
      for (let i = 0; i < 32; i += 4) {
        if (this.table!.readUInt32LE(offset + 1 + i) !== digest.readUInt32LE(i)) { equal = false; break; }
      }
      if (equal) return offset;
      bucket = (bucket + 1) & (this.buckets - 1);
    }
  }

  private put(digest: Buffer, flags: bigint): void {
    let offset = this.slot(digest);
    if (!this.table![offset]) {
      if (!flags) return;
      if (this.occupied + 1 > this.buckets * 0.7) { this.grow(); offset = this.slot(digest); }
      this.table![offset] = 1;
      digest.copy(this.table!, offset + 1);
      this.occupied++;
    }
    // Empty contributions keep their key slot: a later duplicate can restore
    // it without confusing another key in the same probing chain.
    for (let byte = 0; byte < this.bytes; byte++) {
      const position = offset + 33 + byte;
      const old = this.table![position];
      const value = Number((flags >> BigInt(byte * 8)) & 255n);
      const changed = old ^ value;
      if (!changed) continue;
      this.table![position] = value;
      for (let bit = 0; bit < 8 && byte * 8 + bit < this.counts.length; bit++) {
        const mask = 1 << bit;
        if (!(changed & mask)) continue;
        const index = byte * 8 + bit;
        this.counts[index] += value & mask ? 1 : -1;
        const flag = 1n << BigInt(index);
        if (this.counts[index] === 1 && value & mask) this.flags |= flag;
        else if (this.counts[index] === 0) this.flags &= ~flag;
      }
    }
  }

  private grow(): void {
    const old = this.table!;
    this.buckets *= 2;
    this.table = Buffer.alloc(this.buckets * this.width);
    for (let offset = 0; offset < old.length; offset += this.width) {
      if (!old[offset]) continue;
      const target = this.slot(old.subarray(offset + 1, offset + 33));
      old.copy(this.table, target, offset, offset + this.width);
    }
  }
}
