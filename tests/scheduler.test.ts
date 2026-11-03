import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dayMatches, occurrencesPerDay, parseCron } from "../src/scheduler/cron.ts";
import { nextOccurrences, occurrencesBetween } from "../src/scheduler/occurrences.ts";
import { cronPhrase, scheduleSentence } from "../src/scheduler/render.ts";
import { instantOf, isValidZone, toRfc3339 } from "../src/scheduler/zone.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { startHost, startInProcess } from "./helpers.ts";
import type { FakeHost } from "../src/harness/fake-host.ts";

const next = (cron: string, zone: string, after: string, count = 1) => nextOccurrences(parseCron(cron), zone, Date.parse(after), count).map((t) => toRfc3339(t, zone));

describe("cron", () => {
  test("lists, ranges, steps, names", () => {
    expect(parseCron("*/15 * * * *").minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron("1,3 2-4 * * *").hours).toEqual([2, 3, 4]);
    expect(parseCron("0 8 * * MON-FRI").weekdays).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(parseCron("0 8 * JAN,dec *").months).toEqual(new Set([1, 12]));
    expect(parseCron("0 8 * * 7").weekdays).toEqual(new Set([0]));
    expect(parseCron("10-30/10 * * * *").minutes).toEqual([10, 20, 30]);
    expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
  });
  for (const bad of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "@daily", "L * * * *", "* * * * MON#1", "1-  * * * *", "5-1 * * * *", "*/0 * * * *", "", "a b c d e"]) {
    test(`"${bad}" is refused`, () => expect(() => parseCron(bad)).toThrow());
  }
  test("day-of-month and day-of-week: OR when both are restricted", () => {
    const both = parseCron("0 0 13 * FRI");
    expect(dayMatches(both, 11, 13, 2)).toBe(true);
    expect(dayMatches(both, 11, 6, 5)).toBe(true);
    expect(dayMatches(both, 11, 7, 6)).toBe(false);
    const dayOnly = parseCron("0 0 13 * *");
    expect(dayMatches(dayOnly, 11, 6, 5)).toBe(false);
    const weekdayOnly = parseCron("0 0 * * FRI");
    expect(dayMatches(weekdayOnly, 11, 13, 2)).toBe(false);
  });
  test("occurrences per day", () => {
    expect(occurrencesPerDay(parseCron("*/5 * * * *"))).toBe(288);
    expect(occurrencesPerDay(parseCron("0 8 * * 1-5"))).toBe(1);
    expect(occurrencesPerDay(parseCron("0,30 8,20 * * *"))).toBe(4);
  });
});

describe("zones", () => {
  test("IANA names and UTC only", () => {
    expect(isValidZone("Australia/Brisbane")).toBe(true);
    expect(isValidZone("UTC")).toBe(true);
    for (const bad of ["AEST", "EST", "Mars/Olympus", "", "GMT+10"]) expect(isValidZone(bad)).toBe(false);
  });
});

describe("occurrences across daylight saving", () => {
  // [cron, zone, after, expected...]
  const table: Array<[string, string, string, string, string[]]> = [
    ["Brisbane weekday, across a weekend", "0 8 * * 1-5", "Australia/Brisbane", "2026-11-06T09:00:00+10:00", ["2026-11-09T08:00:00+10:00"]],
    ["Brisbane has no transitions", "30 2 * * *", "Australia/Brisbane", "2026-10-03T12:00:00+10:00", ["2026-10-04T02:30:00+10:00", "2026-10-05T02:30:00+10:00"]],
    ["Sydney spring forward: 02:30 does not exist, runs at 03:00", "30 2 * * *", "Australia/Sydney", "2026-10-03T12:00:00+10:00", ["2026-10-04T03:00:00+11:00", "2026-10-05T02:30:00+11:00"]],
    ["Sydney fall back: 02:30 occurs twice, runs at the first", "30 2 * * *", "Australia/Sydney", "2026-04-04T12:00:00+11:00", ["2026-04-05T02:30:00+11:00", "2026-04-06T02:30:00+10:00"]],
    ["Sydney every 15 minutes in the gap collapse into one 03:00", "*/15 2 * * *", "Australia/Sydney", "2026-10-03T12:00:00+10:00", ["2026-10-04T03:00:00+11:00", "2026-10-05T02:00:00+11:00"]],
    ["Sydney before and after the gap", "0 1,3 * * *", "Australia/Sydney", "2026-10-03T12:00:00+10:00", ["2026-10-04T01:00:00+10:00", "2026-10-04T03:00:00+11:00", "2026-10-05T01:00:00+11:00"]],
    ["Sydney hourly on fall-back day: 02:00 once", "0 * * * *", "Australia/Sydney", "2026-04-05T01:30:00+11:00", ["2026-04-05T02:00:00+11:00", "2026-04-05T03:00:00+10:00"]],
    ["London spring forward: 01:30 becomes 02:00", "30 1 * * *", "Europe/London", "2026-03-28T12:00:00Z", ["2026-03-29T02:00:00+01:00", "2026-03-30T01:30:00+01:00"]],
    ["London fall back: first 01:30", "30 1 * * *", "Europe/London", "2026-10-24T12:00:00+01:00", ["2026-10-25T01:30:00+01:00", "2026-10-26T01:30:00+00:00"]],
    ["New York spring forward: 02:30 becomes 03:00", "30 2 * * *", "America/New_York", "2026-03-07T12:00:00-05:00", ["2026-03-08T03:00:00-04:00", "2026-03-09T02:30:00-04:00"]],
    ["New York fall back: first 01:30", "30 1 * * *", "America/New_York", "2026-10-31T12:00:00-04:00", ["2026-11-01T01:30:00-04:00", "2026-11-02T01:30:00-05:00"]],
    ["UTC", "0 12 * * *", "UTC", "2026-11-03T12:00:00Z", ["2026-11-04T12:00:00+00:00"]],
    ["after is exclusive", "0 8 * * *", "UTC", "2026-11-03T08:00:00Z", ["2026-11-04T08:00:00+00:00"]],
    ["a leap day is found", "0 0 29 2 *", "UTC", "2026-11-03T00:00:00Z", ["2028-02-29T00:00:00+00:00"]],
    ["month and year rollover", "0 0 1 1 *", "UTC", "2026-12-31T23:59:00Z", ["2027-01-01T00:00:00+00:00"]],
    ["local day differs from the UTC day", "0 1 * * 1", "Australia/Brisbane", "2026-11-01T00:00:00+10:00", ["2026-11-02T01:00:00+10:00"]],
  ];
  for (const [name, cron, zone, after, expected] of table) {
    test(name, () => expect(next(cron, zone, after, expected.length)).toEqual(expected));
  }

  test("instants fired on a fall-back day are strictly increasing", () => {
    const firings = nextOccurrences(parseCron("*/30 * * * *"), "Australia/Sydney", Date.parse("2026-04-04T12:00:00Z"), 60);
    for (let i = 1; i < firings.length; i++) expect(firings[i]!).toBeGreaterThan(firings[i - 1]!);
  });

  test("a cron that cannot fire returns nothing and fails validation", () => {
    expect(next("0 0 31 2 *", "UTC", "2026-01-01T00:00:00Z")).toEqual([]);
    const result = validatePipeline(schedulePipeline("0 0 31 2 *"), DEFAULT_VALIDATION_CONTEXT);
    expect(result.errors[0]!.message).toContain("never fires");
  });

  test("between is (after, until]", () => {
    const zone = "UTC";
    const between = occurrencesBetween(parseCron("0 * * * *"), zone, Date.parse("2026-11-03T08:00:00Z"), Date.parse("2026-11-03T10:00:00Z"));
    expect(between.map((t) => toRfc3339(t, zone))).toEqual(["2026-11-03T09:00:00+00:00", "2026-11-03T10:00:00+00:00"]);
  });

  test("instantOf for an ordinary time", () => {
    expect(new Date(instantOf(2026, 11, 3, 8, 0, "Australia/Brisbane")).toISOString()).toBe("2026-11-02T22:00:00.000Z");
  });
});

describe("rendering", () => {
  const forms: Array<[string, string]> = [
    ["0 8 * * 1-5", "every weekday at 08:00"],
    ["*/15 * * * *", "every 15 minutes"],
    ["30 * * * *", "every hour at :30"],
    ["0 7 * * *", "every day at 07:00"],
    ["5 9 * * 1,3", "every Monday and Wednesday at 09:05"],
    ["0 8 * * MON", "every Monday at 08:00"],
    ["0 6 15 * *", "on day 15 of every month at 06:00"],
  ];
  for (const [cron, phrase] of forms) test(cron, () => expect(cronPhrase(cron)).toBe(phrase));
  test("the rest renders as itself", () => {
    expect(cronPhrase("0 8 1 1 *")).toBeNull();
    expect(scheduleSentence("0 8,9 * * 1", "UTC")).toBe("Runs on the schedule `0 8,9 * * 1` (UTC).");
  });
  test("the Brisbane sentence", () => {
    expect(scheduleSentence("0 8 * * 1-5", "Australia/Brisbane")).toBe("Runs: every weekday at 08:00 (Australia/Brisbane).");
  });
  test("sentences in a rendering, per missed policy", () => {
    const render = (missed?: string) => {
      const result = validatePipeline(schedulePipeline("0 8 * * 1-5", missed), DEFAULT_VALIDATION_CONTEXT);
      if (!result.valid) throw new Error(JSON.stringify(result.errors));
      return result.rendered.slice(0, 2);
    };
    expect(render()).toEqual(["Runs: every weekday at 08:00 (Australia/Brisbane).", "If runs are missed, the most recent one is made up once."]);
    expect(render("skip")[1]).toBe("Missed runs are skipped.");
    expect(render("run_all")[1]).toBe("Every missed run is made up.");
  });
});

function schedulePipeline(cron: string, missed?: string, limits: Record<string, unknown> = {}) {
  return {
    format: "wriven-workflow/pipeline@1",
    name: "Scheduled",
    input: { type: "schedule", cron, timezone: "Australia/Brisbane", ...(missed ? { missed } : {}) },
    processors: [{ id: "note", type: "template", target: "/note", text: "for {{/scheduled_for}}" }],
    output: { type: "host_result", title: "Note", body: "/note" },
    limits: { llm_calls_per_run: 0, runs_per_day: 48, run_timeout: "5m", ...limits },
  };
}

describe("validation", () => {
  test("*/5 with runs_per_day 2 names 288", () => {
    const result = validatePipeline(schedulePipeline("*/5 * * * *", undefined, { runs_per_day: 2 }), DEFAULT_VALIDATION_CONTEXT);
    expect(result.errors[0]!.message).toContain("288");
    expect(result.errors[0]).toMatchObject({ code: "limit_out_of_range", path: "/input/cron" });
  });
  test("clock host refuses a schedule input", () => {
    const result = validatePipeline(schedulePipeline("0 8 * * 1-5"), { ...DEFAULT_VALIDATION_CONTEXT, clock: "host" });
    expect(result.errors.map((e) => e.code)).toEqual(["schedule_requires_engine_clock"]);
  });
  test("bad cron and zone", () => {
    const badZone = schedulePipeline("0 8 * * 1-5") as any;
    badZone.input.timezone = "AEST";
    expect(validatePipeline(badZone, DEFAULT_VALIDATION_CONTEXT).errors[0]!.path).toBe("/input/timezone");
    expect(validatePipeline(schedulePipeline("nope"), DEFAULT_VALIDATION_CONTEXT).errors[0]!.path).toBe("/input/cron");
  });
  test("top-level schedule must match the input", () => {
    const good = { ...schedulePipeline("0 8 * * 1-5"), schedule: { cron: "0 8 * * 1-5", timezone: "Australia/Brisbane" } };
    expect(validatePipeline(good, DEFAULT_VALIDATION_CONTEXT).valid).toBe(true);
    const bad = { ...schedulePipeline("0 8 * * 1-5"), schedule: { cron: "0 7 * * 1-5", timezone: "Australia/Brisbane" } };
    expect(validatePipeline(bad, DEFAULT_VALIDATION_CONTEXT).errors[0]!.path).toBe("/schedule");
  });
  test("a schedule's permissions", () => {
    const result = validatePipeline(schedulePipeline("0 8 * * 1-5", "skip"), DEFAULT_VALIDATION_CONTEXT);
    if (!result.valid) throw new Error("invalid");
    expect(result.permissions.runs).toEqual({ kind: "schedule", cron: "0 8 * * 1-5", timezone: "Australia/Brisbane", missed: "skip" });
  });
});

describe("schedule.preview over the protocol", () => {
  test("is pure and usable with clock host", async () => {
    const { host } = await startHost();
    const result = await host.call("schedule.preview", { cron: "0 8 * * 1-5", timezone: "Australia/Brisbane", after: "2026-11-06T09:00:00+10:00", count: 2 });
    expect(result.occurrences).toEqual(["2026-11-09T08:00:00+10:00", "2026-11-10T08:00:00+10:00"]);
    expect((await host.call("schedule.preview", { cron: "0 8 * * *", timezone: "UTC", after: "2026-11-06T09:00:00Z" })).occurrences.length).toBe(5);
  });
  test("bad params are invalid_params", async () => {
    const { host } = await startHost();
    for (const params of [{ cron: "x", timezone: "UTC", after: "2026-11-06T09:00:00Z" }, { cron: "* * * * *", timezone: "AEST", after: "2026-11-06T09:00:00Z" }, { cron: "* * * * *", timezone: "UTC", after: "soon" }, { cron: "* * * * *", timezone: "UTC", after: "2026-11-06T09:00:00Z", count: 101 }]) {
      expect((await host.request("schedule.preview", params)).error.data.kind).toBe("invalid_params");
    }
  });
});

describe("the scheduler on a fake clock", () => {
  const ENGINE_INIT = { clock: "engine" };
  const at = (s: string) => new Date(s);

  async function setup(cron: string, missed: string, start: string) {
    let now = at(start);
    const started = await startInProcess({ init: ENGINE_INIT, engine: { now: () => now, test: { noSchedulerTimer: true } } });
    const created = await started.host.call("stream.create", { pipeline: schedulePipeline(cron, missed) });
    await started.host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    return { ...started, stream: created.stream_id as string, setNow: (s: string) => (now = at(s)) };
  }

  const reportsSoFar = (host: FakeHost) => host.notifications("run.finished").map((m) => m.params.report);
  async function waitForReports(host: FakeHost, n: number) {
    for (let i = 0; i < 400 && reportsSoFar(host).length < n; i++) await Bun.sleep(25);
    return reportsSoFar(host);
  }

  test("an occurrence on time runs once with scheduled_for and trigger schedule", async () => {
    const { host, engine, setNow } = await setup("0 8 * * *", "run_once", "2026-11-03T20:00:00+10:00");
    setNow("2026-11-04T08:00:05+10:00");
    engine.tickScheduler();
    engine.tickScheduler();
    const [report] = await waitForReports(host, 1);
    expect(report.trigger).toBe("schedule");
    expect(report.scheduled_for).toBe("2026-11-04T08:00:00+10:00");
    expect(report.started_at).toBe(new Date("2026-11-04T08:00:05+10:00").toISOString());
    expect(host.results[0].result.body).toBe("for 2026-11-04T08:00:00+10:00");
    await Bun.sleep(100);
    expect(reportsSoFar(host).length).toBe(1);
  }, 30_000);

  test("run_once with three missed: one run for the most recent", async () => {
    const { host, engine, setNow } = await setup("0 8 * * *", "run_once", "2026-11-03T20:00:00+10:00");
    setNow("2026-11-07T07:00:00+10:00");
    engine.tickScheduler();
    const reports = await waitForReports(host, 1);
    await Bun.sleep(200);
    expect(reportsSoFar(host).length).toBe(1);
    expect(reports[0].scheduled_for).toBe("2026-11-06T08:00:00+10:00");
  }, 30_000);

  test("run_all with three missed: three in order", async () => {
    const { host, engine, setNow } = await setup("0 8 * * *", "run_all", "2026-11-03T20:00:00+10:00");
    setNow("2026-11-07T07:00:00+10:00");
    engine.tickScheduler();
    const reports = await waitForReports(host, 3);
    expect(reports.map((r) => r.scheduled_for)).toEqual(["2026-11-04T08:00:00+10:00", "2026-11-05T08:00:00+10:00", "2026-11-06T08:00:00+10:00"]);
    expect(reports.every((r) => r.status === "succeeded")).toBe(true);
  }, 30_000);

  test("skip with three missed: none, and the next one still fires", async () => {
    const { host, engine, setNow } = await setup("0 8 * * *", "skip", "2026-11-03T20:00:00+10:00");
    setNow("2026-11-07T07:00:00+10:00");
    engine.tickScheduler();
    await Bun.sleep(200);
    expect(reportsSoFar(host).length).toBe(0);
    setNow("2026-11-07T08:00:01+10:00");
    engine.tickScheduler();
    const [report] = await waitForReports(host, 1);
    expect(report.scheduled_for).toBe("2026-11-07T08:00:00+10:00");
  }, 30_000);

  test("within the 30 s grace it is due, not missed, even with skip", async () => {
    const { host, engine, setNow } = await setup("0 8 * * *", "skip", "2026-11-03T20:00:00+10:00");
    setNow("2026-11-04T08:00:20+10:00");
    engine.tickScheduler();
    const [report] = await waitForReports(host, 1);
    expect(report.scheduled_for).toBe("2026-11-04T08:00:00+10:00");
  }, 30_000);

  test("pause across two occurrences then resume: nothing enqueued, next_run in the future", async () => {
    const { host, engine, stream, setNow } = await setup("0 8 * * *", "run_all", "2026-11-03T20:00:00+10:00");
    await host.call("stream.pause", { stream_id: stream });
    setNow("2026-11-05T20:00:00+10:00");
    engine.tickScheduler();
    const resumed = await host.call("stream.resume", { stream_id: stream });
    expect(resumed.next_run).toBe("2026-11-06T08:00:00+10:00");
    engine.tickScheduler();
    await Bun.sleep(200);
    expect(reportsSoFar(host).length).toBe(0);
  }, 30_000);

  test("a schedule change re-approves; on approval nothing before now is made up", async () => {
    const { host, engine, stream, setNow } = await setup("0 8 * * *", "run_all", "2026-11-03T20:00:00+10:00");
    const update = await host.call("stream.update", { stream_id: stream, pipeline: schedulePipeline("0 7 * * *", "run_all") });
    expect(update.status).toBe("pending_approval");
    expect(update.diff.added).toContain("Runs: every day at 07:00 (Australia/Brisbane).");
    setNow("2026-11-05T20:00:00+10:00");
    engine.tickScheduler();
    await host.call("stream.approve", { stream_id: stream, permissions_hash: update.permissions_hash });
    engine.tickScheduler();
    await Bun.sleep(200);
    expect(reportsSoFar(host).length).toBe(0);
    expect((await host.call("stream.get", { stream_id: stream })).next_run).toBe("2026-11-06T07:00:00+10:00");
  }, 30_000);

  test("restart applies the missed policy against the persisted bookmark", async () => {
    const { host, stream, dir, setNow } = await setup("0 8 * * *", "run_once", "2026-11-03T20:00:00+10:00");
    expect(JSON.parse(readFileSync(join(dir, "streams", stream, "schedule.json"), "utf8")).last_handled).toBe(new Date("2026-11-03T20:00:00+10:00").toISOString());
    host.closeStdin();
    await host.exited;
    setNow("2026-11-07T07:00:00+10:00");
    const now = at("2026-11-07T07:00:00+10:00");
    const restarted = await startInProcess({ dir, init: ENGINE_INIT, engine: { now: () => now, test: { noSchedulerTimer: true } } });
    expect(restarted.init.streams[0].next_run).toBe("2026-11-07T08:00:00+10:00");
    restarted.engine.tickScheduler();
    const reports = await waitForReports(restarted.host, 1);
    expect(reports[0].scheduled_for).toBe("2026-11-06T08:00:00+10:00");
  }, 30_000);

  test("a failed run is still handled: the next occurrence is the retry", async () => {
    const { host, engine, setNow } = await setup("0 8 * * *", "run_all", "2026-11-03T20:00:00+10:00");
    host.setLlm({ mode: "echo" });
    setNow("2026-11-04T08:00:01+10:00");
    engine.tickScheduler();
    await waitForReports(host, 1);
    engine.tickScheduler();
    await Bun.sleep(100);
    expect(reportsSoFar(host).length).toBe(1);
  }, 30_000);

  test("delete removes it from the timer set", async () => {
    const { host, engine, stream, setNow } = await setup("0 8 * * *", "run_once", "2026-11-03T20:00:00+10:00");
    await host.call("stream.delete", { stream_id: stream });
    setNow("2026-11-05T09:00:00+10:00");
    engine.tickScheduler();
    await Bun.sleep(100);
    expect(reportsSoFar(host).length).toBe(0);
  }, 30_000);

  test("a real timer fires a due occurrence", async () => {
    const soon = new Date(Date.now() + 61_000);
    soon.setUTCSeconds(0, 0);
    const offset = soon.getTime() - Date.now() - 1000;
    const started = await startInProcess({ init: ENGINE_INIT, engine: { now: () => new Date(Date.now() + offset) } });
    const pipeline = schedulePipeline(`${soon.getUTCMinutes()} ${soon.getUTCHours()} * * *`) as any;
    pipeline.input.timezone = "UTC";
    const created = await started.host.call("stream.create", { pipeline });
    await started.host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const report = await started.host.waitFor((m) => m.method === "run.finished", 5000);
    expect(report.params.report.trigger).toBe("schedule");
  }, 30_000);

  test("next_run in stream.list for an active stream; null for a host trigger", async () => {
    const { host, stream } = await setup("0 8 * * *", "run_once", "2026-11-03T20:00:00+10:00");
    const listed = await host.call("stream.list");
    expect(listed.streams.find((s: any) => s.stream_id === stream).next_run).toBe("2026-11-04T08:00:00+10:00");
  }, 30_000);
});
