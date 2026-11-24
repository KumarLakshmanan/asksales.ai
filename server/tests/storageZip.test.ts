import { describe, expect, it } from "@jest/globals";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { storageByteRange, storageZip } from "../utils/storageZip.js";
describe("streaming storage downloads", () => {
  it("writes a readable ZIP with valid CRC, UTF-8 names and traversal-safe entries", async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of storageZip([
      {
        id: 1,
        name: "../résumé.txt",
        size: 11,
        open: async () =>
          Readable.from([Buffer.from("hello "), Buffer.from("world")]),
      },
      {
        id: 2,
        name: "empty.txt",
        size: 0,
        open: async () => Readable.from([]),
      },
    ]))
      chunks.push(chunk);
    const result = execFileSync(
      "python3",
      [
        "-c",
        "import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({'names':z.namelist(),'text':z.read(z.namelist()[0]).decode(),'crc':z.testzip()}))",
      ],
      { input: Buffer.concat(chunks) },
    );
    expect(JSON.parse(result.toString())).toEqual({
      names: ["1-.._résumé.txt", "2-empty.txt"],
      text: "hello world",
      crc: null,
    });
  });
  it("rejects truncated objects and closes the source on cancellation", async () => {
    const stream = Readable.from([Buffer.from("abc")]);
    await expect(async () => {
      for await (const _ of storageZip([
        { id: 1, name: "a", size: 4, open: async () => stream },
      ])) {
        /* consume */
      }
    }).rejects.toThrow("incomplete");
    expect(stream.destroyed).toBe(true);
  });
  it.each([
    ["bytes=0-2", { start: 0, end: 2 }],
    ["bytes=3-", { start: 3, end: 9 }],
    ["bytes=-3", { start: 7, end: 9 }],
    ["bytes=0-99", { start: 0, end: 9 }],
  ])("supports %s", (value, expected) =>
    expect(storageByteRange(value as string, 10)).toEqual(expected),
  );
  it.each(["bytes=10-", "bytes=3-2", "bytes=-0", "bytes=0-2,4-5", "garbage"])(
    "rejects invalid ranges: %s",
    (value) => expect(() => storageByteRange(value, 10)).toThrow(),
  );
});
