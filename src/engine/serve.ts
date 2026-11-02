// Entry point for `wriven-workflow serve`: wires stdio to the engine.

import { readLines, StdoutWriter } from "../protocol/lines.ts";
import { Engine } from "./engine.ts";

export async function serve(): Promise<void> {
  const out = new StdoutWriter();
  const engine = new Engine({
    write: (line) => out.write(line),
    exit: (code) => {
      void out.flush().then(() => process.exit(code));
    },
  });
  await readLines(Bun.stdin.stream(), {
    onLine: (line) => engine.peer.receive(line),
    onOversize: () => engine.peer.reportOversize(),
  });
  await engine.onStdinClosed();
  // `exit` above ends the process once stdout has drained.
  await new Promise(() => {});
}
