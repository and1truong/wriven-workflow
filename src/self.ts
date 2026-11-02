// The argv prefix that re-executes this program, compiled or from source.

export function selfCommand(): string[] {
  if (import.meta.path.startsWith("/$bunfs/")) return [process.execPath];
  return [process.execPath, new URL("./main.ts", import.meta.url).pathname];
}
