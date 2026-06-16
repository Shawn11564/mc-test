/**
 * Minimal in-memory ZIP writer (stored/no-compression entries) for tests — lets
 * us build synthetic `natives-*.jar` fixtures without a zip dependency. The
 * `extractNatives` reader ignores CRCs for stored entries, so we write CRC 0.
 */
export function makeStoredZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header sig
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(0, 8); // method 0 = stored
    lh.writeUInt32LE(0, 10); // time+date
    lh.writeUInt32LE(0, 14); // crc32 (ignored for stored)
    lh.writeUInt32LE(e.data.length, 18); // compressed size
    lh.writeUInt32LE(e.data.length, 22); // uncompressed size
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    const localRec = Buffer.concat([lh, name, e.data]);
    locals.push(localRec);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central dir header sig
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(0, 10); // method
    ch.writeUInt32LE(0, 12); // time+date
    ch.writeUInt32LE(0, 16); // crc32
    ch.writeUInt32LE(e.data.length, 20); // compressed size
    ch.writeUInt32LE(e.data.length, 24); // uncompressed size
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk number
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([ch, name]));

    offset += localRec.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD sig
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBlock.length, 12); // central dir size
  eocd.writeUInt32LE(localBlock.length, 16); // central dir offset
  return Buffer.concat([localBlock, centralBlock, eocd]);
}
