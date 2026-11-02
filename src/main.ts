// One binary, several entry points selected by the first argument.

import { doctorMain } from "./doctor.ts";
import { serve } from "./engine/serve.ts";
import { runMain } from "./executor/run-main.ts";
import { fakeHostMain } from "./harness/fake-host-cli.ts";
import { validateMain } from "./pipeline/validate-cli.ts";
import { versionInfo } from "./version.ts";

const USAGE = "usage: wriven-workflow serve | validate <file> | fake-host [--conformance <dir>] | doctor | --version";

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "serve":
      await serve();
      return 0;
    case "--run":
      await runMain();
      return 0;
    case "validate":
      return validateMain(rest);
    case "fake-host":
      return fakeHostMain(rest);
    case "doctor":
      return doctorMain();
    case "--version":
      console.log(JSON.stringify(versionInfo()));
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

process.exit(await main(process.argv.slice(2)));
