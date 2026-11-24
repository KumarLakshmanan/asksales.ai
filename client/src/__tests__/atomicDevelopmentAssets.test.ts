import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rename, rmSync, unlink, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AtomicDevelopmentAssetsPlugin } from "../../config/atomic-development-assets";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup({ existing = true, failWrite = false, failRename = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "outreach-atomic-assets-")); directories.push(directory);
  const chunks = join(directory, "static", "chunks"); mkdirSync(chunks, { recursive: true });
  const asset = join(chunks, "layout.js");
  if (existing) writeFileSync(asset, "complete previous bundle");
  let finishWrite = () => {};
  const compiler = { outputFileSystem: {
    writeFile: (filename: string, ...args: unknown[]) => {
      const callback = args.at(-1) as (error?: Error | null) => void;
      const data = String(args[0]);
      writeFileSync(filename, data.slice(0, 5));
      finishWrite = () => {
        if (failWrite) return callback(new Error("Write failed"));
        writeFileSync(filename, data); callback(null);
      };
    },
    rename: failRename ? (_source: string, _destination: string, callback: (error?: Error | null) => void) => callback(new Error("Rename failed")) : rename,
    unlink,
  } };
  new AtomicDevelopmentAssetsPlugin().apply(compiler);
  const completion = new Promise<Error | null | undefined>(resolve => compiler.outputFileSystem.writeFile(asset, "complete new JavaScript bundle", resolve));
  return { asset, chunks, completion, finish: () => finishWrite() };
}

describe("development JavaScript asset publication", () => {
  it("keeps the previous bundle available until its replacement is complete", async () => {
    const state = setup();
    expect(readFileSync(state.asset, "utf8")).toBe("complete previous bundle");
    state.finish(); expect(await state.completion).toBeNull();
    expect(readFileSync(state.asset, "utf8")).toBe("complete new JavaScript bundle");
    expect(readdirSync(state.chunks)).toEqual(["layout.js"]);
  });
  it("publishes the first bundle only after the complete write", async () => {
    const state = setup({ existing: false });
    expect(existsSync(state.asset)).toBe(false);
    state.finish(); expect(await state.completion).toBeNull();
    expect(readFileSync(state.asset, "utf8")).toBe("complete new JavaScript bundle");
  });
  for (const failure of ["failWrite", "failRename"] as const) {
    it(`preserves the previous bundle and removes incomplete files on ${failure}`, async () => {
      const state = setup({ [failure]: true });
      state.finish(); expect(await state.completion).toBeInstanceOf(Error);
      expect(readFileSync(state.asset, "utf8")).toBe("complete previous bundle");
      expect(readdirSync(state.chunks)).toEqual(["layout.js"]);
    });
  }
});
