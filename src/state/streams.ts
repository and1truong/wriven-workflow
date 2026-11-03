// Stream manifests under <state_dir>/streams/<id>/. Run history is the host's; none of it lives here.

import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Permissions } from "../pipeline/permissions.ts";
import { readJson, writeJsonAtomic } from "./files.ts";

export type StreamStatus = "pending_approval" | "active" | "paused";

export interface PinnedPipeline {
  pipeline: any;
  permissions: Permissions;
  permissions_hash: string;
  rendered: string[];
  rendered_version: 1;
}

export interface PendingUpdate extends PinnedPipeline {
  // The status to return to when this is approved.
  resume_status: "active" | "paused";
}

export interface Manifest extends PinnedPipeline {
  stream_id: string;
  name: string;
  status: StreamStatus;
  start_paused: boolean;
  // What the person last approved, against which an update is compared; null before the first
  // approval. A narrowing update changes the fields above and leaves this alone, so going back to
  // anything inside what was approved needs no new approval.
  pinned: { permissions: Permissions; permissions_hash: string } | null;
  // A widening update waiting for approval. The fields above stay the last approved pipeline.
  pending: PendingUpdate | null;
  schedule_description?: string;
  created_at: string;
  updated_at: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newStreamId(): string {
  let id = "s_";
  for (const byte of randomBytes(16)) id += CROCKFORD[byte % 32];
  return id;
}

export interface PreviousManifest extends PinnedPipeline {
  pinned: Manifest["pinned"];
}

export class StreamStore {
  private readonly streams = new Map<string, Manifest>();

  constructor(private readonly root: string) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readJson<Manifest>(join(root, entry.name, "manifest.json"));
      if (manifest) this.streams.set(manifest.stream_id, manifest);
    }
  }

  dir(streamId: string): string {
    return join(this.root, streamId);
  }

  all(): Manifest[] {
    return [...this.streams.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  }

  get(streamId: string): Manifest | undefined {
    return this.streams.get(streamId);
  }

  save(manifest: Manifest): void {
    writeJsonAtomic(join(this.dir(manifest.stream_id), "manifest.json"), manifest);
    this.streams.set(manifest.stream_id, manifest);
  }

  previous(streamId: string): PreviousManifest | null {
    return readJson<PreviousManifest>(join(this.dir(streamId), "manifest.previous.json"));
  }

  savePrevious(streamId: string, previous: PreviousManifest): void {
    writeJsonAtomic(join(this.dir(streamId), "manifest.previous.json"), previous);
  }

  remove(streamId: string): void {
    rmSync(this.dir(streamId), { recursive: true, force: true });
    this.streams.delete(streamId);
  }
}
