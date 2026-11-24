type WriteCallback = (error?: Error | null) => void;
type OutputFileSystem = {
  writeFile: (filename: string, ...args: unknown[]) => void;
  rename: (source: string, destination: string, callback: WriteCallback) => void;
  unlink?: (filename: string, callback: WriteCallback) => void;
};

let writeRevision = 0;

/** Keep browsers from reading a dev chunk while webpack is still writing it. */
export class AtomicDevelopmentAssetsPlugin {
  apply(compiler: { outputFileSystem?: OutputFileSystem | null }) {
    const originalFs = compiler.outputFileSystem;
    if (!originalFs?.writeFile || !originalFs.rename) return;
    const wrappedFs: OutputFileSystem = Object.create(originalFs);
    wrappedFs.writeFile = (filename, ...args) => {
      const callback = args.at(-1);
      if (typeof filename !== "string" || !filename.replaceAll("\\", "/").includes("/static/chunks/")
        || !filename.endsWith(".js") || typeof callback !== "function") {
        return originalFs.writeFile(filename, ...args);
      }
      const complete = callback as WriteCallback;
      const temporary = `${filename}.writing-${process.pid}-${++writeRevision}`;
      const finish = (error?: Error | null) => {
        if (!error) return complete(null);
        if (originalFs.unlink) originalFs.unlink(temporary, () => complete(error));
        else complete(error);
      };
      originalFs.writeFile(temporary, ...args.slice(0, -1), (error?: Error | null) => {
        if (error) return finish(error);
        originalFs.rename(temporary, filename, finish);
      });
    };
    compiler.outputFileSystem = wrappedFs;
  }
}
