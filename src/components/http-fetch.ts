// `http_fetch`: GET per URL, literal URLs only, through the engine's proxy. Runs in the run process.

import { hostOfUrl, urlProblem } from "../pipeline/urls.ts";
import { parseDuration } from "../pipeline/duration.ts";
import { StepError, type Message } from "../executor/messages.ts";
import { ENGINE_VERSION } from "../version.ts";
import type { Processor, StepContext } from "./runtime.ts";

const CONCURRENCY = 4;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT = "30s";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface FetchedResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface FetchRequest {
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}

// The way out of the run process: the proxy, or the fixtures in a test.
export type Fetcher = (url: string, request: FetchRequest) => Promise<FetchedResponse>;

export interface ProxyTarget {
  port: number;
  token: string;
}

export const DENIED_HEADER = "x-wriven-proxy-denied";

export function proxyFetcher(proxy: ProxyTarget, tlsCa?: string): Fetcher {
  return async (url, { headers, signal, maxBytes }) => {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal,
      redirect: "manual",
      proxy: `http://run:${proxy.token}@127.0.0.1:${proxy.port}`,
      ...(tlsCa ? { tls: { ca: tlsCa } } : {}),
    } as RequestInit);
    if (response.headers.get(DENIED_HEADER) === proxy.token) {
      throw new StepError("permission_denied", `The proxy refused ${hostOfUrl(url)}: it is not in this stream's permissions.`, { host: hostOfUrl(url) });
    }
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => (out[key.toLowerCase()] = value));
    return { status: response.status, headers: out, body: await readCapped(response, url, maxBytes) };
  };
}

async function readCapped(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maxBytes) throw new StepError("body_too_large", `${url} is larger than the limit of ${maxBytes} bytes.`);
      chunks.push(chunk);
    }
  }
  return Bun.concatArrayBuffers(chunks, Infinity, true);
}

function charsetOf(contentType: string, bytes: Uint8Array): string {
  const declared = /charset=["']?([^"';\s]+)/i.exec(contentType)?.[1];
  if (declared) return declared;
  const start = new TextDecoder("latin1" as "utf-8").decode(bytes.subarray(0, 200));
  return /^\s*<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(start)?.[1] ?? "utf-8";
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType, bytes) as "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function retryable(err: unknown): boolean {
  if (!(err instanceof StepError)) return false;
  if (err.kind === "fetch_failed" || err.kind === "fetch_timeout") return true;
  const status = err.extras.status as number | undefined;
  return err.kind === "http_status" && (status === undefined || status >= 500 || status === 429);
}

async function fetchOne(url: string, config: any, ctx: StepContext): Promise<{ finalUrl: string; response: FetchedResponse }> {
  const fetcher = ctx.fetcher;
  if (!fetcher) throw new StepError("internal", "This run has no way to fetch.");
  const allowed = new Set<string>((config.urls as string[]).map(hostOfUrl));
  const timeout = parseDuration(config.timeout ?? DEFAULT_TIMEOUT);
  const headers = { "user-agent": `wriven-workflow/${ENGINE_VERSION}`, accept: "*/*", ...config.headers };
  let current = url;
  for (let hop = 0; ; hop++) {
    const problem = urlProblem(current);
    if (problem) throw new StepError("url_not_allowed", problem, { host: safeHost(current) });
    const host = hostOfUrl(current);
    if (!allowed.has(host) && !ctx.bypassAllowlistCheck) {
      ctx.denied(host);
      throw new StepError("permission_denied", `${current} is on ${host}, which is not in this stream's permissions.`, { host });
    }
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]);
    let response: FetchedResponse;
    try {
      response = await fetcher(current, { headers, signal, maxBytes: config.max_bytes ?? DEFAULT_MAX_BYTES });
    } catch (err) {
      if (err instanceof StepError) {
        if (err.kind === "permission_denied") ctx.denied(host);
        throw err;
      }
      if (ctx.signal.aborted) throw new StepError("cancelled", "The run was cancelled.");
      if ((err as Error).name === "TimeoutError" || signal.aborted) throw new StepError("fetch_timeout", `${current} did not answer within ${config.timeout ?? DEFAULT_TIMEOUT}.`);
      throw new StepError("fetch_failed", `${current} could not be fetched: ${(err as Error).message}`);
    }
    ctx.network(host, response.body.length);
    if (REDIRECTS.has(response.status) && response.headers.location) {
      if (hop >= MAX_REDIRECTS) throw new StepError("http_status", `${url} redirected more than ${MAX_REDIRECTS} times.`, { status: response.status });
      current = new URL(response.headers.location, current).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new StepError("http_status", `${current} returned ${response.status}`, { status: response.status });
    }
    return { finalUrl: current, response };
  }
}

function safeHost(text: string): string | undefined {
  try {
    return hostOfUrl(text);
  } catch {
    return undefined;
  }
}

async function fetchWithRetry(url: string, config: any, ctx: StepContext, messageId: string): Promise<{ finalUrl: string; response: FetchedResponse }> {
  const attempts = config.retry?.max_attempts ?? 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOne(url, config, ctx);
    } catch (err) {
      if (attempt >= attempts || !retryable(err) || ctx.signal.aborted) throw err;
      ctx.warn(messageId, "fetch_retry", `Attempt ${attempt} of ${attempts} for ${url} failed and will be tried again: ${(err as Error).message}`);
      await Bun.sleep(parseDuration(config.retry.backoff ?? "1s"));
    }
  }
}

export const httpFetch: Processor = async (config, batch, ctx) => {
  const out: Message[] = [];
  for (const message of batch) {
    const urls = config.urls as string[];
    const results = new Array<Message | null>(urls.length).fill(null);
    let next = 0;
    let failure: unknown = null;
    const worker = async () => {
      while (next < urls.length && failure === null) {
        const index = next++;
        const url = urls[index]!;
        const id = `${message.id}.${index}`;
        try {
          const { response } = await fetchWithRetry(url, config, ctx, id);
          const contentType = response.headers["content-type"] ?? "";
          results[index] = {
            id,
            data: { url, status: response.status, headers: response.headers, body: decodeBody(response.body, contentType), content_type: contentType },
            meta: { ...message.meta, source_url: url },
          };
        } catch (err) {
          const cancelled = ctx.signal.aborted || (err instanceof StepError && err.kind === "cancelled");
          if (config.on_error === "skip" && err instanceof StepError && !cancelled) {
            ctx.warn(id, err.kind, err.message);
            continue;
          }
          failure ??= err instanceof StepError ? new StepError(err.kind, err.message, { ...err.extras, message_id: id }) : err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
    if (failure !== null) throw failure;
    for (const result of results) if (result) out.push(result);
  }
  return out;
};
