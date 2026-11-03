// The v0 documents must keep their permission hashes as components are added: an approved stream
// whose hash changed would need approving again for nothing. Hashes computed at f68ae62 (v0).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { REPO } from "./helpers.ts";

const V0_HASHES: Record<string, string> = {
  "feed-digest.json": "sha256:ac21304ad337a654d87728ec6e60b4e7e9b26ade02480952465155793b6e0282",
  "trigger-drop.json": "sha256:02e421332af9ebc77c85fa9eb9e358cfaf2b225706baf2ce6c0d20a2b021f448",
  "trigger-template-result.json": "sha256:9d4caa01eeb5a6f6c6e7415ddde0bd733d1d1b0fd2d43c87e2a6f54044dc00ab",
};

describe("v0 stability", () => {
  for (const [file, hash] of Object.entries(V0_HASHES)) {
    test(`${file} keeps its v0 permissions hash`, () => {
      const result = validatePipeline(JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid", file), "utf8")), DEFAULT_VALIDATION_CONTEXT);
      if (!result.valid) throw new Error(JSON.stringify(result.errors));
      expect(result.permissions_hash).toBe(hash);
    });
  }
});
