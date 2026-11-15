import { and, eq, gte, inArray } from "drizzle-orm";
import { requireUser } from "../auth.js";
import { fail, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import type { GenerationMetrics } from "../db/schema.js";
import { earningsOf } from "./play.js";

const { generations } = schema;

/**
 * Build insights for graphs ("is the engine improving?"), from the harness's per-job `metrics`
 * events stored on generations.metrics. A build = a generation that finished (succeeded or failed)
 * inside the window, bucketed by finishedAt (UTC day). Averages only count builds that reported
 * metrics (and, for artScore, that were reviewed); they are null when nothing qualifies.
 *
 *   GET /v1/me/insights?days=30       — the caller's builds (+ `earnings`, §11.6)
 *   GET /v1/insights/engine?days=30   — all builds, aggregated (no per-user data)
 */
export function insightsRoutes({ db, config }: Deps) {
  const r = router();
  r.use("/v1/me/insights", requireUser(config));
  r.use("/v1/insights/*", requireUser(config));

  const load = async (days: number, userId?: string) => {
    const since = startOfUtcDay(new Date(Date.now() - (days - 1) * 86_400_000));
    const rows = await db.select({ status: generations.status, finishedAt: generations.finishedAt, metrics: generations.metrics })
      .from(generations)
      .where(and(
        inArray(generations.status, ["succeeded", "failed"]),
        gte(generations.finishedAt, since),
        ...(userId ? [eq(generations.userId, userId)] : []),
      ));
    return aggregate(rows, since, days);
  };

  // The caller's insights also carry their creator earnings (same shape as GET /v1/me/earnings).
  r.get("/v1/me/insights", async (c) => {
    const userId = c.get("userId");
    const [builds, earnings] = await Promise.all([load(parseDays(c.req.query("days")), userId), earningsOf(db, userId)]);
    return c.json({ ...builds, earnings });
  });
  r.get("/v1/insights/engine", async (c) => c.json(await load(parseDays(c.req.query("days")))));
  return r;
}

function parseDays(v: string | undefined): number {
  if (v === undefined || v === "") return 30;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) fail(400, "days must be an integer 1–365");
  return n;
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

type Row = { status: string; finishedAt: Date | null; metrics: GenerationMetrics | null };

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const avg = (xs: number[], places = 2) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, places) : null);
const pct = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100, 1) : null);

function summarize(rows: Row[]) {
  const m = rows.map((r) => r.metrics).filter((x): x is GenerationMetrics => !!x);
  const reused = m.reduce((a, x) => a + x.spritesReused, 0);
  const drawn = m.reduce((a, x) => a + x.spritesDrawn, 0);
  return {
    builds: rows.length,
    succeeded: rows.filter((r) => r.status === "succeeded").length,
    failed: rows.filter((r) => r.status === "failed").length,
    avgArtScore: avg(m.map((x) => x.artScore).filter((s): s is number => s != null)),
    avgCostUsd: avg(m.map((x) => x.costUsd), 4),
    avgMinutes: avg(m.map((x) => x.minutes)),
    avgMemoryHits: avg(m.map((x) => x.memoryHits)),
    /** spritesReused / (spritesReused + spritesDrawn) × 100 */
    spritesReusedPct: pct(reused, reused + drawn),
    _m: m, _reused: reused, _drawn: drawn,
  };
}

export function aggregate(rows: Row[], since: Date, days: number) {
  const byDay = new Map<string, Row[]>();
  for (let i = 0; i < days; i++) byDay.set(dayKey(new Date(since.getTime() + i * 86_400_000)), []);
  for (const r of rows) if (r.finishedAt) byDay.get(dayKey(r.finishedAt))?.push(r);

  const daily = [...byDay].map(([date, rs]) => {
    const { _m, _reused, _drawn, ...s } = summarize(rs);
    void _m; void _reused; void _drawn;
    return { date, ...s };
  });

  const kits = new Map<string, GenerationMetrics[]>();
  for (const r of rows) {
    if (!r.metrics) continue;
    const k = r.metrics.kit ?? "none";
    kits.set(k, [...(kits.get(k) ?? []), r.metrics]);
  }
  const byKit = [...kits].map(([kit, ms]) => ({
    kit,
    builds: ms.length,
    avgArtScore: avg(ms.map((x) => x.artScore).filter((s): s is number => s != null)),
    avgCostUsd: avg(ms.map((x) => x.costUsd), 4),
  })).sort((a, b) => b.builds - a.builds || a.kit.localeCompare(b.kit));

  const { _m, _reused, _drawn, ...t } = summarize(rows);
  const totals = {
    ...t,
    successRatePct: pct(t.succeeded, t.builds),
    withMetrics: _m.length,
    totalCostUsd: round(_m.reduce((a, x) => a + x.costUsd, 0), 4),
    memoryHits: _m.reduce((a, x) => a + x.memoryHits, 0),
    spritesReused: _reused,
    spritesDrawn: _drawn,
    runtimeErrorsFixed: _m.reduce((a, x) => a + x.runtimeErrorsFixed, 0),
    finalGateFirstTryPct: pct(_m.filter((x) => x.finalGatePassedFirstTry === true).length, _m.filter((x) => x.finalGatePassedFirstTry != null).length),
  };
  return { days, since: dayKey(since), daily, byKit, totals };
}
