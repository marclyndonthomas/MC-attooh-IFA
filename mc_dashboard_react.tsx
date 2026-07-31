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

/**
 * Where the odds of failing pass even for one sign in one year. "allSafe" means no observed
 * reading was bad enough to get there; "noneSafe" means even the most reassuring reading was
 * already worse than even, so the sign offers no safe level on this plan.
 */
type ThresholdResult =
  | { kind: "at"; value: number }
  | { kind: "allSafe" }
  | { kind: "noneSafe" };

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

/**
 * Accumulation diagnostic. Sandidge's vital signs do not transfer to a saving plan: with
 * contributions the account value rarely falls, so his momentum ratio has almost nothing to
 * measure, and sequence risk runs the other way (weak returns early are an advantage, since
 * contributions buy in cheaply). Testing on this model put his signs at 5-15 points of
 * separation between best and worst readings, against 38 for a plain funding ratio. So the
 * useful question here is not "is momentum turning" but "am I on track for the target".
 */
interface FundingStats {
  target: number;                  // 0 when none set
  plannedFinal: number;            // deterministic, no-volatility outcome
  medianFinal: number;
  downsideFinal: number;           // 25th percentile, a plausible bad case
  probTarget: number | null;       // % of paths reaching the target
  fundingByYear: number[];         // median ÷ plan, per year
  requiredContrib: number | null;  // monthly contribution to reach the target on the plan
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
  /** Balance reached at the retirement pivot, across paths. Null for single-phase plans. */
  retirement: { year: number; p5: number; p50: number; p95: number; medianIncome: number } | null;
  guard: GuardStats | null;
  health: HealthStats | null;
  funding: FundingStats | null;
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
  const [savingsTarget, setSavingsTarget] = useState(0);        // R goal for a saving plan; 0 = judge against the central projection only
  // Bucket structure is a reporting overlay only. These two live outside the simulation and
  // are deliberately kept out of runSim's dependencies — see bucketView below.
  const [bucket1Years, setBucket1Years] = useState(3);          // years of withdrawals held in cash
  const [bucket2Years, setBucket2Years] = useState(4);          // years of withdrawals held in bonds
  // Retirement pivot. 0 keeps the original single-phase behaviour, where contributions and
  // withdrawals both run from the start; above 0 the plan contributes until that year and
  // draws afterwards, so one run can span working life and retirement.
  const [retireDate, setRetireDate]     = useState("");         // "YYYY-MM"; blank = already drawing
  const [wBasis, setWBasis]             = useState("today");    // "today" | "atRet" | "percent"
  const [wPct, setWPct]                 = useState(4);          // % of the retirement balance drawn each year
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
  const c3Ref = useRef<HTMLCanvasElement | null>(null); const c3Inst = useRef<any>(null);

  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
    s.onload = () => setChartReady(true);
    document.head.appendChild(s);
  }, []);

  const effEsc = escMode === "none" ? 0 : customEsc;
  const wr = init > 0 ? (withdraw * 12 / init * 100) : 0;

  // Months from today to the retirement date. Blank or a date already past means the plan is
  // drawing now, which is the original single-phase behaviour. Working in months rather than
  // whole years lets the pivot land on the actual date rather than the nearest anniversary.
  const retireMonths = (() => {
    if (!retireDate) return 0;
    const [ry, rm] = retireDate.split("-").map(Number);
    if (!ry || !rm) return 0;
    const now = new Date();
    return Math.max(0, (ry - now.getFullYear()) * 12 + (rm - 1 - now.getMonth()));
  })();
  const retireIn = retireMonths / 12;                 // years, may be fractional
  const retireLabel = (() => {
    if (!retireMonths) return "Already drawing";
    const y = Math.floor(retireMonths / 12), m = retireMonths % 12;
    return (y ? y + (y === 1 ? " yr " : " yrs ") : "") + (m ? m + " mths" : "") || "this month";
  })();

  /**
   * Bucket structure — a reporting overlay on the existing single-pool simulation.
   *
   * Computed here in the render body rather than inside runSim, and its inputs are absent
   * from runSim's dependency list, so changing the bucket years cannot reach the engine even
   * accidentally. The simulation continues to apply one blended return to the whole balance:
   * there are no per-bucket sub-balances, no separate return series and no replenishment.
   *
   * Amounts are the plain sum of the withdrawals each bucket is meant to cover, in the rands
   * of the year they fall due, taken off the withdrawal schedule already in the model. They
   * are not discounted, which matches how a "hold N years of spending in cash" instruction is
   * normally given.
   */
  const bucketView = (() => {
    // A two-phase plan has no liquidity structure to describe until it retires, so the split
    // is measured at the pivot — the median balance handed over and the income that starts
    // there — rather than against the pre-retirement capital, which would be meaningless.
    const twoPhaseView = retireIn > 0;
    const rt = results?.retirement ?? null;
    if (twoPhaseView && !rt) return null;            // nothing to describe until a run exists
    const baseCapital = twoPhaseView ? rt!.p50 : init;
    const baseMonthly = twoPhaseView ? rt!.medianIncome : withdraw;
    // Whole years only: the pivot can fall mid-year, but a bucket covers whole years.
    const drawYears = twoPhaseView ? Math.max(0, Math.floor(years - retireIn)) : years;
    if (baseMonthly <= 0 || baseCapital <= 0) return null;

    const wEsc = effEsc / 100;
    const annualAt = (y: number) => baseMonthly * 12 * Math.pow(1 + wEsc, y - 1);   // y is 1-based

    const b1Yrs = Math.max(0, Math.min(Math.round(bucket1Years), drawYears));
    const b2Yrs = Math.max(0, Math.min(Math.round(bucket2Years), drawYears - b1Yrs));
    const b3Yrs = Math.max(0, drawYears - b1Yrs - b2Yrs);

    let b1 = 0, b2 = 0;
    for (let y = 1; y <= b1Yrs; y++) b1 += annualAt(y);
    for (let y = b1Yrs + 1; y <= b1Yrs + b2Yrs; y++) b2 += annualAt(y);

    // Equity takes what is left. Negative means the stated cash and bond horizons need more
    // than the whole portfolio, which is worth saying plainly rather than clamping silently.
    const b3 = baseCapital - b1 - b2;
    const overCommitted = b3 < 0;

    // Illustrative only: how bucket 1 alone would run down at the expected return, ignoring
    // volatility. Never touches the simulated paths or the success rate.
    const muM = (ret - otherFees) / 100 / 12;
    const runwayMonths = (() => {
      let val = b1, curW = baseMonthly;
      for (let m = 0; m < drawYears * 12; m++) {
        if (m > 0 && m % 12 === 0 && wEsc > 0) curW *= (1 + wEsc);
        val = val * (1 + muM) - curW;
        if (val <= 0) return m + 1;
      }
      return null;                                    // outlasts the horizon
    })();

    const now = new Date();
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const runwayEnds = runwayMonths === null ? null : (() => {
      const tot = now.getMonth() + runwayMonths;
      return monthNames[tot % 12] + " " + (now.getFullYear() + Math.floor(tot / 12));
    })();

    const pctOf = (v: number) => baseCapital > 0 ? 100 * v / baseCapital : 0;
    return {
      rows: [
        { key: "cash",   label: "Bucket 1 · cash",   yrs: b1Yrs, amount: b1, pct: pctOf(b1), color: "#1D9E75" },
        { key: "bonds",  label: "Bucket 2 · bonds",  yrs: b2Yrs, amount: b2, pct: pctOf(b2), color: "#378ADD" },
        { key: "equity", label: "Bucket 3 · equity", yrs: b3Yrs, amount: Math.max(0, b3), pct: pctOf(Math.max(0, b3)), color: "#8B5CF6" },
      ],
      overCommitted, shortfall: overCommitted ? -b3 : 0,
      runwayMonths, runwayEnds, b1Yrs, b2Yrs, b3Yrs, baseCapital, atRetirement: twoPhaseView,
    };
  })();

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

    // Retirement pivot, shared by every projection below so the stochastic paths, the
    // guardrail's trajectory and the fixed-return line all switch phase at the same month.
    const twoPhase = retireMonths > 0;
    const retireM = Math.min(retireMonths, months);
    // Income at retirement, on one of three bases:
    //   today   - entered in today's money, carried forward by inflation to the pivot
    //   atRet   - entered as the actual figure drawn on the retirement date, used as given
    //   percent - read off whatever that path accumulated, so it adapts to the balance
    const incomeAtRetirement = (balAtRet: number) =>
      wBasis === "percent" ? balAtRet * (wPct / 100) / 12
      : wBasis === "atRet" ? withdraw
      : withdraw * Math.pow(1 + inflation / 100, retireM / 12);

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
      let val = init, curW = twoPhase ? 0 : withdraw, curC = contrib;
      const arr = [val];
      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          if (wEsc > 0 && (!twoPhase || m > retireM)) curW *= (1 + wEsc);
          if (cEsc > 0 && (!twoPhase || m <= retireM)) curC *= (1 + cEsc);
        }
        // Same pivot as the simulated paths, so the yardstick stays comparable to them.
        if (twoPhase && m === retireM) { curW = incomeAtRetirement(val); curC = 0; }
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
      // In two-phase mode the income is unknown until the plan reaches retirement, so it
      // starts at zero and is set once, at the pivot, from that path's own balance.
      let val = init, curW = twoPhase ? 0 : withdraw, curC = contrib, yrStart = init;
      let balAtRetirement = twoPhase ? 0 : init;
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

          // Escalation belongs to whichever phase the plan is in: contributions grow while
          // working, income grows once drawing. The withdrawal rules only apply in drawdown.
          const drawing = !twoPhase || m > retireM;
          if (wEsc > 0 && drawing) {
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
          if (cEsc > 0 && (!twoPhase || m <= retireM)) curC *= (1 + cEsc);
          yrStart = val;
          wpath.push(curW);
        } else if (m === 0) {
          yrStart = val;
        }

        // The pivot. Income is fixed here, from the balance this path actually reached.
        if (twoPhase && m === retireM) {
          balAtRetirement = val;
          curW = incomeAtRetirement(val);
          curC = 0;
        }

        if (lumpMap[m]) val += lumpMap[m];
        val = val * (1 + monthlyReturns[m]) + curC - curW;
        if (val < 0) val = 0;
        if ((m + 1) % 12 === 0) path.push(val);
      }
      return { final: val, path, wpath, freezeYears, skips, incs, signs, balAtRetirement };
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
    // Two-phase plans do draw eventually, so the diagnostic applies to them as well. On a
    // percentage basis the income comes from the balance, so the entered amount is irrelevant.
    const healthOn = twoPhase
      ? (wBasis === "percent" ? wPct > 0 : withdraw > 0)
      : withdraw > 0;

    // ---- Calibration: what happens to a plan like this if nothing is adjusted ----
    // Always run unruled. That keeps the health rule honest (it cannot consult odds derived
    // from its own interventions) and makes the quoted odds mean "if no change is made",
    // which is the only reading under which a warning sign says anything useful.
    // A few thousand paths is ample, so this is capped independently of the display sample.
    //
    // Odds come from the nearest readings rather than a fixed histogram. Binning made the bin
    // width a free parameter that nobody had chosen on principle, yet it reached into the
    // freeze decision: two plans either side of an edge could get materially different odds,
    // and any bin under the minimum sample count dropped out of the average entirely. Taking
    // the K nearest readings removes the edges, guarantees a sample for every query, and lets
    // the threshold land anywhere instead of snapping to a grid.
    const cal = (() => {
      if (!healthOn) return null;
      const CAL_N = Math.min(N, 2500);
      const KEYS = ["negYears", "bigLosses", "overdrawn", "ncav", "moro", "aer", "distRate", "sd", "scav"];
      const worseWhenHigher: Record<string, boolean> = {
        negYears: true, bigLosses: true, overdrawn: true, ncav: true,
        moro: true, distRate: true, sd: true, scav: true,
        aer: false,   // a low erosion rate is the danger signal
      };

      // Per sign, per year: readings collected then sorted, with a running count of failures
      // so any window's failure rate is a subtraction.
      const vals: Record<string, Record<number, number[]>> = {};
      const fails: Record<string, Record<number, number[]>> = {};
      KEYS.forEach(k => { vals[k] = {}; fails[k] = {}; });

      for (let i = 0; i < CAL_N; i++) {
        const r = runOnePath(genReturns(), false, true);      // unruled
        const isFail = r.final <= 0.40 * init ? 1 : 0;         // Sandidge's <40% criterion
        r.signs.forEach(s => {
          KEYS.forEach(k => {
            (vals[k][s.yr] ??= []).push((s as any)[k]);
            (fails[k][s.yr] ??= []).push(isFail);
          });
        });
      }

      // Sort each series by reading and build the cumulative failure count.
      const sorted: Record<string, Record<number, { v: number[]; cum: number[] }>> = {};
      KEYS.forEach(k => {
        sorted[k] = {};
        for (const yrStr of Object.keys(vals[k])) {
          const yr = Number(yrStr);
          const v = vals[k][yr], f = fails[k][yr];
          const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
          const sv = new Array<number>(idx.length);
          const cum = new Array<number>(idx.length + 1);
          cum[0] = 0;
          for (let i = 0; i < idx.length; i++) {
            sv[i] = v[idx[i]];
            cum[i + 1] = cum[i] + f[idx[i]];
          }
          sorted[k][yr] = { v: sv, cum };
        }
      });

      const K_NEIGH = 200;
      // Lowest index whose reading is >= x.
      const lowerBound = (a: number[], x: number) => {
        let lo = 0, hi = a.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
        return lo;
      };
      // Failure rate over the K readings nearest to index `at`, clamped to the array.
      const rateAt = (s: { v: number[]; cum: number[] }, at: number): number => {
        const n = s.v.length;
        const half = Math.min(K_NEIGH, n) >> 1;
        let lo = at - half, hi = lo + Math.min(K_NEIGH, n);
        if (lo < 0) { lo = 0; hi = Math.min(K_NEIGH, n); }
        if (hi > n) { hi = n; lo = Math.max(0, n - Math.min(K_NEIGH, n)); }
        return (s.cum[hi] - s.cum[lo]) / (hi - lo);
      };

      const rateOf = (k: string, yr: number, v: number): number | null => {
        const s = sorted[k]?.[yr];
        if (!s || !s.v.length) return null;
        return rateAt(s, lowerBound(s.v, v));
      };
      const afrOf = (sg: VitalSigns): number | null => {
        const rs = KEYS.map(k => rateOf(k, sg.yr, (sg as any)[k])).filter((r): r is number => r !== null);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
      };

      // The reading at which the odds first reach even. Walking the sorted readings means the
      // answer is an actual observed value rather than a grid point.
      //
      // Three outcomes, and they must stay distinct: a target exists; no reading is bad enough
      // to reach even odds ("allSafe"); or even the best reading observed is already worse than
      // even ("noneSafe"). The last happens on a badly stretched plan, where the sign carries
      // no reassuring level at all. Collapsing those two ends into one empty value would show
      // the same thing for opposite situations - and reporting the boundary as a number would
      // print targets like "fewer than 0 negative years".
      const thresholdOf = (k: string, yr: number): ThresholdResult => {
        const s = sorted[k]?.[yr];
        if (!s || !s.v.length) return { kind: "allSafe" };
        const n = s.v.length;
        const best = worseWhenHigher[k] ? 0 : n - 1;          // index of the most reassuring reading
        if (rateAt(s, best) >= 0.5) return { kind: "noneSafe" };
        if (worseWhenHigher[k]) {
          for (let i = 1; i < n; i++) if (rateAt(s, i) >= 0.5) return { kind: "at", value: s.v[i] };
        } else {
          for (let i = n - 2; i >= 0; i--) if (rateAt(s, i) >= 0.5) return { kind: "at", value: s.v[i] };
        }
        return { kind: "allSafe" };
      };

      return { KEYS, rateOf, afrOf, thresholdOf, worseWhenHigher };
    })();

    // Arm the health rule now that the unruled odds exist.
    if (cal) afrLookup = cal.afrOf;

    const allSigns: VitalSigns[][] = [];
    const retBalances: number[] = [];   // balance each path reached at the retirement pivot

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
      if (twoPhase) retBalances.push(r.balAtRetirement);
    }

    // ---- Portfolio health (Sandidge's vital signs) ----
    // Reads the median simulated path against the unruled calibration above, so the odds
    // shown mean "if no cash-flow change is made from here". Must run before finals is
    // sorted below, since the ordering is what ties a path to its recorded signs.
    const health: HealthStats | null = (() => {
      if (!healthOn || !allSigns.length || !cal) return null;
      // Sandidge publishes a target per sign per year; his tables are proprietary, so the
      // equivalent is derived from this run — the reading at which the odds of failing pass
      // 50%. Targets must be year-specific: five negative years is alarming by year 5 and
      // unremarkable by year 25, so a fixed target would flag healthy plans as failing.
      // Both the odds and the target come from the calibration, which reads the nearest
      // observations rather than a fixed grid, so a target can be any observed value.
      const { rateOf, afrOf, thresholdOf, worseWhenHigher } = cal;

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
        // Thresholds are now observed values rather than whole numbers off a grid, so show a
        // decimal. Adding zero turns a rounded -0 back into 0, which would otherwise print
        // as "-0%".
        ["aer",       "Erosion rate",        s => s.aer * 100,   t => (Number(t.toFixed(1)) + 0).toFixed(1) + "%"],
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
          // noneSafe cannot be met by any reading, so the sign never reads ok there.
          const ok = thr.kind === "allSafe" ? true
                   : thr.kind === "noneSafe" ? false
                   : (higherWorse ? raw < thr.value : raw > thr.value);
          const goal = thr.kind === "allSafe" ? "any"
                     : thr.kind === "noneSafe" ? "none safe"
                     : (higherWorse ? "< " : "> ") + fmtT(thr.value);
          return {
            key, label, goal,
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
        // Signs are taken at each year boundary, and the final year's boundary falls outside
        // the loop, so the last year with a reading is years-1. Cap the selector there rather
        // than letting it land on a year with no data.
        maxYear: Math.max(1, years - 1),
      };
    })();

    finals.sort((a, b) => a - b);
    const pct = (p: number) => finals[Math.floor(p / 100 * N)];

    const p5a: number[] = [], p50a: number[] = [], p75a: number[] = [], p95a: number[] = [];
    const w5a: number[] = [], w50a: number[] = [], w75a: number[] = [], w95a: number[] = [];

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
      let val = init, curW = twoPhase ? 0 : withdraw, curC = contrib;
      const path = [val];
      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          const yr = m / 12;
          if (wEsc > 0 && (!twoPhase || m > retireM)) {
            const skip = skipMode === "fixed" ? (yr % skipEvery === 0) : false;
            if (!skip) curW *= (1 + wEsc);
          }
          if (cEsc > 0 && (!twoPhase || m <= retireM)) curC *= (1 + cEsc);
        }
        if (twoPhase && m === retireM) { curW = incomeAtRetirement(val); curC = 0; }
        if (lumpMap[m]) val += lumpMap[m];
        val = val * (1 + muM) + curC - curW;
        if (val < 0) val = 0;
        if ((m + 1) % 12 === 0) path.push(val);
      }
      return path;
    })();

    // Linear withdrawal path
    const linW = (() => {
      // Reads the income off the fixed-return path so a percentage basis reflects the balance
      // that path actually reaches; nothing is drawn before retirement.
      let curW = twoPhase ? 0 : withdraw;
      const path = [curW * 12];
      for (let yr = 1; yr <= years; yr++) {
        if (twoPhase && yr * 12 > retireM && curW === 0) curW = incomeAtRetirement(linPort[Math.floor(retireM / 12)] ?? 0);
        else if (!twoPhase || yr * 12 > retireM) {
          const skip = skipMode === "fixed" ? (yr % skipEvery === 0) : false;
          if (!skip && wEsc > 0) curW *= (1 + wEsc);
        }
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

    // ---- Funding position, for saving plans rather than drawdown ----
    // linPort is already the deterministic no-volatility projection, so the funding ratio is
    // just median ÷ plan and needs no extra simulation.
    const funding: FundingStats | null = (() => {
      if (healthOn) return null;                  // drawdown gets the health diagnostic instead
      if (contrib <= 0 && !lumps.length) return null;   // nothing being saved

      const plannedFinal = linPort[linPort.length - 1];
      const fundingByYear = linPort.map((plan, y) => plan > 0 ? (p50a[y] ?? 0) / plan : 1);

      // Deterministic outcome for a given monthly contribution, used to solve the shortfall.
      const finalFor = (c: number) => {
        let val = init, cur = c;
        for (let m = 0; m < months; m++) {
          if (m > 0 && m % 12 === 0 && cEsc > 0) cur *= (1 + cEsc);
          if (lumpMap[m]) val += lumpMap[m];
          val = val * (1 + muM) + cur;
        }
        return val;
      };

      let requiredContrib: number | null = null;
      if (savingsTarget > 0) {
        if (finalFor(0) >= savingsTarget) {
          requiredContrib = 0;                    // existing capital alone gets there
        } else {
          // Monotonic in c, so bisect. Bail out rather than report a number off the top end.
          let lo = 0, hi = Math.max(contrib * 10, 1e6);
          let guard = 0;
          while (finalFor(hi) < savingsTarget && guard++ < 40) hi *= 2;
          if (finalFor(hi) >= savingsTarget) {
            for (let i = 0; i < 60; i++) {
              const mid = (lo + hi) / 2;
              if (finalFor(mid) < savingsTarget) lo = mid; else hi = mid;
            }
            requiredContrib = hi;
          }
        }
      }

      return {
        target: savingsTarget,
        plannedFinal,
        medianFinal: pct(50),
        downsideFinal: pct(25),
        probTarget: savingsTarget > 0 ? 100 * finals.filter(f => f >= savingsTarget).length / N : null,
        fundingByYear,
        requiredContrib,
        maxYear: years,
      };
    })();

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
      retirement: twoPhase && retBalances.length ? (() => {
        const rb = retBalances.slice().sort((a, b) => a - b);
        const at = (p: number) => rb[Math.min(rb.length - 1, Math.floor(p / 100 * rb.length))];
        const med = at(50);
        return { year: Math.round(retireM / 12), p5: at(5), p50: med, p95: at(95), medianIncome: incomeAtRetirement(med) };
      })() : null,
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
      funding,
    });
    // healthYear is deliberately NOT a dependency — it only picks which precomputed year
    // the diagnostic displays, so moving it must not trigger another simulation run.
  }, [init, contrib, contribEsc, withdraw, escMode, customEsc, skipMode, skipEvery, guardBand, healthThreshold, savingsTarget, retireMonths, wBasis, wPct, ret, vol, years, sims, effEsc, lumps, inflation, otherFees]);

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

  // Health-over-time chart — Sandidge's figure 8. Plotting the two groups separately is the
  // point: it shows the odds pulling apart years before either group's balance looks unusual.
  useEffect(() => {
    if (!chartReady || !results || !results.health || !c3Ref.current) return;
    if (c3Inst.current) c3Inst.current.destroy();
    const h = results.health;
    const asPct = (a: (number | null)[]) => a.map(v => v === null ? null : Math.round(v * 1000) / 10);

    // The 50% line is the decision boundary — above it, plans with these readings failed
    // more often than not — so draw it rather than leaving the reader to eyeball the axis.
    const evenOdds = {
      id: "evenOdds", afterDraw(ch: any) {
        const { ctx: c, scales: { x, y } } = ch;
        const yp = y.getPixelForValue(50);
        if (!isFinite(yp)) return;
        c.save();
        c.beginPath(); c.moveTo(x.left, yp); c.lineTo(x.right, yp);
        c.strokeStyle = "rgba(120,120,120,.55)"; c.lineWidth = 1; c.setLineDash([5, 4]); c.stroke();
        c.setLineDash([]); c.fillStyle = "rgba(120,120,120,.9)"; c.font = "10px sans-serif";
        c.textAlign = "left"; c.fillText("even odds", x.left + 4, yp - 3);
        c.restore();
      }
    };

    c3Inst.current = new window.Chart(c3Ref.current.getContext("2d"), {
      type: "line",
      data: {
        labels: results.labels,
        datasets: [
          { label: "Ended below 40% of capital", data: asPct(h.afrDepleted), borderColor: COLORS.p10, borderWidth: 2, pointRadius: 0, tension: .35, fill: false, spanGaps: true },
          { label: "Came through", data: asPct(h.afrSurvived), borderColor: COLORS.p50, borderWidth: 2.5, pointRadius: 0, tension: .35, fill: false, spanGaps: true },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
        scales: {
          x: { ticks: { color: "#999", font: { size: 10 }, autoSkip: true, maxTicksLimit: 10 }, grid: { color: "rgba(0,0,0,.05)" } },
          y: { min: 0, max: 100, ticks: { color: "#999", font: { size: 10 }, callback: (v: any) => v + "%" }, grid: { color: "rgba(0,0,0,.05)" } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: ${c.raw === null ? "—" : c.raw + "%"}` } }
        }
      },
      plugins: [evenOdds]
    });
  }, [results, chartReady]);

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
  // showBand=false for charts that have no shaded percentile band to explain.
  const legend = (items: [string, string, boolean][], showBand = true) => (
    <div style={{ display: "flex", gap: 14, marginBottom: 8, fontSize: 11, color: "#888", flexWrap: "wrap" }}>
      {items.map(([c, l, d]) => (
        <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ display: "inline-block", width: 20, height: 2, background: c, opacity: d ? .7 : 1 }} />{l}
        </span>
      ))}
      {showBand && (
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ display: "inline-block", width: 12, height: 10, background: "rgba(136,135,128,.2)", borderRadius: 2 }} />band
        </span>
      )}
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
        {/* Only a saving plan has a target to fund; a drawdown plan is judged on lasting instead. */}
        {withdraw === 0 && (
          <>
            {sRowN("Savings goal (R, 0 = none)", 0, 500000000, 100000, savingsTarget, setSavingsTarget, "R", savingsTarget > 0 ? "#185FA5" : undefined)}
            {savingsTarget > 0 && results && results.funding && results.funding.probTarget !== null && (
              <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
                Chance of reaching it: <strong style={{ color: results.funding.probTarget >= 75 ? "#1D9E75" : results.funding.probTarget >= 50 ? "#BA7517" : "#D85A30" }}>{Math.round(results.funding.probTarget)}%</strong>
              </div>
            )}
          </>
        )}

        {hr}
        {secLabel("Withdrawal")}
        {/* Retirement date. Blank means the plan is drawing now, which is how it behaved
            before this existed; a future date makes it contribute first and draw afterwards. */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 3 }}>Retirement date</div>
          <input type="month" value={retireDate} onChange={e => setRetireDate(e.target.value)}
            style={{ width: "100%", padding: "5px 8px", fontSize: 12, fontWeight: 600, borderRadius: 6, border: "1px solid #ccc", background: "#fff", color: retireMonths > 0 ? "#185FA5" : "#888" }} />
          <div style={{ fontSize: 11, color: retireMonths > 0 ? "#185FA5" : "#aaa", marginTop: 3 }}>
            {retireLabel}{retireDate && retireMonths === 0 ? " — date is not in the future" : ""}
          </div>
        </div>
        {retireMonths > 0 && (
          <div style={{ fontSize: 11, color: "#185FA5", background: "#f0f6fd", border: "1px solid #c5dcf5", borderRadius: 6, padding: "7px 9px", marginBottom: 10 }}>
            Contributions run to that date, then stop and income starts, leaving {Math.max(0, years - Math.round(retireMonths / 12))} yrs of drawdown within the {years}-yr horizon.
            {retireMonths / 12 >= years && <> <strong>The date falls outside the horizon</strong> — lengthen it to see any drawdown.</>}
          </div>
        )}
        {retireMonths > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Income is set as</div>
            <select value={wBasis} onChange={e => setWBasis(e.target.value)}
              style={{ width: "100%", padding: "6px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333", cursor: "pointer", marginBottom: 10 }}>
              <option value="today">An amount in today's money</option>
              <option value="atRet">An amount at the retirement date</option>
              <option value="percent">A % of the balance then</option>
            </select>
          </>
        )}
        {retireMonths > 0 && wBasis === "percent"
          ? sRow("Draw at retirement (%/yr)", 1, 12, 0.25, wPct, setWPct, wPct.toFixed(2) + "% of balance", "#D85A30")
          : sRowN(retireMonths === 0 ? "Monthly withdrawal (R)"
                  : wBasis === "atRet" ? "Monthly income at retirement (R)"
                  : "Monthly income wanted (R, today's money)",
                  0, 500000, 1000, withdraw, setWithdraw, "R", withdraw > 0 ? "#D85A30" : undefined)}
        {retireMonths > 0 && wBasis === "today" && withdraw > 0 && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            Carried forward by inflation, that is <strong style={{ color: "#D85A30" }}>{fmt(withdraw * Math.pow(1 + inflation / 100, retireMonths / 12))}</strong>/mo on the retirement date
          </div>
        )}
        {retireMonths > 0 && wBasis === "atRet" && withdraw > 0 && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            Taken as entered, so in today's money that is <strong style={{ color: "#D85A30" }}>{fmt(withdraw / Math.pow(1 + inflation / 100, retireMonths / 12))}</strong>/mo
          </div>
        )}
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

        {/* Bucket structure — display only, so these inputs never re-run the simulation. */}
        {bucketView && (
          <>
            {hr}
            {secLabel("Bucket structure")}
            <div style={{ fontSize: 11, color: "#888", marginTop: -4, marginBottom: 8 }}>
              Splits the opening capital by how many years of withdrawals each bucket covers. Presentation only — it does not change the simulation.
            </div>
            {sRow("Bucket 1 · cash (years)", 0, Math.max(1, years), 1, bucket1Years, setBucket1Years, bucketView.b1Yrs + (bucketView.b1Yrs === 1 ? " yr" : " yrs"), "#1D9E75")}
            {sRow("Bucket 2 · bonds (years)", 0, Math.max(1, years), 1, bucket2Years, setBucket2Years, bucketView.b2Yrs + (bucketView.b2Yrs === 1 ? " yr" : " yrs"), "#378ADD")}
            <div style={{ fontSize: 11, color: "#888", marginTop: -4, marginBottom: 8 }}>
              Bucket 3 · equity takes the remaining <strong style={{ color: "#8B5CF6" }}>{bucketView.b3Yrs} {bucketView.b3Yrs === 1 ? "yr" : "yrs"}</strong>
            </div>
          </>
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
        {sRow("Time horizon (years)", 5, 70, 1, years, setYears, years + " yrs")}
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

        {/* Retirement pivot — the handover point between saving and drawing. */}
        {results && results.retirement && (() => {
          const rt = results.retirement;
          const cell = (label: string, value: string, color: string, sub?: string) => (
            <div style={{ flex: 1, minWidth: 120, padding: "8px 12px", borderLeft: "1px solid #eee" }}>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 600, color }}>{value}</div>
              {sub && <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>{sub}</div>}
            </div>
          );
          return (
            <div style={{ borderTop: "1px solid #eee", background: "#f7fafd" }}>
              <div style={{ padding: "10px 16px 0", fontSize: 12, fontWeight: 600, color: "#444" }}>
                At retirement · year {rt.year}
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}> · what the saving phase hands over to the drawdown phase</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", padding: "8px 4px 6px" }}>
                {cell("Median balance", fmt(rt.p50), COLORS.p50, "50th percentile")}
                {cell("Best case", fmt(rt.p95), COLORS.p95, "95th percentile")}
                {cell("Conservative", fmt(rt.p5), COLORS.p10, "5th percentile")}
                {cell("Starting income", fmt(rt.medianIncome) + "/mo",
                      "#D85A30",
                      wBasis === "percent" ? `${wPct.toFixed(2)}% of the median balance` : "in the rands of that year")}
              </div>
              <div style={{ fontSize: 10, color: "#bbb", padding: "0 16px 12px" }}>
                {wBasis === "percent"
                  ? <>Each path draws {wPct.toFixed(2)}% of the balance it actually reached, so income varies with how the saving phase went. The figure shown is for the median path.</>
                  : <>Every path draws the same income regardless of what it accumulated, so a path that saved poorly carries the same demand as one that did well. That is what the success rate is testing.</>}
              </div>
            </div>
          );
        })()}

        {/* Bucket structure — a view of the opening capital, not a simulation output.
            Everything here comes from bucketView, which the engine never sees. */}
        {bucketView && (
          <div style={{ borderTop: "1px solid #eee", background: "#fcfdfc" }}>
            <div style={{ padding: "10px 16px 0", fontSize: 12, fontWeight: 600, color: "#444" }}>
              {bucketView.atRetirement ? "Bucket structure at retirement" : "Bucket structure at outset"}
              <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}>
                {bucketView.atRetirement
                  ? ` · how the median ${fmt(bucketView.baseCapital)} handed over covers the income schedule`
                  : ` · how the opening ${fmt(bucketView.baseCapital)} covers the withdrawal schedule`}
              </span>
            </div>

            {/* Proportional bar */}
            <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", margin: "10px 16px 8px", background: "#eee" }}>
              {bucketView.rows.map(r => (
                <div key={r.key} title={`${r.label}: ${fmt(r.amount)}`}
                  style={{ width: Math.max(0, r.pct) + "%", background: r.color }} />
              ))}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", padding: "0 4px 8px" }}>
              {bucketView.rows.map(r => (
                <div key={r.key} style={{ flex: 1, minWidth: 130, padding: "6px 12px", borderLeft: "1px solid #eee" }}>
                  <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: r.color, marginRight: 5 }} />
                    {r.label}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: r.color }}>{fmt(r.amount)}</div>
                  <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>
                    {r.pct.toFixed(1)}% of capital · {r.yrs} {r.yrs === 1 ? "yr" : "yrs"} of withdrawals
                  </div>
                </div>
              ))}
            </div>

            {bucketView.overCommitted && (
              <div style={{ fontSize: 11, color: "#993C1D", background: "#fff7ed", border: "1px solid #f5c4b3", borderRadius: 6, padding: "7px 9px", margin: "0 16px 8px" }}>
                Cash and bonds as specified need {fmt(bucketView.shortfall)} more than the whole portfolio, so there is nothing left for equity. Shorten the cash or bond horizon, or revisit the withdrawal.
              </div>
            )}

            {bucketView.runwayEnds && !bucketView.overCommitted && (
              <div style={{ fontSize: 11, color: "#888", padding: "0 16px 6px" }}>
                Illustration: left to run down on its own at the expected return, bucket 1 would last until <strong style={{ color: "#555" }}>{bucketView.runwayEnds}</strong> ({Math.floor((bucketView.runwayMonths ?? 0) / 12)} yrs {(bucketView.runwayMonths ?? 0) % 12} mths). Volatility is ignored, and nothing is topped up from the other buckets.
              </div>
            )}

            <div style={{ fontSize: 10, color: "#bbb", padding: "0 16px 12px" }}>
              This split illustrates the withdrawal and liquidity structure only. It does not change the return assumptions: the success rate, terminal values and every other figure on this page still come from one blended return and volatility applied to the whole portfolio. Adjusting the bucket years moves the numbers in this panel and nothing else.
            </div>
          </div>
        )}

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

              {/* How the two groups pull apart over time */}
              <div style={{ padding: "0 16px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#444", marginBottom: 8 }}>Health score over time</div>
                {legend([[COLORS.p10, "Ended below 40% of capital", false], [COLORS.p50, "Came through", false]], false)}
                <div style={{ position: "relative", height: 170 }}><canvas ref={c3Ref} /></div>
                <div style={{ fontSize: 10, color: "#bbb", marginTop: 6 }}>
                  Both groups start close together, so early on the score says little on its own. The gap opens well before either group's balance looks unusual, which is the case for reading these signs early rather than waiting for the value to tell you.
                </div>
              </div>
            </div>
          );
        })()}

        {/* Funding position — saving plans. Mutually exclusive with the health panel above,
            which is why both can share the healthYear selector without clashing. */}
        {results && results.funding && (() => {
          const fd = results.funding;
          const yr = Math.min(Math.max(healthYear, 1), fd.maxYear);
          const ratio = fd.fundingByYear[yr] ?? 1;
          const pct100 = Math.round(ratio * 100);
          // Volatility drag means the median sits below the fixed-return plan even when
          // nothing has gone wrong, so "on track" cannot be pinned at exactly 100%.
          const col = pct100 >= 95 ? "#1D9E75" : pct100 >= 80 ? "#BA7517" : "#D85A30";
          const word = pct100 >= 95 ? "On track" : pct100 >= 80 ? "Slightly behind" : "Behind plan";
          const r = 26, circ = 2 * Math.PI * r;
          const shortfall = fd.target > 0 ? fd.target - fd.medianFinal : 0;
          const cell = (label: string, value: string, color: string, sub?: string) => (
            <div style={{ flex: 1, minWidth: 108, padding: "8px 12px", borderLeft: "1px solid #eee" }}>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 16, fontWeight: 600, color }}>{value}</div>
              {sub && <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>{sub}</div>}
            </div>
          );
          return (
            <div style={{ borderTop: "1px solid #eee", background: "#fdfdfb" }}>
              <div style={{ padding: "10px 16px 0", fontSize: 12, fontWeight: 600, color: "#444" }}>
                Funding position · year {yr}
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}> · for a saving plan the question is whether it is on track, not whether momentum has turned</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", padding: "8px 16px 4px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 18 }}>
                  <svg width={64} height={64} viewBox="0 0 64 64">
                    <circle cx={32} cy={32} r={r} fill="none" stroke="#eee" strokeWidth={7} />
                    <circle cx={32} cy={32} r={r} fill="none" stroke={col} strokeWidth={7}
                      strokeDasharray={`${circ * Math.max(0, Math.min(100, pct100)) / 100} ${circ}`} strokeLinecap="round" transform="rotate(-90 32 32)" />
                    <text x={32} y={36} textAnchor="middle" fontSize={11} fontWeight={600} fill={col}>{pct100}%</text>
                  </svg>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: col }}>{word}</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>of the plan</div>
                    <div style={{ fontSize: 10, color: "#bbb" }}>median ÷ fixed return</div>
                  </div>
                </div>
                {cell("Median outcome", fmt(fd.medianFinal), COLORS.p50, `plan says ${fmt(fd.plannedFinal)}`)}
                {cell("Plausible bad case", fmt(fd.downsideFinal), "#D85A30", "1 path in 4 lands here or lower")}
                {fd.target > 0 && fd.probTarget !== null &&
                  cell("Chance of goal", Math.round(fd.probTarget) + "%", fd.probTarget >= 75 ? "#1D9E75" : fd.probTarget >= 50 ? "#BA7517" : "#D85A30", `goal ${fmt(fd.target)}`)}
                {fd.target > 0 && fd.requiredContrib !== null &&
                  cell("Contribution needed", fmt(fd.requiredContrib) + "/mo",
                       fd.requiredContrib > contrib ? "#D85A30" : "#888",
                       fd.requiredContrib > contrib ? `${fmt(fd.requiredContrib - contrib)}/mo more than now` : "on the central projection only")}
                <div style={{ flex: 1, minWidth: 150, borderLeft: "1px solid #eee", paddingLeft: 18 }}>
                  {sRow("Report on year", 1, Math.max(1, fd.maxYear), 1, healthYear, setHealthYear, "Yr " + yr, "#185FA5")}
                </div>
              </div>
              <div style={{ fontSize: 10, color: "#bbb", padding: "0 16px 12px" }}>
                {fd.target > 0 ? (
                  <>
                    {shortfall > 0
                      ? <>On the median path this plan lands {fmt(shortfall)} short of the goal. </>
                      : <>The median path clears the goal, but that is only the middle outcome. </>}
                    "Contribution needed" is what reaches the goal on the fixed-return projection, which ignores ups and downs, so it is a floor rather than a safe number — clearing the goal on that projection still leaves roughly even odds in practice. The "chance of goal" figure is the one that accounts for volatility.
                  </>
                ) : (
                  <>Momentum warnings are deliberately not shown here. With contributions going in, account value rarely falls, so those signals have little to measure, and weak returns early actually help a saver by buying in cheaply. On track is judged against the fixed-return plan, which the median sits below even when nothing is wrong, because volatility drags compounding.</>
                )}
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
