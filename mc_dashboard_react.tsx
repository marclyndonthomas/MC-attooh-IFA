import { useState, useEffect, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { DNA_MODELS, INFLATION_ASSUMPTION } from "./models/dnaModels";
import type { DnaModel } from "./models/dnaModels";
import { MONARCH_MODELS } from "./models/monarchModels";
import type { MonarchModel } from "./models/monarchModels";

// Chart.js is loaded at runtime from a CDN (see the useEffect below), not as an npm
// dependency, so it arrives as a global rather than an import.
declare global {
  interface Window { Chart: any }
}

/** A one-off lump sum paid into the portfolio in a given year. */
interface Lump { id: number; amount: number; year: number }

/**
 * The two ranges carry their cost on differently-named fields, so narrow on the field
 * itself rather than on the selected range — the shape is the source of truth.
 */
const isMonarchModel = (m: DnaModel | MonarchModel): m is MonarchModel =>
  "totalEffectiveCost" in m;

/** The model's own annual cost: Monarch's all-in effective cost, or DNA's TER. */
const modelCostOf = (m: DnaModel | MonarchModel): number =>
  isMonarchModel(m) ? m.totalEffectiveCost : m.ter;

/** Per-percentile figures, keyed the same way across depletion/real/CAGR outputs. */
interface ByPercentile<T> { p5: T; p50: T; p75: T; p95: T; linear: T }

/** Guardrail diagnostics — only present when the guardrail rule is active. */
interface GuardStats {
  band: number;
  avgFreezes: number;
  avgFreezesOnSuccess: number;
  pctSuccessNoGuard: number;
  pctPathsEverFrozen: number;
  freezeByYear: number[];
  peakFreezeYear: number;
}

/**
 * Sandidge's "vital signs" for one path at one year end. All are cumulative rather than
 * point-in-time, which is what lets them measure built-up momentum — the thing a
 * single-year rule like the guardrail cannot see.
 */
interface VitalSigns {
  yr: number;
  negYears: number;    // years with a negative market return, cumulative
  bigLosses: number;   // years with a loss of 5% or worse, cumulative
  overdrawn: number;   // years where withdrawal + fees exceeded the return, cumulative
  ncav: number;        // years the account value fell, cumulative
  moro: number;        // momentum ratio %: negative account-value changes / positive
  aer: number;         // annualised erosion rate, as a fraction
  distRate: number;    // current withdrawal as % of balance
  sd: number;          // semi-deviation of returns below zero, %
  scav: number;        // semi-deviation of account-value changes below zero, %
}

/** One row of the year-N diagnostic: the reading, its target, and its failure rate. */
interface HealthRow {
  key: string;
  label: string;
  goal: string;
  value: string;
  failRate: number | null;
  ok: boolean;
}

/**
 * Portfolio-health diagnostic derived from the simulated paths. Everything is precomputed
 * for every year so the year selector is a pure display control — moving it must not
 * trigger another simulation run.
 */
interface HealthStats {
  rowsByYear: HealthRow[][];        // indexed by year; [0] is empty
  afrByYear: (number | null)[];     // average failure rate for the median path, 0-1
  moroByYear: number[];             // momentum ratio % for the median path
  afrSurvived: (number | null)[];   // mean AFR by year, paths that survived
  afrDepleted: (number | null)[];   // mean AFR by year, paths that depleted
  maxYear: number;
}

/** One metric card: label, value, sub-label, colour, depletion date, real value, CAGR. */
type MetricCard = [string, string, string, string, string | null, number | null, number | null];

/** Everything one simulation run produces, as consumed by the charts and cards. */
interface SimResults {
  p5: number; p50: number; p75: number; p95: number;
  pctSuccess: number; pctBeat: number; pctRuined: number;
  totalIn: number;
  p5a: number[]; p50a: number[]; p75a: number[]; p95a: number[];
  w5a: number[]; w50a: number[]; w75a: number[]; w95a: number[];
  linPort: number[]; linW: number[];
  dep: ByPercentile<string | null>;
  real: ByPercentile<number>;
  avgReturn: ByPercentile<number | null>;
  labels: string[];
  avgInc: string; avgSkip: string; finalContrib: number;
  expectedBalance: number[];
  guard: GuardStats | null;
  health: HealthStats | null;
}

const COLORS = { p95: "#8B5CF6", p90: "#378ADD", p50: "#1D9E75", p10: "#D85A30", linear: "#f59e0b" };

function fmt(v: number) {
  if (v >= 1e6) return "R" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "R" + (v / 1e3).toFixed(0) + "k";
  return "R" + Math.round(v);
}

function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let uid = 0;

export default function App() {
  const [init, setInit]               = useState(1000000);
  const [contrib, setContrib]         = useState(0);
  const [contribEsc, setContribEsc]   = useState(0);
  const [withdraw, setWithdraw]       = useState(0);
  const [escMode, setEscMode]         = useState("none");
  const [customEsc, setCustomEsc]     = useState(5);
  const [skipMode, setSkipMode]       = useState("none");
  const [skipEvery, setSkipEvery]     = useState(3);
  const [guardBand, setGuardBand]     = useState(90);           // % of the expected-balance trajectory below which the guardrail arms
  const [healthYear, setHealthYear]   = useState(5);            // year the health diagnostic reports on (Sandidge's worked example is year 5)
  const [healthThreshold, setHealthThreshold] = useState(50);   // % odds of failing above which the health rule freezes the increase
  const [ret, setRet]                 = useState(8);
  const [vol, setVol]                 = useState(15);
  const [years, setYears]             = useState(20);
  const [sims, setSims]               = useState(2000);
  const [inflation, setInflation]     = useState(5.0);
  const [adviceFee, setAdviceFee]     = useState(0.5);          // %/yr — ongoing advisor fee, deducted from expected return
  const [platformFee, setPlatformFee] = useState(0.5);          // %/yr — LISP/platform/product fee, on top of the model's own cost, deducted from expected return
  const otherFees = adviceFee + platformFee;
  const [modelRange, setModelRange]   = useState("dna");         // "dna" | "monarch" — which preset list is shown
  const [modelKey, setModelKey]       = useState("");            // selected model preset within modelRange ("" = custom)
  const [lumps, setLumps]             = useState<Lump[]>([]);
  const [results, setResults]         = useState<SimResults | null>(null);
  const [chartReady, setChartReady]   = useState(false);
  const c1Ref = useRef<HTMLCanvasElement | null>(null); const c1Inst = useRef<any>(null);
  const c2Ref = useRef<HTMLCanvasElement | null>(null); const c2Inst = useRef<any>(null);

  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
    s.onload = () => setChartReady(true);
    document.head.appendChild(s);
  }, []);

  const effEsc = escMode === "none" ? 0 : customEsc;
  const wr = init > 0 ? (withdraw * 12 / init * 100) : 0;

  // Model presets — return + volatility linked to the model-portfolio spreadsheet
  // (models/dnaModels.ts + models/monarchModels.ts, regenerated via `npm run sync-models`).
  // Keys are only unique WITHIN a range (e.g. both ranges have an "income" model), so every
  // lookup below is scoped to modelRange — never search across both lists by key alone.
  const modelList = modelRange === "monarch" ? MONARCH_MODELS : DNA_MODELS;

  const applyRange = (range: string) => {
    setModelRange(range);
    setModelKey(""); // switching range always falls back to custom until a new model is picked
  };
  const applyModel = (key: string) => {
    setModelKey(key);
    const m = modelList.find(x => x.key === key);
    if (!m) return;
    setRet(m.nominalReturn);
    setVol(m.vol);
    setInflation(INFLATION_ASSUMPTION);
  };
  const activeModel = modelList.find(x => x.key === modelKey) || null;
  const modelMatches = !!activeModel
    && ret === activeModel.nominalReturn
    && vol === activeModel.vol
    && inflation === INFLATION_ASSUMPTION;

  const runSim = useCallback(() => {
    const months = years * 12;
    const netRet = ret - otherFees; // other fees (advice/platform/etc.) reduce the return actually earned
    const muM = netRet / 100 / 12;
    const sigM = vol / 100 / Math.sqrt(12);
    const N = sims;
    const wEsc = effEsc / 100;
    const cEsc = contribEsc / 100;

    const lumpMap: Record<number, number> = {};
    lumps.forEach((l: any) => { const k = l.year * 12; lumpMap[k] = (lumpMap[k] || 0) + l.amount; });

    // Guardrail: fixed "expected balance trajectory", computed ONCE at plan inception.
    // Deterministic projection at the net return, with withdrawals always escalating at the
    // full plan rate. It is never re-baselined against actual paths and never sees a freeze —
    // it is the static yardstick the guardrail measures against for the life of the plan.
    const guardOn = skipMode === "guard" && wEsc > 0;
    const healthRuleOn = skipMode === "health" && wEsc > 0;
    const comparingOn = guardOn || healthRuleOn;   // rules that report a with/without lift
    const bandFrac = guardBand / 100;

    // Set once calibration has run. Null while calibrating, which is what keeps the health
    // rule from feeding on itself: the odds it consults come from paths that never used it.
    let afrLookup: ((s: VitalSigns) => number | null) | null = null;
    const expectedBalance = (() => {
      let val = init, curW = withdraw, curC = contrib;
      const arr = [val];
      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          if (wEsc > 0) curW *= (1 + wEsc);
          if (cEsc > 0) curC *= (1 + cEsc);
        }
        if (lumpMap[m]) val += lumpMap[m];
        val = val * (1 + muM) + curC - curW;
        if (val < 0) val = 0;
        if ((m + 1) % 12 === 0) arr.push(val);
      }
      return arr;
    })();

    // Run one path's returns under a chosen escalation policy.
    // applyRule=false never freezes — that is both the calibration pass and the no-rule
    // baseline the with/without comparison is measured against.
    // needSigns records Sandidge's vital signs at each year end, for the diagnostic and,
    // when the health rule is active, for the freeze decision itself.
    const runOnePath = (monthlyReturns: number[], applyRule: boolean, needSigns = false) => {
      let val = init, curW = withdraw, curC = contrib, yrStart = init;
      const path = [val], wpath = [curW];
      const freezeYears = [];
      let skips = 0, incs = 0;

      // Running vital-sign accumulators (all cumulative — that is the point of momentum).
      let negYears = 0, bigLosses = 0, overdrawn = 0, ncav = 0;
      let sumNegCav = 0, sumPosCav = 0, sumSqNegRet = 0, sumSqNegCav = 0;
      const signs: VitalSigns[] = [];
      const track = needSigns || skipMode === "health";

      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          const yr = m / 12;   // year `yr` just completed; val = balance at end of that year

          // That year's market return, compounded from its 12 monthly draws. This is the
          // market's return, deliberately not the change in account value — withdrawals
          // would otherwise make a positive-return year read as negative.
          let g = 1;
          for (let k = (yr - 1) * 12; k < yr * 12; k++) g *= (1 + monthlyReturns[k]);
          const yearReturn = g - 1;
          const belowTrajectory = val < bandFrac * expectedBalance[yr];

          let current: VitalSigns | null = null;
          if (track) {
            const cav = yrStart > 0 ? (val - yrStart) / yrStart : 0;
            if (yearReturn < 0) { negYears++; sumSqNegRet += yearReturn * yearReturn; }
            if (yearReturn <= -0.05) bigLosses++;
            if (cav < 0) { ncav++; sumNegCav += -cav; sumSqNegCav += cav * cav; } else sumPosCav += cav;
            const distRate = val > 0 ? (curW * 12) / val * 100 : Infinity;
            if (distRate / 100 + otherFees / 100 > yearReturn) overdrawn++;
            current = {
              yr, negYears, bigLosses, overdrawn, ncav,
              moro: sumPosCav > 0 ? (sumNegCav / sumPosCav) * 100 : (sumNegCav > 0 ? 999 : 0),
              aer: Math.pow(Math.max(val, 1) / init, 1 / yr) - 1,
              distRate,
              sd: Math.sqrt(sumSqNegRet / yr) * 100,
              scav: Math.sqrt(sumSqNegCav / yr) * 100,
            };
            if (needSigns) signs.push(current);
          }

          if (wEsc > 0) {
            let skip;
            if (skipMode === "guard") {
              // Freeze only when BOTH hold.
              skip = applyRule && belowTrajectory && yearReturn < 0;
              if (skip) freezeYears.push(yr);
            } else if (skipMode === "health") {
              // Freeze while the odds of ending below 40% of capital sit above the
              // threshold. afrLookup is null during calibration, so those paths stay unruled.
              const a = applyRule && afrLookup && current ? afrLookup(current) : null;
              skip = a !== null && a > healthThreshold / 100;
              if (skip) freezeYears.push(yr);
            } else {
              const neg = yrStart > 0 && (val - yrStart) / yrStart < 0;
              skip = skipMode === "negative" ? neg : skipMode === "fixed" ? (yr % skipEvery === 0) : false;
            }
            // No catch-up: a frozen year's increase is permanently forgone, not banked.
            if (skip) skips++; else { curW *= (1 + wEsc); incs++; }
          }
          if (cEsc > 0) curC *= (1 + cEsc);
          yrStart = val;
          wpath.push(curW);
        } else if (m === 0) {
          yrStart = val;
        }
        if (lumpMap[m]) val += lumpMap[m];
        val = val * (1 + monthlyReturns[m]) + curC - curW;
        if (val < 0) val = 0;
        if ((m + 1) % 12 === 0) path.push(val);
      }
      return { final: val, path, wpath, freezeYears, skips, incs, signs };
    };

    // Each path draws independently, so results carry both an uncertain realised
    // average return and sequence-of-returns risk.
    const genReturns = () =>
      Array.from({ length: months }, () => muM + sigM * randn());

    const finals: number[] = [], paths: number[][] = [], wpaths: number[][] = [];
    let totSkip = 0, totInc = 0;
    let totFreeze = 0, freezeOnSuccess = 0, successCount = 0, baseSuccess = 0, pathsFrozen = 0;
    const freezeByYear: number[] = Array(years + 1).fill(0);

    // Health diagnostic only means anything once money is coming out.
    const healthOn = withdraw > 0;

    // ---- Calibration: what happens to a plan like this if nothing is adjusted ----
    // Always run unruled. That keeps the health rule honest (it cannot consult odds derived
    // from its own interventions) and makes the quoted odds mean "if no change is made",
    // which is the only reading under which a warning sign says anything useful.
    // A few thousand paths is ample for bucket-level rates, so this is capped independently
    // of the display sample size.
    const cal = (() => {
      if (!healthOn) return null;
      const CAL_N = Math.min(N, 2500);
      const bucket: Record<string, (v: number) => number> = {
        negYears:  v => Math.min(Math.round(v), 20),
        bigLosses: v => Math.min(Math.round(v), 10),
        overdrawn: v => Math.min(Math.round(v), 25),
        ncav:      v => Math.min(Math.round(v), 25),
        moro:      v => Math.min(Math.round(v / 25), 20),
        aer:       v => Math.max(-10, Math.min(10, Math.round(v * 100))),
        distRate:  v => Math.min(40, Math.round(v * 2)),
        sd:        v => Math.min(20, Math.round(v * 2)),
        scav:      v => Math.min(20, Math.round(v * 2)),
      };
      const KEYS = Object.keys(bucket);
      const tally: Record<string, Record<number, Record<number, [number, number]>>> = {};
      KEYS.forEach(k => { tally[k] = {}; });

      for (let i = 0; i < CAL_N; i++) {
        const r = runOnePath(genReturns(), false, true);      // unruled
        const isFail = r.final <= 0.40 * init;                 // Sandidge's <40% criterion
        r.signs.forEach(s => {
          KEYS.forEach(k => {
            const b = bucket[k]((s as any)[k]);
            (tally[k][s.yr] ??= {})[b] ??= [0, 0];
            tally[k][s.yr][b][1]++;
            if (isFail) tally[k][s.yr][b][0]++;
          });
        });
      }

      // Thin buckets are noise, so report no reading rather than a made-up odds figure.
      const rateOf = (k: string, yr: number, v: number): number | null => {
        const cell = tally[k]?.[yr]?.[bucket[k](v)];
        return cell && cell[1] >= 25 ? cell[0] / cell[1] : null;
      };
      const afrOf = (s: VitalSigns): number | null => {
        const rs = KEYS.map(k => rateOf(k, s.yr, (s as any)[k])).filter((r): r is number => r !== null);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
      };
      return { tally, bucket, KEYS, rateOf, afrOf };
    })();

    // Arm the health rule now that the unruled odds exist.
    if (cal) afrLookup = cal.afrOf;

    const allSigns: VitalSigns[][] = [];

    for (let s = 0; s < N; s++) {
      const monthlyReturns = genReturns();

      const r = runOnePath(monthlyReturns, true, healthOn);
      totSkip += r.skips; totInc += r.incs;
      if (healthOn) allSigns.push(r.signs);

      if (comparingOn) {
        // Same return sequence, rule off — a paired comparison, so any difference in
        // success rate is the rule's effect and not sampling noise between two draws.
        const base = runOnePath(monthlyReturns, false);
        if (base.final > 1) baseSuccess++;
        totFreeze += r.freezeYears.length;
        if (r.freezeYears.length) pathsFrozen++;
        r.freezeYears.forEach(y => { freezeByYear[y]++; });
        if (r.final > 1) { successCount++; freezeOnSuccess += r.freezeYears.length; }
      }

      finals.push(r.final); paths.push(r.path); wpaths.push(r.wpath);
    }

    // ---- Portfolio health (Sandidge's vital signs) ----
    // Reads the median simulated path against the unruled calibration above, so the odds
    // shown mean "if no cash-flow change is made from here". Must run before finals is
    // sorted below, since the ordering is what ties a path to its recorded signs.
    const health: HealthStats | null = (() => {
      if (!healthOn || !allSigns.length || !cal) return null;
      const { tally, rateOf, afrOf } = cal;

      // Sandidge publishes a target per sign per year; his tables are proprietary, so derive
      // the equivalent from this run — the reading at which the odds of failing pass 50%.
      // Targets must be year-specific: five negative years is alarming by year 5 and
      // unremarkable by year 25, so a fixed target would flag healthy plans as failing.
      const unbucket: Record<string, (b: number) => number> = {
        negYears: b => b, bigLosses: b => b, overdrawn: b => b, ncav: b => b,
        moro: b => b * 25, aer: b => b, distRate: b => b / 2, sd: b => b / 2, scav: b => b / 2,
      };
      const worseWhenHigher: Record<string, boolean> = {
        negYears: true, bigLosses: true, overdrawn: true, ncav: true,
        moro: true, distRate: true, sd: true, scav: true,
        aer: false,   // a low erosion rate is the danger signal
      };
      const thresholdOf = (k: string, yr: number): number | null => {
        const byBucket = tally[k]?.[yr];
        if (!byBucket) return null;
        const bs = Object.keys(byBucket).map(Number).sort((a, b) => a - b);
        const usable = bs.filter(b => byBucket[b][1] >= 25);
        if (!usable.length) return null;
        const ordered = worseWhenHigher[k] ? usable : usable.slice().reverse();
        for (const b of ordered) {
          const [f, n] = byBucket[b];
          if (f / n >= 0.5) return unbucket[k](b);
        }
        return null;   // nothing in range is bad enough to reach even odds
      };
      // Sandidge's figure 8: mean health by year, surviving vs depleted, so the divergence
      // between the two groups is visible rather than asserted.
      const failed = finals.map(f => f <= 0.40 * init);   // his <40%-of-capital criterion
      const sumS = Array(years + 1).fill(0), cntS = Array(years + 1).fill(0);
      const sumD = Array(years + 1).fill(0), cntD = Array(years + 1).fill(0);
      allSigns.forEach((signs, i) => {
        const dead = failed[i];
        signs.forEach(s => {
          const a = afrOf(s);
          if (a === null) return;
          if (dead) { sumD[s.yr] += a; cntD[s.yr]++; } else { sumS[s.yr] += a; cntS[s.yr]++; }
        });
      });
      const mean = (sum: number[], cnt: number[]) => sum.map((v, i) => cnt[i] ? v / cnt[i] : null);

      // Report on the median outcome — the representative case for a client conversation.
      const order = finals.map((f, i) => [f, i] as [number, number]).sort((a, b) => a[0] - b[0]);
      const medianSigns = allSigns[order[Math.floor(0.50 * N)][1]] ?? [];

      // Precompute every year so the year selector never re-runs the simulation.
      const rowsByYear: HealthRow[][] = [[]];
      const afrByYear: (number | null)[] = [null];
      const moroByYear: number[] = [0];
      // key, label, reading, how to display a threshold
      const SPEC: [string, string, (s: VitalSigns) => number, (t: number) => string][] = [
        ["negYears",  "Negative years",      s => s.negYears,    t => String(Math.round(t))],
        ["bigLosses", "Losses of 5%+",       s => s.bigLosses,   t => String(Math.round(t))],
        ["sd",        "Downside spread",     s => s.sd,          t => t.toFixed(1) + "%"],
        ["aer",       "Erosion rate",        s => s.aer * 100,   t => t.toFixed(0) + "%"],
        ["distRate",  "Withdrawal rate",     s => s.distRate,    t => t.toFixed(1) + "%"],
        ["overdrawn", "Overdrawn years",     s => s.overdrawn,   t => String(Math.round(t))],
        ["moro",      "Momentum (MoRo)",     s => s.moro,        t => Math.round(t) + "%"],
        ["ncav",      "Years value fell",    s => s.ncav,        t => String(Math.round(t))],
        ["scav",      "Value-change spread", s => s.scav,        t => t.toFixed(1) + "%"],
      ];
      const fmtVal: Record<string, (v: number) => string> = {
        negYears: v => String(v), bigLosses: v => String(v), overdrawn: v => String(v), ncav: v => String(v),
        moro: v => Math.round(v) + "%", aer: v => v.toFixed(1) + "%",
        distRate: v => v.toFixed(1) + "%", sd: v => v.toFixed(1) + "%", scav: v => v.toFixed(1) + "%",
      };

      for (let y = 1; y <= years; y++) {
        const s = medianSigns.find(x => x.yr === y);
        if (!s) { rowsByYear[y] = []; afrByYear[y] = null; moroByYear[y] = 0; continue; }
        rowsByYear[y] = SPEC.map(([key, label, read, fmtT]) => {
          const raw = read(s);
          const thr = thresholdOf(key, y);
          const higherWorse = worseWhenHigher[key];
          const ok = thr === null ? true : (higherWorse ? raw < thr : raw > thr);
          return {
            key, label,
            goal: thr === null ? "—" : (higherWorse ? "< " : "> ") + fmtT(thr),
            value: fmtVal[key](raw),
            failRate: rateOf(key, y, key === "aer" ? s.aer : raw),
            ok,
          };
        });
        afrByYear[y] = afrOf(s);
        moroByYear[y] = s.moro;
      }

      return {
        rowsByYear, afrByYear, moroByYear,
        afrSurvived: mean(sumS, cntS),
        afrDepleted: mean(sumD, cntD),
        maxYear: years,
      };
    })();

    finals.sort((a, b) => a - b);
    const pct = (p: number) => finals[Math.floor(p / 100 * N)];

    const p5a = [], p50a = [], p75a = [], p95a = [];
    const w5a = [], w50a = [], w75a = [], w95a = [];

    for (let y = 0; y <= years; y++) {
      const pv = paths.map(p => (typeof p[y] === "number" && !isNaN(p[y])) ? p[y] : 0).sort((a, b) => a - b);
      p5a.push(pv[Math.floor(0.05 * N)]);
      p50a.push(pv[Math.floor(0.50 * N)]);
      p75a.push(pv[Math.floor(0.75 * N)]);
      p95a.push(pv[Math.floor(0.95 * N)]);
      const wv = wpaths.map(p => (p && typeof p[y] === "number" && !isNaN(p[y])) ? p[y] * 12 : (p && p.length ? p[p.length - 1] * 12 : 0)).sort((a, b) => a - b);
      w5a.push(wv[Math.floor(0.05 * N)]);
      w50a.push(wv[Math.floor(0.50 * N)]);
      w75a.push(wv[Math.floor(0.75 * N)]);
      w95a.push(wv[Math.floor(0.95 * N)]);
    }

    // Linear portfolio path
    const linPort = (() => {
      let val = init, curW = withdraw, curC = contrib;
      const path = [val];
      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          const yr = m / 12;
          if (wEsc > 0) {
            const skip = skipMode === "fixed" ? (yr % skipEvery === 0) : false;
            if (!skip) curW *= (1 + wEsc);
          }
          if (cEsc > 0) curC *= (1 + cEsc);
        }
        if (lumpMap[m]) val += lumpMap[m];
        val = val * (1 + muM) + curC - curW;
        if (val < 0) val = 0;
        if ((m + 1) % 12 === 0) path.push(val);
      }
      return path;
    })();

    // Linear withdrawal path
    const linW = (() => {
      let curW = withdraw;
      const path = [curW * 12];
      for (let yr = 1; yr <= years; yr++) {
        const skip = skipMode === "fixed" ? (yr % skipEvery === 0) : false;
        if (!skip && wEsc > 0) curW *= (1 + wEsc);
        path.push(curW * 12);
      }
      return path;
    })();

    // Depletion month/year
    const depletionYearIdx = (arr: number[]) => { for (let y = 0; y < arr.length; y++) { if (arr[y] <= 0) return y; } return null; };
    const now = new Date();
    const baseYear = now.getFullYear(), baseMonth = now.getMonth();
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtDeplete = (yr: number | null) => {
      if (yr === null) return null;
      const tot = baseMonth + yr * 12;
      return monthNames[tot % 12] + " " + (baseYear + Math.floor(tot / 12));
    };
    const dep = {
      p5: fmtDeplete(depletionYearIdx(p5a)),
      p50: fmtDeplete(depletionYearIdx(p50a)),
      p75: fmtDeplete(depletionYearIdx(p75a)),
      p95: fmtDeplete(depletionYearIdx(p95a)),
      linear: fmtDeplete(depletionYearIdx(linPort)),
    };

    // Real values
    const inflFactor = Math.pow(1 + inflation / 100, years);
    const real = {
      p5: pct(5) / inflFactor,
      p50: pct(50) / inflFactor,
      p75: pct(75) / inflFactor,
      p95: pct(95) / inflFactor,
      linear: linPort[linPort.length - 1] / inflFactor,
    };

    // Implied CAGR
    const cagr = (t: number) => (init <= 0 || t <= 0 || years <= 0) ? null : (Math.pow(t / init, 1 / years) - 1) * 100;
    const avgReturn = {
      p5: cagr(pct(5)),
      p50: cagr(pct(50)),
      p75: cagr(pct(75)),
      p95: cagr(pct(95)),
      linear: cagr(linPort[linPort.length - 1]),
    };

    const finalContrib = cEsc > 0 ? contrib * Math.pow(1 + cEsc, years) : contrib;

    setResults({
      p5: pct(5), p50: pct(50), p75: pct(75), p95: pct(95),
      pctSuccess: Math.round(100 * finals.filter(v => v > 1).length / N),
      pctBeat: Math.round(100 * finals.filter(v => v > init).length / N),
      pctRuined: Math.round(100 * finals.filter(v => v === 0).length / N),
      totalIn: init + contrib * 12 * years + lumps.reduce((s, l) => s + l.amount, 0),
      p5a, p50a, p75a, p95a, w5a, w50a, w75a, w95a, linPort, linW, dep, real, avgReturn,
      labels: Array.from({ length: years + 1 }, (_, i) => "Yr " + i),
      avgInc: (totInc / N).toFixed(1), avgSkip: (totSkip / N).toFixed(1), finalContrib,
      expectedBalance,
      guard: comparingOn ? {
        band: guardBand,
        avgFreezes: totFreeze / N,
        avgFreezesOnSuccess: successCount ? freezeOnSuccess / successCount : 0,
        pctSuccessNoGuard: Math.round(100 * baseSuccess / N),
        pctPathsEverFrozen: Math.round(100 * pathsFrozen / N),
        freezeByYear,
        peakFreezeYear: freezeByYear.reduce((bi, v, i, a) => v > a[bi] ? i : bi, 0),
      } : null,
      health,
    });
    // healthYear is deliberately NOT a dependency — it only picks which precomputed year
    // the diagnostic displays, so moving it must not trigger another simulation run.
  }, [init, contrib, contribEsc, withdraw, escMode, customEsc, skipMode, skipEvery, guardBand, healthThreshold, ret, vol, years, sims, effEsc, lumps, inflation, otherFees]);

  useEffect(() => { if (chartReady) runSim(); }, [chartReady]);

  // Portfolio chart
  useEffect(() => {
    if (!chartReady || !results || !c1Ref.current) return;
    if (c1Inst.current) c1Inst.current.destroy();
    const band = results.p75a.map((v, i) => ({ x: results.labels[i], y: [results.p5a[i], v] }));
    const annPlugin = {
      id: "ann", afterDraw(ch: any) {
        lumps.forEach(({ year, amount }) => {
          const { ctx: c, scales: { x, y } } = ch;
          const xp = x.getPixelForValue(year);
          c.save(); c.beginPath(); c.moveTo(xp, y.top); c.lineTo(xp, y.bottom);
          c.strokeStyle = "rgba(29,158,117,.6)"; c.lineWidth = 1.5; c.setLineDash([4, 3]); c.stroke();
          c.setLineDash([]); c.fillStyle = "rgba(29,158,117,.85)"; c.font = "10px sans-serif";
          c.textAlign = "center"; c.fillText("+" + fmt(amount), xp, y.top + 10); c.restore();
        });
      }
    };
    c1Inst.current = new window.Chart(c1Ref.current.getContext("2d"), {
      type: "bar", data: { labels: results.labels, datasets: [
        { type: "bar",  label: "band",   data: band,            backgroundColor: "rgba(136,135,128,.18)", borderColor: "transparent", barPercentage: 1, categoryPercentage: 1, order: 5 },
        { type: "line", label: "P95",    data: results.p95a,    borderColor: COLORS.p95,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [2, 3], order: 1 },
        { type: "line", label: "P75",    data: results.p75a,    borderColor: COLORS.p90,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [6, 3], order: 1 },
        { type: "line", label: "P50",    data: results.p50a,    borderColor: COLORS.p50,    borderWidth: 2.5, pointRadius: 0, tension: .4, fill: false, order: 0 },
        { type: "line", label: "P5",     data: results.p5a,     borderColor: COLORS.p10,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [4, 4], order: 2 },
        { type: "line", label: "Fixed return", data: results.linPort, borderColor: COLORS.linear, borderWidth: 2,   pointRadius: 0, tension: 0,  fill: false, borderDash: [8, 4], order: 3 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
        scales: {
          x: { ticks: { color: "#999", font: { size: 10 }, autoSkip: true, maxTicksLimit: 10 }, grid: { color: "rgba(0,0,0,.05)" } },
          y: { min: 0, ticks: { color: "#999", font: { size: 10 }, callback: (v: any) => fmt(v) }, grid: { color: "rgba(0,0,0,.05)" } }
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: any) => { const v = c.raw; return typeof v === "object" && Array.isArray(v.y) ? `Band: ${fmt(v.y[0])}–${fmt(v.y[1])}` : `${c.dataset.label}: ${fmt(v)}`; } } } }
      }, plugins: [annPlugin]
    });
  }, [results, chartReady, lumps]);

  // Withdrawal chart
  useEffect(() => {
    if (!chartReady || !results || !c2Ref.current || withdraw === 0) return;
    if (c2Inst.current) c2Inst.current.destroy();
    const band2 = results.w75a.map((v, i) => ({ x: results.labels[i], y: [results.w5a[i], v] }));
    c2Inst.current = new window.Chart(c2Ref.current.getContext("2d"), {
      type: "bar", data: { labels: results.labels, datasets: [
        { type: "bar",  label: "W-band",   data: band2,           backgroundColor: "rgba(211,90,48,.12)", borderColor: "transparent", barPercentage: 1, categoryPercentage: 1, order: 5 },
        { type: "line", label: "W-P95",    data: results.w95a,    borderColor: COLORS.p95,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [2, 3], order: 1 },
        { type: "line", label: "W-P75",    data: results.w75a,    borderColor: COLORS.p90,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [6, 3], order: 1 },
        { type: "line", label: "W-P50",    data: results.w50a,    borderColor: COLORS.p50,    borderWidth: 2.5, pointRadius: 0, tension: .4, fill: false, order: 0 },
        { type: "line", label: "W-P5",     data: results.w5a,     borderColor: COLORS.p10,    borderWidth: 2,   pointRadius: 0, tension: .4, fill: false, borderDash: [4, 4], order: 2 },
        { type: "line", label: "Fixed return", data: results.linW,    borderColor: COLORS.linear, borderWidth: 2,   pointRadius: 0, tension: 0,  fill: false, borderDash: [8, 4], order: 3 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
        scales: {
          x: { ticks: { color: "#999", font: { size: 10 }, autoSkip: true, maxTicksLimit: 10 }, grid: { color: "rgba(0,0,0,.05)" } },
          y: { min: 0, ticks: { color: "#999", font: { size: 10 }, callback: (v: any) => fmt(v) }, grid: { color: "rgba(0,0,0,.05)" } }
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: any) => { const v = c.raw; return typeof v === "object" && Array.isArray(v.y) ? `Band: ${fmt(v.y[0])}–${fmt(v.y[1])}` : `${c.dataset.label}: ${fmt(v)}`; } } } }
      }
    });
  }, [results, chartReady, withdraw]);

  const sRow = (label: string, min: number, max: number, step: number, val: number, set: (v: number) => void, disp: ReactNode, col?: string) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 12, color: "#666" }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: col || "#222" }}>{disp}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={e => set(Number(e.target.value))} style={{ width: "100%", accentColor: "#1D9E75" }} />
    </div>
  );

  // Exact-value number box (no slider), for fields advisors need to enter precisely (e.g. for a Record of Advice).
  const sRowN = (label: string, min: number, max: number, step: number, val: number, set: (v: number) => void, prefix?: string, col?: string, suffix?: string) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid #ccc", borderRadius: 6, padding: "4px 8px", background: "#fff" }}>
        {prefix && <span style={{ fontSize: 12, color: col || "#666" }}>{prefix}</span>}
        <input type="number" min={min} max={max} step={step} value={val}
          onChange={e => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (!Number.isNaN(v)) set(v); }}
          onFocus={e => e.target.select()}
          style={{ flex: 1, width: "100%", padding: "3px 0", fontSize: 12, fontWeight: 600, color: col || "#222", border: "none", outline: "none" }} />
        {suffix && <span style={{ fontSize: 12, color: col || "#666" }}>{suffix}</span>}
      </div>
    </div>
  );

  const segRow = (opts: [string, string][], val: string, set: (v: string) => void) => (
    <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid #ddd", marginBottom: 10 }}>
      {opts.map(([k, lbl], i) => (
        <button key={k} onClick={() => set(k)} style={{
          flex: 1, padding: "5px 2px", fontSize: 11, fontWeight: val === k ? 600 : 400,
          background: val === k ? "#1D9E75" : "#fff", color: val === k ? "#fff" : "#555",
          border: "none", borderRight: i < opts.length - 1 ? "1px solid #ddd" : "none", cursor: "pointer"
        }}>{lbl}</button>
      ))}
    </div>
  );

  const hr = <div style={{ borderTop: "1px solid #eee", margin: "10px 0 12px" }} />;
  const secLabel = (t: string) => <div style={{ fontSize: 11, fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 8 }}>{t}</div>;
  const legend = (items: [string, string, boolean][]) => (
    <div style={{ display: "flex", gap: 14, marginBottom: 8, fontSize: 11, color: "#888", flexWrap: "wrap" }}>
      {items.map(([c, l, d]) => (
        <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ display: "inline-block", width: 20, height: 2, background: c, opacity: d ? .7 : 1 }} />{l}
        </span>
      ))}
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ display: "inline-block", width: 12, height: 10, background: "rgba(136,135,128,.2)", borderRadius: 2 }} />band
      </span>
    </div>
  );

  return (
    <div style={{ display: "flex", border: "1px solid #e0e0e0", borderRadius: 12, overflow: "hidden", fontFamily: "system-ui,sans-serif", background: "#fff", minHeight: 500 }}>

      {/* SIDEBAR */}
      <div style={{ width: 256, minWidth: 256, background: "#f8f8f6", borderRight: "1px solid #e0e0e0", padding: "14px 13px", overflowY: "auto", maxHeight: "90vh", flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #e0e0e0" }}>⚙ Parameters</div>

        {secLabel("Portfolio")}
        {sRowN("Starting value (R)", 100000, 200000000, 100000, init, setInit, "R")}
        {sRowN("Monthly contribution (R)", 0, 100000, 500, contrib, setContrib, "R")}
        {sRow("Contribution escalation (%/yr)", 0, 20, 0.5, contribEsc, setContribEsc, contribEsc === 0 ? "None" : contribEsc.toFixed(1) + "%/yr", contribEsc > 0 ? "#1D9E75" : undefined)}
        {contribEsc > 0 && results && <div style={{ fontSize: 11, color: "#1D9E75", marginTop: -8, marginBottom: 10 }}>Yr {years} contribution: {fmt(results.finalContrib)}/mo</div>}

        {hr}
        {secLabel("Withdrawal")}
        {sRowN("Monthly withdrawal (R)", 0, 500000, 1000, withdraw, setWithdraw, "R", withdraw > 0 ? "#D85A30" : undefined)}
        {withdraw > 0 && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            WR: <strong style={{ color: wr > 5 ? "#D85A30" : wr > 3.5 ? "#BA7517" : "#1D9E75" }}>{wr.toFixed(1)}%/yr</strong>
            {" · "}
            <span style={{ color: (contrib - withdraw) < 0 ? "#D85A30" : "#1D9E75" }}>
              Net: {contrib - withdraw >= 0 ? "+" : "-"}R{Math.abs(contrib - withdraw).toLocaleString()}/mo
            </span>
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Annual withdrawal escalation</div>
        {segRow([["none", "None"], ["custom", "Custom %"]], escMode, setEscMode)}
        {escMode === "custom" && sRow("Escalation rate (%)", 0, 20, .5, customEsc, setCustomEsc, customEsc.toFixed(1) + "%", "#D85A30")}

        {escMode !== "none" && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Skip escalation when</div>
            <select value={skipMode} onChange={e => setSkipMode(e.target.value)}
              style={{ width: "100%", padding: "6px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333", cursor: "pointer", marginBottom: 10 }}>
              <option value="none">Never</option>
              <option value="negative">After a negative year</option>
              <option value="fixed">On a fixed cadence</option>
              <option value="guard">Guardrail — below trajectory and negative</option>
              <option value="health">Health score — when the odds turn</option>
            </select>
            {skipMode === "negative" && <div style={{ fontSize: 11, color: "#993C1D", background: "#fff7ed", border: "1px solid #f5c4b3", borderRadius: 6, padding: "7px 9px", marginBottom: 10 }}>Skips the increase in any year the portfolio return was negative.</div>}
            {skipMode === "fixed" && sRow("Skip every (years)", 1, 10, 1, skipEvery, setSkipEvery, `Every ${skipEvery} yr${skipEvery > 1 ? "s" : ""}`)}
            {skipMode === "guard" && (
              <div>
                <div style={{ fontSize: 11, color: "#185FA5", background: "#f0f6fd", border: "1px solid #c5dcf5", borderRadius: 6, padding: "7px 9px", marginBottom: 10 }}>
                  Freezes next year's increase only when <strong>both</strong> are true: the balance is below {guardBand}% of its expected trajectory <strong>and</strong> the year's return was negative. Skipped increases are never caught up later.
                </div>
                {sRow("Trajectory band (%)", 50, 100, 1, guardBand, setGuardBand, guardBand + "% of expected", "#185FA5")}
              </div>
            )}
            {skipMode === "health" && (
              <div>
                <div style={{ fontSize: 11, color: "#185FA5", background: "#f0f6fd", border: "1px solid #c5dcf5", borderRadius: 6, padding: "7px 9px", marginBottom: 10 }}>
                  Freezes next year's increase whenever the health score passes {healthThreshold}% — that is, once a plan showing these warning signs more often than not ends below 40% of its capital. Unlike the guardrail this reacts to <strong>built-up momentum</strong>, so it holds back harder on a stressed plan and leaves a comfortable one alone.
                </div>
                {sRow("Act above odds of", 30, 80, 5, healthThreshold, setHealthThreshold, healthThreshold + "% failing", "#185FA5")}
              </div>
            )}
            {results && skipMode !== "none" && <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>Avg: <strong>{results.avgInc}</strong> inc · <strong>{results.avgSkip}</strong> skipped/path</div>}
          </div>
        )}

        {hr}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          {secLabel("Capital injections")}
          <button onClick={() => setLumps(l => [...l, { id: uid++, amount: 500000, year: Math.max(1, Math.floor(years / 2)) }])}
            style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #1D9E75", background: "none", color: "#1D9E75", cursor: "pointer", fontWeight: 600, marginTop: -6 }}>+ Add</button>
        </div>
        {lumps.length === 0 && <div style={{ fontSize: 11, color: "#ccc", marginBottom: 8 }}>No injections yet.</div>}
        {lumps.map(l => (
          <div key={l.id} style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#1D9E75" }}>R{Math.round(l.amount).toLocaleString()} @ Yr {l.year}</span>
              <button onClick={() => setLumps(ls => ls.filter(x => x.id !== l.id))} style={{ background: "none", border: "none", color: "#ccc", fontSize: 16, cursor: "pointer" }}>×</button>
            </div>
            {sRow("Amount", 10000, 20000000, 10000, l.amount, v => setLumps(ls => ls.map(x => x.id === l.id ? { ...x, amount: v } : x)), "R" + Math.round(l.amount).toLocaleString(), "#1D9E75")}
            {sRow("Inject at year", 1, years - 1, 1, l.year, v => setLumps(ls => ls.map(x => x.id === l.id ? { ...x, year: v } : x)), "Yr " + l.year, "#378ADD")}
          </div>
        ))}
        {lumps.length > 0 && <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>Total: <strong style={{ color: "#1D9E75" }}>R{lumps.reduce((s, l) => s + l.amount, 0).toLocaleString()}</strong></div>}

        {hr}
        {secLabel("Portfolio return target")}

        {/* Model preset — return + σ linked to the model-portfolio spreadsheet.
            Two ranges (DNA, Monarch); switching range resets the model to custom. */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>Model range</div>
          <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid #ddd", marginBottom: 8 }}>
            {[["dna", "DNA"], ["monarch", "Monarch"]].map(([k, lbl], i) => (
              <button key={k} onClick={() => applyRange(k)} style={{
                flex: 1, padding: "5px 2px", fontSize: 12, fontWeight: modelRange === k ? 600 : 400,
                background: modelRange === k ? "#1D9E75" : "#fff", color: modelRange === k ? "#fff" : "#555",
                border: "none", borderRight: i === 0 ? "1px solid #ddd" : "none", cursor: "pointer"
              }}>{lbl}</button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>Model preset</div>
          <select value={modelKey} onChange={e => applyModel(e.target.value)}
            style={{ width: "100%", padding: "6px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333", cursor: "pointer" }}>
            <option value="">Custom (manual)</option>
            {modelList.map(m => <option key={m.key} value={m.key}>{m.name.replace(/^(DNA|Monarch Integrate) /, "")}</option>)}
          </select>
          {activeModel && (
            <div style={{ fontSize: 11, color: modelMatches ? "#1D9E75" : "#BA7517", marginTop: 4 }}>
              {modelMatches
                ? (isMonarchModel(activeModel)
                    ? <>Linked to spreadsheet · CPI+{activeModel.cpiPlusTarget}% target · cost {activeModel.totalEffectiveCost}% · {activeModel.volPeriod} volatility{!activeModel.reg28 ? " · Reg 28: No" : ""}</>
                    : <>Linked to spreadsheet · CPI+{activeModel.cpiPlusTarget}% target · TER {activeModel.ter}% · {activeModel.volPeriod} volatility</>)
                : <>Customised — differs from {activeModel.name.replace(/^(DNA|Monarch Integrate) /, "")}</>}
            </div>
          )}
          {activeModel && (() => {
            const modelCost = modelCostOf(activeModel);
            const requiredGross = activeModel.nominalReturn + modelCost;
            return (
              <div style={{ fontSize: 11, color: "#666", marginTop: 3, background: "#f8f8f6", border: "1px solid #eee", borderRadius: 5, padding: "5px 7px" }}>
                To net this category's {activeModel.nominalReturn.toFixed(1)}% target after its own {modelCost.toFixed(2)}% cost, this model needs to earn{" "}
                <strong style={{ color: "#333" }}>{requiredGross.toFixed(2)}%</strong> gross · doesn't include advice/platform fees
              </div>
            );
          })()}
        </div>

        {sRow("Expected return (average %/yr)", 1, 20, .5, ret, setRet, ret.toFixed(1) + "%")}
        {results && results.avgReturn.p50 != null && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            Typical compound growth ≈ <strong style={{ color: "#1D9E75" }}>{results.avgReturn.p50.toFixed(2)}%</strong> once volatility is allowed for
          </div>
        )}
        {sRow("Annual volatility %", 1, 40, .5, vol, setVol, vol.toFixed(1) + "%")}

        {hr}
        {secLabel("Other fees")}
        <div style={{ fontSize: 11, color: "#888", marginTop: -4, marginBottom: 8 }}>
          Fees not already included in the return above (a model preset's return already nets out that model's own cost). Both are deducted from the expected return before the simulation runs.
        </div>
        {sRowN("Advice fee (%/yr)", 0, 10, .05, adviceFee, setAdviceFee, undefined, adviceFee > 0 ? "#D85A30" : undefined, "%")}
        {sRowN("Platform / product fee (%/yr)", 0, 10, .05, platformFee, setPlatformFee, undefined, platformFee > 0 ? "#D85A30" : undefined, "%")}
        {otherFees > 0 && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            Net expected return: <strong style={{ color: "#D85A30" }}>{(ret - otherFees).toFixed(2)}%</strong> (was {ret.toFixed(1)}%, total other fees {otherFees.toFixed(2)}%)
          </div>
        )}

        {hr}
        {secLabel("Simulation")}
        {sRow("Time horizon (years)", 5, 40, 1, years, setYears, years + " yrs")}
        {sRow("Simulations", 500, 10000, 500, sims, setSims, sims.toLocaleString())}
        {sRow("Inflation rate (%/yr)", 0, 15, 0.5, inflation, setInflation, inflation.toFixed(1) + "%", "#888")}

        <button onClick={runSim} style={{ width: "100%", marginTop: 4, padding: "9px 0", fontSize: 13, fontWeight: 600, borderRadius: 8, border: "1px solid #ccc", background: "#fff", cursor: "pointer" }}>
          Run simulation ↗
        </button>
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflowY: "auto" }}>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid #eee" }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Monte Carlo forecast</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#f0f0f0", color: "#555" }}>
              Variable return and sequence risk
            </span>
            {lumps.length > 0 && <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#e8f7ef", color: "#1a7a4a" }}>{lumps.length} injection{lumps.length > 1 ? "s" : ""}</span>}
            {contribEsc > 0 && <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#e8f7ef", color: "#1a7a4a" }}>contrib +{contribEsc.toFixed(1)}%/yr</span>}
            {escMode !== "none" && <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#faece7", color: "#993C1D" }}>withdraw +{effEsc.toFixed(1)}%/yr{skipMode !== "none" ? " · skip" : ""}</span>}
            <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "#e6f1fb", color: "#185FA5" }}>{sims.toLocaleString()} paths · {years} yrs</span>
          </div>
        </div>

        {/* Metric cards */}
        <div style={{ display: "flex", borderBottom: "1px solid #eee", flexWrap: "wrap" }}>
          {([
            ["Median (P50)",      results ? fmt(results.p50) : "—", "50th percentile", COLORS.p50,  results ? results.dep.p50 : null,    results ? results.real.p50 : null,    results ? results.avgReturn.p50 : null],
            ["Optimistic (P75)",  results ? fmt(results.p75) : "—", "75th percentile", COLORS.p90,  results ? results.dep.p75 : null,    results ? results.real.p75 : null,    results ? results.avgReturn.p75 : null],
            ["Best case (P95)",   results ? fmt(results.p95) : "—", "95th percentile", COLORS.p95,  results ? results.dep.p95 : null,    results ? results.real.p95 : null,    results ? results.avgReturn.p95 : null],
            ["Conservative (P5)", results ? fmt(results.p5) : "—",  "5th percentile",  COLORS.p10,  results ? results.dep.p5 : null,     results ? results.real.p5 : null,     results ? results.avgReturn.p5 : null],
            ["Fixed-return projection", results ? fmt(results.linPort ? results.linPort[results.linPort.length - 1] : 0) : "—", "same return every year, no ups and downs", COLORS.linear, results ? results.dep.linear : null, results ? results.real.linear : null, results ? results.avgReturn.linear : null],
          ] as MetricCard[]).map(([label, value, sub, color, depleteAt, realVal, cagr]) => (
            <div key={label} style={{ flex: 1, minWidth: 80, padding: "10px 12px", borderRight: "1px solid #eee" }}>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 17, fontWeight: 600, color: color || "#111" }}>{value}</div>
              <div style={{ fontSize: 11, color: "#bbb" }}>{sub}</div>
              {cagr != null && <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>CAGR: <strong style={{ color: cagr >= 0 ? "#1D9E75" : "#D85A30" }}>{cagr.toFixed(2)}%</strong></div>}
              {realVal != null && <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Real: <strong style={{ color: "#555" }}>{fmt(realVal)}</strong></div>}
              {depleteAt && <div style={{ fontSize: 11, color: "#D85A30", marginTop: 3, fontWeight: 500 }}>⚠ {depleteAt}</div>}
            </div>
          ))}
          {results && (() => {
            const p = results.pctSuccess, color = p >= 80 ? "#1D9E75" : p >= 60 ? "#BA7517" : "#D85A30";
            const r = 26, circ = 2 * Math.PI * r;
            return (
              <div style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 8 }}>
                <svg width={64} height={64} viewBox="0 0 64 64">
                  <circle cx={32} cy={32} r={r} fill="none" stroke="#eee" strokeWidth={7} />
                  <circle cx={32} cy={32} r={r} fill="none" stroke={color} strokeWidth={7}
                    strokeDasharray={`${circ * p / 100} ${circ}`} strokeLinecap="round" transform="rotate(-90 32 32)" />
                  <text x={32} y={36} textAnchor="middle" fontSize={12} fontWeight={600} fill={color}>{p}%</text>
                </svg>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color }}>{p >= 90 ? "Excellent" : p >= 75 ? "Good" : p >= 60 ? "Moderate" : "At risk"}</div>
                  <div style={{ fontSize: 11, color: "#aaa" }}>success rate</div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Guardrail impact — only when the rule is active */}
        {results && results.guard && (() => {
          const g = results.guard;
          const lift = results.pctSuccess - g.pctSuccessNoGuard;
          const cell = (label: string, value: string, color: string, sub?: string) => (
            <div style={{ flex: 1, minWidth: 110, padding: "8px 12px", borderRight: "1px solid #eee" }}>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 600, color }}>{value}</div>
              {sub && <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>{sub}</div>}
            </div>
          );
          return (
            <div style={{ borderTop: "1px solid #eee", background: "#fbfcfe" }}>
              <div style={{ padding: "10px 16px 0", fontSize: 12, fontWeight: 600, color: "#444" }}>
                {skipMode === "health" ? "Health-score rule impact" : "Withdrawal guardrail impact"}
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}> · {skipMode === "health" ? `freeze increase while the odds of failing exceed ${healthThreshold}%` : `freeze increase when below ${g.band}% of expected trajectory AND year's return is negative`}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", padding: "8px 4px 10px" }}>
                {cell(skipMode === "health" ? "Success — no rule" : "Success — no guardrail", g.pctSuccessNoGuard + "%", "#D85A30", "same return paths")}
                {cell(skipMode === "health" ? "Success — with rule" : "Success — with guardrail", results.pctSuccess + "%", "#1D9E75", "same return paths")}
                {cell("Improvement", (lift >= 0 ? "+" : "") + lift + " pts", lift > 0 ? "#1D9E75" : "#888", "like for like")}
                {cell("Avg freezes / path", g.avgFreezes.toFixed(1), "#185FA5", `${g.avgFreezesOnSuccess.toFixed(1)} on surviving paths`)}
                {cell("Paths ever frozen", g.pctPathsEverFrozen + "%", "#185FA5", `most common: Yr ${g.peakFreezeYear}`)}
              </div>
            </div>
          );
        })()}

        {/* Portfolio health — Sandidge's vital signs on the median path */}
        {results && results.health && (() => {
          const h = results.health;
          const yr = Math.min(Math.max(healthYear, 1), h.maxYear);
          const rows = h.rowsByYear[yr] ?? [];
          const moro = h.moroByYear[yr] ?? 0;
          const afrRaw = h.afrByYear[yr] ?? null;
          const afrPct = afrRaw === null ? null : Math.round(afrRaw * 100);
          // Sandidge's bands: under 50% tilts the odds your way, 60%+ against.
          const afrColor = afrPct === null ? "#888" : afrPct < 50 ? "#1D9E75" : afrPct < 60 ? "#BA7517" : "#D85A30";
          const afrWord  = afrPct === null ? "no reading" : afrPct < 50 ? "Healthy" : afrPct < 60 ? "Fragile" : "At risk";
          const moroColor = moro < 100 ? "#1D9E75" : moro < 200 ? "#BA7517" : "#D85A30";
          const r = 26, circ = 2 * Math.PI * r;
          return (
            <div style={{ borderTop: "1px solid #eee", background: "#fdfdfb" }}>
              <div style={{ padding: "10px 16px 0", fontSize: 12, fontWeight: 600, color: "#444" }}>
                Portfolio health · median outcome, year {yr}
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}> · early warning signs of a plan losing ground</span>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, padding: "8px 16px 4px" }}>
                {/* Overall health score */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 18 }}>
                  <svg width={64} height={64} viewBox="0 0 64 64">
                    <circle cx={32} cy={32} r={r} fill="none" stroke="#eee" strokeWidth={7} />
                    <circle cx={32} cy={32} r={r} fill="none" stroke={afrColor} strokeWidth={7}
                      strokeDasharray={`${circ * (afrPct ?? 0) / 100} ${circ}`} strokeLinecap="round" transform="rotate(-90 32 32)" />
                    <text x={32} y={36} textAnchor="middle" fontSize={12} fontWeight={600} fill={afrColor}>{afrPct === null ? "—" : afrPct + "%"}</text>
                  </svg>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: afrColor }}>{afrWord}</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>health score</div>
                    <div style={{ fontSize: 10, color: "#bbb" }}>aim under 50%</div>
                  </div>
                </div>
                {/* Momentum ratio — Sandidge's own momentum measure */}
                <div style={{ paddingRight: 18, borderLeft: "1px solid #eee", paddingLeft: 18 }}>
                  <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>Momentum (MoRo)</div>
                  <div style={{ fontSize: 17, fontWeight: 600, color: moroColor }}>{Math.round(moro)}%</div>
                  <div style={{ fontSize: 11, color: "#bbb" }}>aim under 100%</div>
                  <div style={{ fontSize: 10, color: "#bbb" }}>falls ÷ rises in value</div>
                </div>
                {/* Year selector */}
                <div style={{ flex: 1, minWidth: 150, borderLeft: "1px solid #eee", paddingLeft: 18 }}>
                  {sRow("Report on year", 1, Math.max(1, h.maxYear), 1, healthYear, setHealthYear, "Yr " + yr, "#185FA5")}
                </div>
              </div>

              {/* Per-signal diagnostic */}
              <div style={{ padding: "0 16px 12px", overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%", minWidth: 420 }}>
                  <thead>
                    <tr style={{ color: "#999" }}>
                      <th style={{ textAlign: "left",  fontWeight: 500, padding: "3px 8px 3px 0" }}>Warning sign</th>
                      <th style={{ textAlign: "right", fontWeight: 500, padding: "3px 8px" }}>Aim for</th>
                      <th style={{ textAlign: "right", fontWeight: 500, padding: "3px 8px" }}>This plan</th>
                      <th style={{ textAlign: "right", fontWeight: 500, padding: "3px 0 3px 8px" }}>Plans like this failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const fr = row.failRate === null ? null : Math.round(row.failRate * 100);
                      const frColor = fr === null ? "#bbb" : fr < 50 ? "#1D9E75" : fr < 60 ? "#BA7517" : "#D85A30";
                      return (
                        <tr key={row.key} style={{ borderTop: "1px solid #f0f0f0" }}>
                          <td style={{ padding: "4px 8px 4px 0", color: "#555" }}>{row.label}</td>
                          <td style={{ padding: "4px 8px", textAlign: "right", color: "#aaa" }}>{row.goal}</td>
                          <td style={{ padding: "4px 8px", textAlign: "right", fontWeight: 600, color: row.ok ? "#1D9E75" : "#D85A30" }}>{row.value}</td>
                          <td style={{ padding: "4px 0 4px 8px", textAlign: "right", fontWeight: 600, color: frColor }}>{fr === null ? "—" : fr + "%"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ fontSize: 10, color: "#bbb", marginTop: 6 }}>
                  "Plans like this failed" is measured from this run: of the simulated plans that reached year {yr} with the same reading, the share that ended below 40% of their starting value. The health score averages those odds across the signs. "Aim for" is the reading at which those odds pass 50%, worked out separately for each year — five negative years means something different by year 25 than by year 5.
                </div>
              </div>
            </div>
          );
        })()}

        {/* Portfolio chart */}
        <div style={{ padding: "12px 16px 14px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#444", marginBottom: 8 }}>Portfolio value</div>
          {legend([[COLORS.p95, "P95 best case", true], [COLORS.p90, "P75 optimistic", true], [COLORS.p50, "P50 median", false], [COLORS.p10, "P5 conservative", true], [COLORS.linear, "Fixed return", true]])}
          <div style={{ position: "relative", height: 220 }}><canvas ref={c1Ref} /></div>
        </div>

        {/* Withdrawal chart */}
        {withdraw > 0 && (
          <div style={{ padding: "12px 16px 14px", borderTop: "1px solid #eee" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#444", marginBottom: 8 }}>Annual income withdrawal</div>
            {legend([[COLORS.p95, "P95 best case", true], [COLORS.p90, "P75 optimistic", true], [COLORS.p50, "P50 median", false], [COLORS.p10, "P5 conservative", true], [COLORS.linear, "Fixed return", true]])}
            <div style={{ position: "relative", height: 200 }}><canvas ref={c2Ref} /></div>
          </div>
        )}

        {/* Footer */}
        {results && (
          <div style={{ padding: "8px 16px", borderTop: "1px solid #eee", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "#888", marginTop: "auto" }}>
            <span>Beat start: <strong style={{ color: "#222" }}>{results.pctBeat}%</strong></span>
            <span>Total invested: <strong style={{ color: "#222" }}>{fmt(results.totalIn)}</strong></span>
            {withdraw > 0 && results.pctRuined > 0 && <span style={{ color: results.pctRuined > 20 ? "#D85A30" : "#888" }}>Depleted: <strong>{results.pctRuined}%</strong></span>}
          </div>
        )}
      </div>
    </div>
  );
}
