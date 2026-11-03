// A host that starts a run and is then killed from outside, so the engine loses it without warning.
// Prints the engine's pid once a model call is outstanding, and never answers it.

const [binary, stateDir] = process.argv.slice(2) as [string, string];
const engine = Bun.spawn([binary, "serve"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
const send = (id: string, method: string, params: unknown) => {
  void engine.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  void engine.stdin.flush();
};
const pipeline = {
  format: "wriven-workflow/pipeline@1",
  name: "Hold",
  input: { type: "host_trigger" },
  processors: [
    { id: "prompt", type: "template", target: "/prompt", text: "Hello" },
    { id: "ask", type: "host_llm", prompt: "/prompt", target: "/reply" },
  ],
  output: { type: "host_result", title: "T", body: "/reply" },
  limits: { llm_calls_per_run: 1, runs_per_day: 2, run_timeout: "5m" },
};
send("1", "initialize", { protocol_version: 1, clock: "host", state_dir: stateDir, capabilities: { llm: true, results: true } });
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of engine.stdout) {
  buffer += decoder.decode(chunk);
  let at: number;
  while ((at = buffer.indexOf("\n")) !== -1) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (message.id === "1") send("2", "stream.create", { pipeline });
    else if (message.id === "2") send("3", "stream.approve", { stream_id: message.result.stream_id, permissions_hash: message.result.permissions_hash });
    else if (message.id === "3") send("4", "run.trigger", { stream_id: message.result.stream_id });
    else if (message.method === "host.llm") console.log(engine.pid);
  }
}

export {};
