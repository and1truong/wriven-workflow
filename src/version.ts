// Versions the binary reports. Protocol, format and report versions are separate integers
// from the engine's semantic version; see .agents/specs/packaging-and-release.md.

declare const BUILD_COMMIT: string | undefined;

export const ENGINE_NAME = "wriven-workflow";
export const ENGINE_VERSION = "0.1.0";
export const PROTOCOL_VERSIONS = [1];
export const PIPELINE_FORMAT = "wriven-workflow/pipeline@1";
export const PIPELINE_FORMATS = [PIPELINE_FORMAT];
export const REPORT_VERSION = 1;

export function target(): string {
  return `${process.platform}-${process.arch}`;
}

export function versionInfo() {
  return {
    engine: ENGINE_VERSION,
    protocol_versions: PROTOCOL_VERSIONS,
    pipeline_formats: PIPELINE_FORMATS,
    report_version: REPORT_VERSION,
    runtime: `bun ${Bun.version}`,
    target: target(),
    commit: typeof BUILD_COMMIT === "string" ? BUILD_COMMIT : "unknown",
  };
}
