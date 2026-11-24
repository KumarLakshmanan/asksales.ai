/** The value after a `--name` flag on the command line, or undefined when the flag is absent. */
export function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
