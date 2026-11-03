// The egress proxy: one per run, on 127.0.0.1, with the run's allowlist and a per-run token. It answers
// CONNECT host:443 for listed hosts and refuses the rest. It never looks inside TLS.

import { lookup } from "node:dns/promises";
import type { Socket } from "bun";
import { isPrivateAddress } from "../pipeline/urls.ts";

const MAX_HEADER_BYTES = 8192;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

export interface ProxyOptions {
  allowedHosts: string[];
  token: string;
  // Tests point allowed names at a local fixture server; otherwise names resolve through DNS.
  dial?(host: string): { hostname: string; port: number };
}

export interface RunProxy {
  port: number;
  denied: string[];
  hosts: string[];
  stop(): void;
}

interface Connection {
  header: Uint8Array[];
  headerBytes: number;
  upstream: Socket<any> | null;
  // Bytes a socket did not take yet, per direction.
  toUpstream: Uint8Array[];
  toClient: Uint8Array[];
  queued: number;
  tunnelling: boolean;
}

function refuse(socket: Socket<Connection>, status: string, extra = ""): void {
  socket.write(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  socket.end();
}

function flush(socket: Socket<any>, queue: Uint8Array[]): void {
  while (queue.length > 0) {
    const chunk = queue[0]!;
    const written = socket.write(chunk);
    if (written < chunk.length) {
      queue[0] = chunk.subarray(written);
      return;
    }
    queue.shift();
  }
}

function send(state: Connection, socket: Socket<any> | null, queue: Uint8Array[], data: Uint8Array): boolean {
  queue.push(data.slice());
  state.queued = queue.reduce((sum, c) => sum + c.length, 0);
  if (state.queued > MAX_QUEUED_BYTES) return false;
  if (socket) flush(socket, queue);
  return true;
}

export function startProxy(options: ProxyOptions): RunProxy {
  const allowed = new Set(options.allowedHosts);
  const expectedAuth = `Basic ${Buffer.from(`run:${options.token}`).toString("base64")}`;
  const denied: string[] = [];
  const hosts = new Set<string>();
  const sockets = new Set<Socket<any>>();
  const deny = (socket: Socket<Connection>, host: string, why: string) => {
    if (!denied.includes(host)) denied.push(host);
    // The token proves this refusal came from us and not from a server through the tunnel.
    refuse(socket, "403 Forbidden", `X-Wriven-Proxy-Denied: ${options.token}\r\nX-Wriven-Proxy-Reason: ${why}\r\n`);
  };

  const openTunnel = async (socket: Socket<Connection>, host: string, leftover: Uint8Array) => {
    let target: { hostname: string; port: number };
    if (options.dial) {
      target = options.dial(host);
    } else {
      let addresses: Array<{ address: string }>;
      try {
        addresses = await lookup(host, { all: true });
      } catch {
        refuse(socket, "502 Bad Gateway");
        return;
      }
      // Checked here and dialled by address, so a name cannot resolve one way now and another later.
      if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
        deny(socket, host, "private-address");
        return;
      }
      target = { hostname: addresses[0]!.address, port: 443 };
    }
    const state = socket.data;
    try {
      await Bun.connect<null>({
        hostname: target.hostname,
        port: target.port,
        data: null,
        socket: {
          open(upstream) {
            sockets.add(upstream);
            state.upstream = upstream;
            state.tunnelling = true;
            hosts.add(host);
            socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
            if (leftover.length > 0) send(state, upstream, state.toUpstream, leftover);
            flush(upstream, state.toUpstream);
          },
          data(_upstream, data) {
            if (!send(state, socket, state.toClient, data)) socket.terminate();
          },
          drain(upstream) {
            flush(upstream, state.toUpstream);
          },
          close(upstream) {
            sockets.delete(upstream);
            socket.end();
          },
          error() {
            socket.end();
          },
          connectError() {
            refuse(socket, "502 Bad Gateway");
          },
        },
      });
    } catch {
      refuse(socket, "502 Bad Gateway");
    }
  };

  const server = Bun.listen<Connection>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        sockets.add(socket);
        socket.data = { header: [], headerBytes: 0, upstream: null, toUpstream: [], toClient: [], queued: 0, tunnelling: false };
      },
      data(socket, data) {
        const state = socket.data;
        if (state.tunnelling) {
          if (!send(state, state.upstream, state.toUpstream, data)) socket.terminate();
          return;
        }
        // Between CONNECT and the upstream opening, bytes wait in the queue.
        if (state.upstream === null && state.headerBytes === -1) {
          send(state, null, state.toUpstream, data);
          return;
        }
        state.header.push(data.slice());
        state.headerBytes += data.length;
        const bytes = Bun.concatArrayBuffers(state.header, Infinity, true);
        const end = findHeaderEnd(bytes);
        if (end === -1) {
          if (state.headerBytes > MAX_HEADER_BYTES) refuse(socket, "431 Request Header Fields Too Large");
          return;
        }
        state.headerBytes = -1;
        const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\r\n");
        const [method, authority] = (lines[0] ?? "").split(" ");
        if (method !== "CONNECT" || !authority) {
          refuse(socket, "405 Method Not Allowed");
          return;
        }
        const auth = lines.slice(1).find((l) => /^proxy-authorization:/i.test(l))?.replace(/^[^:]*:\s*/, "");
        if (auth !== expectedAuth) {
          refuse(socket, "407 Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="wriven-workflow"\r\n');
          return;
        }
        const match = /^([^:]+):443$/.exec(authority);
        const host = (match?.[1] ?? authority).toLowerCase();
        if (!match || !allowed.has(host)) {
          deny(socket, host, "not-listed");
          return;
        }
        void openTunnel(socket, host, bytes.subarray(end + 4));
      },
      drain(socket) {
        flush(socket, socket.data.toClient);
      },
      close(socket) {
        sockets.delete(socket);
        socket.data.upstream?.end();
      },
      error() {},
    },
  });

  return {
    port: server.port,
    denied,
    get hosts() {
      return [...hosts];
    },
    stop() {
      for (const socket of sockets) socket.terminate();
      server.stop(true);
    },
  };
}

function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}
