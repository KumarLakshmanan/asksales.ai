import type { Readable } from "node:stream";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
/** ZIP data descriptors let each object stream without buffering an archive. */
export async function* storageZip(
  files: Array<{
    id: number;
    name: string;
    size: number;
    open: () => Promise<Readable>;
  }>,
) {
  const directory: Buffer[] = [];
  let position = 0;
  for (const file of files) {
    const name = Buffer.from(
      // eslint-disable-next-line no-control-regex -- Archive entry names must exclude control characters and separators.
      `${file.id}-${file.name.replace(/[\x00-\x1f/\\]/g, "_")}`,
      "utf8",
    );
    const start = position,
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x808, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt16LE(name.length, 26);
    yield header;
    yield name;
    position += header.length + name.length;
    let crc = 0xffffffff,
      size = 0;
    const stream = await file.open();
    try {
      for await (const chunk of stream) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const byte of data)
          crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        size += data.length;
        if (size > file.size)
          throw new Error("The stored file size changed during download");
        yield data;
        position += data.length;
      }
    } finally {
      stream.destroy();
    }
    if (size !== file.size) throw new Error("The stored file is incomplete");
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    position += 16;
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x808, 8);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(start, 42);
    directory.push(entry, name);
  }
  const directoryStart = position;
  for (const entry of directory) {
    yield entry;
    position += entry.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(position - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  yield end;
}

export function storageByteRange(value: string | undefined, size: number) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid byte range");
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    throw new Error("Invalid byte range");
  return { start, end };
}
