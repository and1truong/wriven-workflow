// THIRD_PARTY_NOTICES.md: every package in the lockfile with its license, and a failure for any license
// outside the allowlist. Run by the release script.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const LICENSE_ALLOWLIST = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "0BSD"]);

export interface PackageNotice {
  name: string;
  version: string;
  license: string;
}

export function lockfilePackages(repo: string): string[] {
  // bun.lock is JSON with trailing commas.
  const text = readFileSync(join(repo, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1");
  return Object.keys(JSON.parse(text).packages ?? {}).sort();
}

export function readNotices(repo: string): PackageNotice[] {
  return lockfilePackages(repo).map((name) => {
    const manifest = JSON.parse(readFileSync(join(repo, "node_modules", name, "package.json"), "utf8"));
    return { name, version: String(manifest.version), license: typeof manifest.license === "string" ? manifest.license : "UNKNOWN" };
  });
}

export function disallowed(notices: PackageNotice[]): PackageNotice[] {
  return notices.filter((n) => !LICENSE_ALLOWLIST.has(n.license));
}

export function renderNotices(notices: PackageNotice[], bunVersion: string): string {
  const rows = notices.map((n) => `| ${n.name} | ${n.version} | ${n.license} | build only |`);
  return `# Third-party notices

The executable contains the Bun runtime ${bunVersion} (MIT, https://bun.com), which itself bundles other open-source software; its own notices are at https://github.com/oven-sh/bun/blob/main/LICENSE.md.

It contains no other runtime dependency: every package in the lockfile below is used only to type-check this repository and none of its code is in the executable.

| Package | Version | License | Use |
| --- | --- | --- | --- |
${rows.join("\n")}
`;
}
