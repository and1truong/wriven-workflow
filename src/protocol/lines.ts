// Newline-delimited framing with a hard line limit. A line over the limit is reported and discarded;
// the connection carries on with the next line.

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
// Between the engine and its run process: both ends are this binary and the limit that protects anyone
// is the public one above. Large enough for a run's whole input (fixtures, a pipeline, a state file).
export const MAX_PRIVATE_LINE_BYTES = 128 * 1024 * 1024;
const NEWLINE = 10;

export interface LineHandlers {
  onLine(line: string): void;
  onOversize(): void;
}

export class LineSplitter {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private discarding = false;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly handlers: LineHandlers,
    private readonly maxBytes = MAX_LINE_BYTES,
  ) {}

  push(chunk: Uint8Array): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(NEWLINE, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      this.append(piece);
      if (end === -1) return;
      this.finishLine();
      start = end + 1;
    }
  }

  private append(piece: Uint8Array): void {
    if (this.discarding) return;
    if (this.size + piece.length > this.maxBytes) {
      this.chunks = [];
      this.size = 0;
      this.discarding = true;
      this.handlers.onOversize();
      return;
    }
    if (piece.length > 0) {
      // The subarray views a buffer the stream may reuse.
      this.chunks.push(piece.slice());
      this.size += piece.length;
    }
  }

  private finishLine(): void {
    if (this.discarding) {
      this.discarding = false;
      return;
    }
    const bytes = this.chunks.length === 1 ? this.chunks[0]! : Bun.concatArrayBuffers(this.chunks, Infinity, true);
    this.chunks = [];
    const size = this.size;
    this.size = 0;
    if (size === 0) return;
    this.handlers.onLine(this.decoder.decode(bytes));
  }
}

export async function readLines(stream: ReadableStream<Uint8Array>, handlers: LineHandlers, maxBytes = MAX_LINE_BYTES): Promise<void> {
  const splitter = new LineSplitter(handlers, maxBytes);
  for await (const chunk of stream) splitter.push(chunk);
}

// Writes without blocking the event loop, so a host that is slow to read cannot stop the engine from
// reading stdin. Order is preserved; `flush` resolves once everything queued has reached the pipe.
export class StdoutWriter {
  private pending: Promise<void> = Promise.resolve();
  private broken = false;

  write(line: string): void {
    if (this.broken) return;
    this.pending = this.pending.then(
      () =>
        new Promise<void>((resolve) => {
          try {
            process.stdout.write(line, (err) => {
              if (err) this.broken = true;
              resolve();
            });
          } catch {
            this.broken = true;
            resolve();
          }
        }),
    );
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
