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

/** One year of a real client's history: the balance it ended on and what was drawn during it. */
interface ActualYear { id: number; balance: number; withdrawal: number }

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
type MetricCard = [string, string, string, string, string | null, number | null, { earned: number; real: number | null; balance: number | null } | null];

/** Everything one simulation run produces, as consumed by the charts and cards. */
interface SimResults {
  p5: number; p50: number; p75: number; p95: number;
  pctSuccess: number; pctBeat: number; pctRuined: number;
  totalIn: number;
  /** Income actually paid out on the median path, nominal and in today's money. */
  drawnMedian: number; drawnMedianReal: number;
  /** Under a portfolio-linked policy: the typical yearly change in income, and how often it fell. */
  incomeAvgIncrease: number | null; incomeDropShare: number | null;
  p5a: number[]; p50a: number[]; p75a: number[]; p95a: number[];
  w5a: number[]; w50a: number[]; w75a: number[]; w95a: number[];
  linPort: number[]; linW: number[];
  dep: ByPercentile<string | null>;
  real: ByPercentile<number>;
  /** Per percentile: what the investments earned, that figure after inflation, and how the
   *  capital itself moved once contributions and withdrawals are counted. */
  avgReturn: ByPercentile<{ earned: number; real: number | null; balance: number | null }>;
  labels: string[];
  avgInc: string; avgSkip: string; finalContrib: number;
  expectedBalance: number[];
  /**
   * Failure-odds curves keyed by sign then year, as (reading, odds) points. Carried out of the
   * run so a real portfolio's figures can be read against them without simulating again.
   */
  curves: Record<string, Record<number, [number, number][]>> | null;
  /** Balance reached at the retirement pivot, across paths. Null for single-phase plans. */
  retirement: { year: number; p5: number; p50: number; p95: number; medianIncome: number } | null;
  guard: GuardStats | null;
  health: HealthStats | null;
  funding: FundingStats | null;
}

const COLORS = { p95: "#8B5CF6", p90: "#378ADD", p50: "#1D9E75", p10: "#D85A30", linear: "#f59e0b", actual: "#111827" };

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
  const [bucketsOn, setBucketsOn]       = useState(true);       // whether the overlay is shown at all
  const [bucket1Years, setBucket1Years] = useState(3);          // years of withdrawals held in the conservative bucket
  const [bucket2Years, setBucket2Years] = useState(4);          // years of withdrawals held in the moderate bucket
  // Retirement pivot. 0 keeps the original single-phase behaviour, where contributions and
  // withdrawals both run from the start; above 0 the plan contributes until that year and
  // draws afterwards, so one run can span working life and retirement.
  // What the plan covers. Previously implied by whether contributions, withdrawals and a
  // retirement date happened to be set; making it explicit means the sidebar can show only
  // the inputs that apply, and the engine is fed a consistent set rather than a leftover one.
  // Who the report is for and who prepared it. Record-keeping only — deliberately absent from
  // runSim's dependencies so a name can never move a number.
  const [clientName, setClientName]     = useState("");
  const [clientId, setClientId]         = useState("");
  const [clientDob, setClientDob]       = useState("");
  const [dobTouched, setDobTouched]     = useState(false);   // once edited by hand, the ID stops overwriting it
  const [adviserName, setAdviserName]   = useState("");
  const [fspPractice, setFspPractice]   = useState("");
  const [fspCode, setFspCode]           = useState("");
  const [adviserCode, setAdviserCode]   = useState("");

  // How the income is set each year. Lifestyle raises it by a fixed rate regardless of how
  // the portfolio is doing; endowment blends the previous amount with a percentage of the
  // portfolio's current value, so the income follows the capital instead of ignoring it.
  const [spendPolicy, setSpendPolicy]   = useState("lifestyle");  // "lifestyle" | "endowment"
  const [spendRate, setSpendRate]       = useState(5);            // % of portfolio the policy targets
  const [smoothing, setSmoothing]       = useState(90);           // % weight on last year's amount
  const [solveConf, setSolveConf]       = useState(90);           // confidence the solver aims at
  const [solved, setSolved]             = useState<{ rate: number; conf: number; years: number; capped: string | null;
                                                     base: number; atRet: boolean } | null>(null);

  const [planMode, setPlanMode]         = useState("post");     // "pre" | "post" | "both"
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
  const [actuals, setActuals]         = useState<ActualYear[]>([]);   // a real portfolio's history, for review rather than planning
  const [results, setResults]         = useState<SimResults | null>(null);
  const [chartReady, setChartReady]   = useState(false);
  const c1Ref = useRef<HTMLCanvasElement | null>(null); const c1Inst = useRef<any>(null);
  const c2Ref = useRef<HTMLCanvasElement | null>(null); const c2Inst = useRef<any>(null);
  const c3Ref = useRef<HTMLCanvasElement | null>(null); const c3Inst = useRef<any>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [planNote, setPlanNote] = useState<string | null>(null);

  /**
   * Everything that makes up a client's plan, as a name -> [value, setter] registry.
   * Kept as one list so saving and loading cannot drift apart — a field added here is written
   * and read back with no second place to update. Derived values (otherFees, retireMonths) and
   * results are deliberately absent: they are recomputed from the above, and storing them would
   * let a stale figure outlive the inputs that produced it.
   */
  const PLAN: Record<string, [any, (v: any) => void]> = {
    init: [init, setInit], contrib: [contrib, setContrib], contribEsc: [contribEsc, setContribEsc],
    withdraw: [withdraw, setWithdraw], escMode: [escMode, setEscMode], customEsc: [customEsc, setCustomEsc],
    skipMode: [skipMode, setSkipMode], skipEvery: [skipEvery, setSkipEvery], guardBand: [guardBand, setGuardBand],
    healthYear: [healthYear, setHealthYear], healthThreshold: [healthThreshold, setHealthThreshold],
    savingsTarget: [savingsTarget, setSavingsTarget],
    bucketsOn: [bucketsOn, setBucketsOn],
    bucket1Years: [bucket1Years, setBucket1Years], bucket2Years: [bucket2Years, setBucket2Years],
    clientName: [clientName, setClientName], clientId: [clientId, setClientId], clientDob: [clientDob, setClientDob],
    dobTouched: [dobTouched, setDobTouched], adviserName: [adviserName, setAdviserName],
    fspPractice: [fspPractice, setFspPractice], fspCode: [fspCode, setFspCode], adviserCode: [adviserCode, setAdviserCode],
    spendPolicy: [spendPolicy, setSpendPolicy], spendRate: [spendRate, setSpendRate], smoothing: [smoothing, setSmoothing],
    solveConf: [solveConf, setSolveConf], planMode: [planMode, setPlanMode], retireDate: [retireDate, setRetireDate],
    wBasis: [wBasis, setWBasis], wPct: [wPct, setWPct],
    ret: [ret, setRet], vol: [vol, setVol], years: [years, setYears], sims: [sims, setSims],
    inflation: [inflation, setInflation], adviceFee: [adviceFee, setAdviceFee], platformFee: [platformFee, setPlatformFee],
    modelRange: [modelRange, setModelRange], modelKey: [modelKey, setModelKey],
    lumps: [lumps, setLumps], actuals: [actuals, setActuals],
  };

  const PLAN_FORMAT = 1;

  // The values the fields start on, captured on the first render so "new client" has something
  // to reset to. Taken from the registry rather than written out a second time, so a default
  // changed at the useState above cannot drift from the one used here.
  const defaultsRef = useRef<Record<string, any> | null>(null);
  if (!defaultsRef.current) {
    const d: Record<string, any> = {};
    Object.entries(PLAN).forEach(([k, [v]]) => { d[k] = v; });
    defaultsRef.current = d;
  }

  const planJson = () => {
    const fields: Record<string, any> = {};
    Object.entries(PLAN).forEach(([k, [v]]) => { fields[k] = v; });
    return JSON.stringify({ format: PLAN_FORMAT, saved: new Date().toISOString(), fields }, null, 2);
  };

  /** File name for a client, from their name. Falls back so an unnamed plan still saves. */
  const planFileName = () =>
    ((clientName || "").replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-") || "client") + "-plan.json";

  /**
   * Apply a plan's text to the dashboard. Anything unrecognised is reported, never silently
   * applied. Returns whether it took, so callers know if there is now an open plan.
   */
  const applyPlanText = (txt: string): boolean => {
    let data: any;
    try { data = JSON.parse(txt); } catch { setPlanNote("That file is not a saved plan."); return false; }
    if (!data || typeof data !== "object" || !data.fields || typeof data.fields !== "object") {
      setPlanNote("That file is not a saved plan."); return false;
    }
    if (typeof data.format === "number" && data.format > PLAN_FORMAT) {
      setPlanNote("That plan was saved by a newer version of this tool."); return false;
    }
    try {
      // Apply only known fields, and only where the type matches what the field holds now, so a
      // hand-edited or truncated file cannot put the dashboard into a state the UI cannot render.
      let applied = 0; const skipped: string[] = [];
      Object.entries(PLAN).forEach(([k, [cur, set]]) => {
        if (!(k in data.fields)) return;
        const v = data.fields[k];
        const fits = Array.isArray(cur) ? Array.isArray(v) : v !== null && typeof v === typeof cur;
        if (fits) { set(v); applied++; } else skipped.push(k);
      });
      // Lumps and history carry ids from the session that saved them; move the counter past
      // them so a row added after loading cannot collide with one that came out of the file.
      // Re-check these are arrays: a field that failed the type gate above was skipped, not
      // removed, so the raw value here can still be anything the file happened to contain.
      const rows = (k: string) => Array.isArray(data.fields[k]) ? data.fields[k] : [];
      const ids = [...rows("lumps"), ...rows("actuals")]
        .map((x: any) => x && x.id).filter((n: any) => typeof n === "number");
      if (ids.length) uid = Math.max(uid, Math.max(...ids) + 1);
      // The results on screen belong to the inputs that have just been replaced.
      setResults(null); setSolved(null);
      setPlanNote(applied === 0 ? "Nothing in that file could be read."
        : "Loaded " + applied + " settings" + (skipped.length ? ", ignored " + skipped.length + " that did not fit" : "")
          + ". Run the simulation to see results.");
      return applied > 0;
    } catch { setPlanNote("That file could not be read as a plan."); return false; }
  };

  // ---------------------------------------------------------------------------------------
  // Client folder. Plans live as files in a folder the adviser nominates; the browser holds
  // only a handle to that folder, never the client details themselves. So the files stay
  // backed up and shareable wherever they were put, and nothing accumulates in browser storage.
  // Needs the File System Access API — elsewhere the save/open buttons carry on as before.
  // ---------------------------------------------------------------------------------------
  const FS_OK = typeof (window as any).showDirectoryPicker === "function";
  const [dirHandle, setDirHandle] = useState<any>(null);
  const [dirName, setDirName]     = useState("");
  const [dirBlocked, setDirBlocked] = useState(false);   // remembered, but permission not yet re-granted
  const [clientList, setClientList] = useState<{ label: string; file: string; saved: number; handle: any }[]>([]);
  const [listBusy, setListBusy]   = useState(false);
  const [curFile, setCurFile]     = useState<any>(null); // the file the open plan came from, so Save overwrites it
  const [tab, setTab]             = useState<"sim" | "clients">("sim");

  // A directory handle survives a reload, but the permission behind it does not always, and it
  // can only be re-granted from a click. Keep the handle in IndexedDB and ask on the next gesture.
  const idbDir = (v?: any) => new Promise<any>(res => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open("mcPlanStore", 1); } catch { res(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => res(null);
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction("kv", v === undefined ? "readonly" : "readwrite");
        const st = tx.objectStore("kv");
        if (v === undefined) { const g = st.get("dir"); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); }
        else { st.put(v, "dir"); tx.oncomplete = () => res(true); tx.onerror = () => res(null); }
      } catch { res(null); }
    };
  });

  /** Read the folder and list the plans in it. Files that are not plans are left out, not guessed at. */
  const listClients = async (h: any) => {
    setListBusy(true);
    const out: { label: string; file: string; saved: number; handle: any }[] = [];
    try {
      for await (const [name, handle] of (h as any).entries()) {
        if (handle.kind !== "file" || !/\.json$/i.test(name)) continue;
        try {
          const f = await handle.getFile();
          const d = JSON.parse(await f.text());
          if (!d || !d.fields) continue;
          out.push({ label: d.fields.clientName || name.replace(/\.json$/i, ""), file: name, saved: f.lastModified, handle });
        } catch { /* unreadable, or not one of ours — skip rather than show a broken row */ }
      }
      setDirBlocked(false);
    } catch {
      setDirBlocked(true);   // usually the permission lapsed rather than the folder vanishing
    }
    out.sort((a, b) => b.saved - a.saved);
    setClientList(out); setListBusy(false);
  };

  /**
   * "denied" and "prompt" need telling apart. A prompt can be answered; a denial cannot be
   * re-asked — requestPermission returns straight back without showing anything — and the only
   * way out is to pick the folder again. Reporting both as "not granted" left the folder
   * looking broken with nothing to do about it.
   */
  const dirAccess = async (h: any): Promise<"granted" | "denied" | "error"> => {
    try {
      if (await h.queryPermission({ mode: "readwrite" }) === "granted") return "granted";
      return await h.requestPermission({ mode: "readwrite" }) === "granted" ? "granted" : "denied";
    } catch { return "error"; }
  };

  const pickFolder = async () => {
    try {
      const h = await (window as any).showDirectoryPicker({ mode: "readwrite" });
      await idbDir(h);
      setDirHandle(h); setDirName(h.name); setDirBlocked(false);
      listClients(h);
      setPlanNote(null);
    } catch { /* the picker was dismissed */ }
  };

  const reconnectFolder = async () => {
    if (!dirHandle) return;
    const access = await dirAccess(dirHandle);
    if (access === "granted") { listClients(dirHandle); setPlanNote(null); return; }
    // Nothing appeared on screen when this happened, so say why and point at the way out.
    setPlanNote(access === "denied"
      ? "The browser is blocking " + dirName + " and will not ask again. Choose the folder again to restore access."
      : dirName + " could not be reached. It may have been moved or renamed.");
  };

  const forgetFolder = async () => {
    await idbDir(null);
    setDirHandle(null); setDirName(""); setClientList([]); setCurFile(null); setDirBlocked(false);
    setPlanNote("Folder forgotten. The files themselves are untouched.");
  };

  // Restore the nominated folder on load. Only list straight away if the permission is still
  // live; otherwise show a reconnect button, since asking again needs a click.
  useEffect(() => {
    if (!FS_OK) return;
    (async () => {
      const h = await idbDir();
      if (!h) return;
      setDirHandle(h); setDirName(h.name);
      try {
        if (await h.queryPermission({ mode: "readwrite" }) === "granted") listClients(h);
        else setDirBlocked(true);
      } catch { setDirBlocked(true); }
    })();
  }, []);

  const openClient = async (e: { handle: any; label: string }) => {
    try {
      const f = await e.handle.getFile();
      if (applyPlanText(await f.text())) { setCurFile(e.handle); setTab("sim"); }
    } catch { setPlanNote("That plan could not be opened."); }
  };

  /**
   * Clear the plan back to its defaults. Adviser and practice details are kept, since the next
   * client is almost always the same adviser's and re-typing them invites a wrong FSP code.
   */
  const newClient = () => {
    const keep = new Set(["fspPractice", "fspCode", "adviserName", "adviserCode"]);
    const d = defaultsRef.current!;
    Object.entries(PLAN).forEach(([k, [, set]]) => { if (!keep.has(k) && k in d) set(d[k]); });
    setResults(null); setSolved(null); setCurFile(null); setTab("sim");
    setPlanNote("Started a new client. Adviser details kept. Save to add them to the folder.");
  };

  /**
   * The report is the results panel with the controls dropped and the assumptions added, so it
   * needs the Simulator tab up and a run behind it. Print is handed to the browser, whose
   * "Save as PDF" destination produces the file — no PDF library, and it picks up the user's
   * own paper size and margins.
   */
  const printReport = () => {
    setTab("sim");
    // Let the tab switch paint first; printing from the same tick captures the Clients panel.
    setTimeout(() => window.print(), 80);
  };

  const downloadPlan = (txt: string) => {
    const url = URL.createObjectURL(new Blob([txt], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = planFileName();
    // In the document and revoked on a later tick: revoking straight after click() can cancel
    // the download before the browser has read the blob, and this is now the fallback that
    // stops a plan being lost when the folder is unavailable.
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 30000);
    setPlanNote("Saved " + a.download);
  };

  /**
   * Save to the nominated folder when there is one, otherwise fall back to a download.
   * An open plan is written back to the file it came from, so renaming a client updates the
   * record rather than leaving a second copy behind under the new name.
   */
  const savePlan = async () => {
    const txt = planJson();
    if (dirHandle) {
      const access = await dirAccess(dirHandle);
      if (access === "granted") {
        try {
          const fh = curFile || await dirHandle.getFileHandle(planFileName(), { create: true });
          const w = await fh.createWritable();
          await w.write(txt); await w.close();
          setCurFile(fh);
          setPlanNote("Saved to " + dirName + " · " + fh.name);
          listClients(dirHandle);
          return;
        } catch { /* folder reachable but the write failed — fall through rather than lose it */ }
      }
      // Whatever is wrong with the folder, the plan itself must still land somewhere. Failing
      // outright meant a client's details were simply gone when the button did nothing visible.
      downloadPlan(txt);
      setPlanNote(access === "denied"
        ? "The browser is blocking " + dirName + ", so the plan was downloaded instead. Choose the folder again on the Clients tab to save there."
        : "Could not write to " + dirName + ", so the plan was downloaded instead.");
      setDirBlocked(access === "denied");
      return;
    }
    downloadPlan(txt);
  };

  /** Open a plan the user picked by hand, from anywhere on disk. */
  const loadPlan = (file: File) => {
    const r = new FileReader();
    r.onload = () => {
      // Came from outside the folder, so there is no file to write back to until the next save.
      if (applyPlanText(String(r.result))) setCurFile(null);
    };
    // A throw inside onload is swallowed by the FileReader, which would leave the dashboard
    // half-loaded and the note still showing whatever it said before. Say so instead.
    const apply = r.onload as any;
    r.onload = (e: any) => { try { apply(e); } catch { setPlanNote("That file could not be read as a plan."); } };
    r.onerror = () => setPlanNote("That file could not be read.");
    r.readAsText(file);
  };

  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
    s.onload = () => setChartReady(true);
    document.head.appendChild(s);
  }, []);

  /**
   * Date of birth read off a South African ID number, whose first six digits are YYMMDD.
   * The century is not in the number, so it is inferred: a two-digit year at or below the
   * current one is treated as this century, otherwise the last. That is the usual convention
   * and only misreads someone over about a hundred, which the manual field then covers.
   */
  const dobFromId = (() => {
    const digits = clientId.replace(/\D/g, "");
    if (digits.length < 6) return null;
    const yy = +digits.slice(0, 2), mm = +digits.slice(2, 4), dd = +digits.slice(4, 6);
    if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return null;
    const year = yy <= new Date().getFullYear() % 100 ? 2000 + yy : 1900 + yy;
    const iso = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    const d = new Date(iso);
    // Rejects dates that do not exist, such as the 31st of February.
    if (isNaN(d.getTime()) || d.getMonth() + 1 !== mm || d.getDate() !== dd) return null;
    return iso;
  })();
  const idLooksComplete = clientId.replace(/\D/g, "").length === 13;

  // Fill from the ID until someone edits the field, after which their entry stands.
  useEffect(() => {
    if (dobFromId && !dobTouched) setClientDob(dobFromId);
  }, [dobFromId, dobTouched]);

  // Age from date of birth, purely so the entered date can be sanity-checked at a glance.
  const clientAge = (() => {
    if (!clientDob) return null;
    const d = new Date(clientDob);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let a = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
    return a >= 0 && a < 130 ? a : null;
  })();

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

  // What the engine actually receives, per mode. A pre-retirement plan never draws; a
  // post-retirement one never contributes and has no pivot; only a combined plan has both.
  // Deriving these once means an input left over from another mode cannot quietly apply.
  const effContrib       = planMode === "post" ? 0 : contrib;
  const effWithdrawInput = planMode === "pre"  ? 0 : withdraw;
  const effRetireMonths  = planMode === "both" ? retireMonths : 0;
  // Whether the plan draws at all. On a percentage basis there is no amount entered, so
  // anything gated on the withdrawal figure alone would wrongly hide itself.
  const planDraws = planMode === "pre" ? false
    // The endowment policy sets the income from its spending rate, so there is no entered
    // amount to test — checking one would hide the income figures on every endowment plan.
    : spendPolicy === "endowment" ? spendRate > 0
    : planMode === "both" ? (wBasis === "percent" ? wPct > 0 : withdraw > 0)
    : withdraw > 0;
  const retireLabel = (() => {
    if (!retireMonths) return "Already drawing";
    const y = Math.floor(retireMonths / 12), m = retireMonths % 12;
    return (y ? y + (y === 1 ? " yr " : " yrs ") : "") + (m ? m + " mths" : "") || "this month";
  })();

  /**
   * Review of a real portfolio. This is the use Sandidge's vital signs were built for: they
   * measure experience a portfolio has actually had, so on a plan that has not started they
   * carry almost nothing — at year one the paths that failed and the paths that came through
   * differ by about two points. Here they read a client's own figures against the odds the
   * simulation produced, which is what makes them worth acting on.
   *
   * Derived in render from the stored curves, so typing a balance re-reads the odds without
   * simulating again.
   */
  const review = (() => {
    const curves = results?.curves ?? null;
    if (!curves || actuals.length === 0) return null;

    const rateFrom = (key: string, yr: number, v: number): number | null => {
      const pts = curves[key]?.[yr];
      if (!pts || !pts.length) return null;
      if (v <= pts[0][0]) return pts[0][1];
      if (v >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
      for (let i = 1; i < pts.length; i++) {
        if (v <= pts[i][0]) {
          const [v0, r0] = pts[i - 1], [v1, r1] = pts[i];
          return v1 === v0 ? r1 : r0 + (v - v0) / (v1 - v0) * (r1 - r0);
        }
      }
      return pts[pts.length - 1][1];
    };

    // Walk the entered years, accumulating the same cumulative signs the simulation tracks.
    let prev = init;
    let negYears = 0, bigLosses = 0, overdrawn = 0, ncav = 0;
    let sumNegCav = 0, sumPosCav = 0, sumSqNegRet = 0, sumSqNegCav = 0;
    const rows: { yr: number; ret: number; sig: Record<string, number> }[] = [];

    actuals.forEach((a, i) => {
      const yr = i + 1;
      // The market return is implied: the balance had to get from last year's close to this
      // one after the withdrawal came out. Treating the withdrawal as taken at year end is an
      // approximation, and it slightly understates the return on a heavy drawdown.
      const mret = prev > 0 ? (a.balance + a.withdrawal) / prev - 1 : 0;
      const cav  = prev > 0 ? (a.balance - prev) / prev : 0;
      if (mret < 0) { negYears++; sumSqNegRet += mret * mret; }
      if (mret <= -0.05) bigLosses++;
      if (cav < 0) { ncav++; sumNegCav += -cav; sumSqNegCav += cav * cav; } else sumPosCav += cav;
      const distRate = a.balance > 0 ? a.withdrawal / a.balance * 100 : 0;
      if (distRate / 100 + otherFees / 100 > mret) overdrawn++;
      rows.push({
        yr, ret: mret,
        sig: {
          negYears, bigLosses, overdrawn, ncav,
          moro: sumPosCav > 0 ? (sumNegCav / sumPosCav) * 100 : (sumNegCav > 0 ? 999 : 0),
          aer: Math.pow(Math.max(a.balance, 1) / init, 1 / yr) - 1,
          distRate,
          sd: Math.sqrt(sumSqNegRet / yr) * 100,
          scav: Math.sqrt(sumSqNegCav / yr) * 100,
        },
      });
      prev = a.balance;
    });

    const latest = rows[rows.length - 1];
    const KEYS = ["negYears", "bigLosses", "overdrawn", "ncav", "moro", "aer", "distRate", "sd", "scav"];
    const odds = KEYS.map(k => rateFrom(k, latest.yr, latest.sig[k])).filter((r): r is number => r !== null);
    const afr = odds.length ? odds.reduce((a, b) => a + b, 0) / odds.length : null;

    // The same score for every year entered, so the trend is visible rather than just the latest.
    const afrByYear = rows.map(r => {
      const os = KEYS.map(k => rateFrom(k, r.yr, r.sig[k])).filter((x): x is number => x !== null);
      return os.length ? os.reduce((a, b) => a + b, 0) / os.length : null;
    });

    const label: Record<string, string> = {
      negYears: "Negative years", bigLosses: "Losses of 5%+", overdrawn: "Overdrawn years",
      ncav: "Years value fell", moro: "Momentum (MoRo)", aer: "Erosion rate",
      distRate: "Withdrawal rate", sd: "Downside spread", scav: "Value-change spread",
    };
    const shown: Record<string, (v: number) => string> = {
      negYears: v => String(v), bigLosses: v => String(v), overdrawn: v => String(v), ncav: v => String(v),
      moro: v => v >= 999 ? "all falls, no rises" : Math.round(v) + "%", aer: v => (v * 100).toFixed(1) + "%",
      distRate: v => v.toFixed(1) + "%", sd: v => v.toFixed(1) + "%", scav: v => v.toFixed(1) + "%",
    };
    const table = KEYS.map(k => ({
      key: k, label: label[k],
      value: shown[k](latest.sig[k]),
      odds: rateFrom(k, latest.yr, latest.sig[k]),
    }));

    const beyond = latest.yr > Math.max(1, years - 1);
    return { rows, latest, afr, afrByYear, table, beyond, moro: latest.sig.moro };
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
  const bucketViewRaw = (() => {
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
        { key: "cash",   label: "Bucket 1 · Conservative",   yrs: b1Yrs, amount: b1, pct: pctOf(b1), color: "#1D9E75" },
        { key: "bonds",  label: "Bucket 2 · Moderate",  yrs: b2Yrs, amount: b2, pct: pctOf(b2), color: "#378ADD" },
        { key: "equity", label: "Bucket 3 · Aggressive", yrs: b3Yrs, amount: Math.max(0, b3), pct: pctOf(Math.max(0, b3)), color: "#8B5CF6" },
      ],
      overCommitted, shortfall: overCommitted ? -b3 : 0,
      runwayMonths, runwayEnds, b1Yrs, b2Yrs, b3Yrs, baseCapital, atRetirement: twoPhaseView,
    };
  })();

  // Switching the overlay off here takes out its sidebar sliders, its panel and its share of the
  // printed report in one move, rather than leaving three places to keep in step. The raw view
  // stays available so the switch itself can still be offered on a plan that could show it.
  const bucketView = bucketsOn ? bucketViewRaw : null;

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

  /**
   * The inverse question: rather than "how does this rate fare", solve for the rate that
   * meets a wanted confidence. Bisects on the target rate.
   *
   * The return paths are drawn ONCE and reused for every candidate, which matters more than
   * it looks: it makes success a smooth, strictly falling function of the rate, so the search
   * converges on a real answer instead of chasing sampling noise between iterations.
   *
   * Handles a plan already drawing and a plan running through retirement. In the latter case
   * the saving phase is stepped once per path and its closing balance kept, because nothing in
   * it depends on the target rate — only the drawdown is replayed per candidate. That keeps the
   * search the same cost as the drawing-only case however long the saving phase is, and it also
   * means each path's opening income is read off the balance that path actually reached.
   */
  const solveTargetRate = () => {
    const months = years * 12;
    const muL = (ret - otherFees) / 100 / 12;
    const sigL = vol / 100 / Math.sqrt(12);
    const cpiL = inflation / 100;
    const wL = smoothing / 100;
    const cEscL = contribEsc / 100;
    const PATHS = Math.min(sims, 2000);

    // Same pivot the engine uses, so the answer lines up with what a run will show.
    const retM = planMode === "both" ? Math.min(effRetireMonths, months) : 0;
    const c0 = effContrib;
    const lumpL: Record<number, number> = {};
    lumps.forEach((l: any) => { const k = l.year * 12; lumpL[k] = (lumpL[k] || 0) + l.amount; });

    // Draw the paths ONCE, and with them the saving phase, which the target rate cannot touch.
    const prepared = Array.from({ length: PATHS }, () => {
      const mr = Array.from({ length: months }, () => muL + sigL * randn());
      let val = init, curC = c0;
      for (let m = 0; m < retM; m++) {
        if (m > 0 && m % 12 === 0 && cEscL > 0) curC *= (1 + cEscL);
        if (lumpL[m]) val += lumpL[m];
        val = val * (1 + mr[m]) + curC;
        if (val < 0) val = 0;
      }
      return { mr, bal: val };
    });

    const successAt = (rate: number) => {
      let ok = 0;
      for (const p of prepared) {
        let val = p.bal, curW = val * rate / 12;
        for (let m = retM; m < months; m++) {
          if (m > retM && m % 12 === 0) curW = (wL * (curW * 12) + (1 - wL) * (val * rate)) * (1 + cpiL) / 12;
          if (lumpL[m]) val += lumpL[m];
          const gross = val * (1 + p.mr[m]);
          const taken = Math.min(curW, Math.max(0, gross));
          val = gross - taken;
        }
        if (val > 1) ok++;
      }
      return ok / PATHS;
    };

    // The capital the opening income is read off. Every path retires on its own balance, so
    // quote the middle one rather than implying a single figure applies to all of them.
    const bals = prepared.map(p => p.bal).sort((a, b) => a - b);
    const base = bals[Math.floor(bals.length / 2)];
    const stamp = { conf: solveConf, years, base, atRet: retM > 0 };

    const want = solveConf / 100;
    const LO = 0.005, HI = 0.25;
    // Say so when the answer runs off either end rather than reporting the boundary as a result.
    if (successAt(HI) >= want) { setSolved({ ...stamp, rate: HI, capped: "above" }); return; }
    if (successAt(LO) < want)  { setSolved({ ...stamp, rate: LO, capped: "below" }); return; }
    let lo = LO, hi = HI;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (successAt(mid) >= want) lo = mid; else hi = mid;
    }
    setSolved({ ...stamp, rate: lo, capped: null });
  };

  const runSim = useCallback(() => {
    // Bind the mode-adjusted inputs to the names the engine below already uses, so every
    // calculation sees the same set and no stale input from another mode can leak in.
    const contrib = effContrib;
    const withdraw = effWithdrawInput;
    const retireMonths = effRetireMonths;

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
    // The endowment policy sets the opening income itself, as its spending rate applied to the
    // capital it starts from, so the entered amount and the percentage basis do not apply.
    const endowOn = spendPolicy === "endowment";
    const spendR = spendRate / 100;
    const smoothW = smoothing / 100;
    const cpi = inflation / 100;

    const incomeAtRetirement = (balAtRet: number) =>
      endowOn ? balAtRet * spendR / 12
      : wBasis === "percent" ? balAtRet * (wPct / 100) / 12
      : wBasis === "atRet" ? withdraw
      : withdraw * Math.pow(1 + inflation / 100, retireM / 12);

    /**
     * Next year's income under the endowment rule: blend last year's amount with the
     * portfolio's current value at the target rate, then add the cost-of-living increase.
     * Checked against Thornburg's 1973-76 worked example, which it reproduces to the rand.
     * Because part of the amount tracks the portfolio, a falling market pulls the income down
     * gradually rather than leaving it to rise regardless.
     */
    const endowmentNext = (priorMonthly: number, pv: number) => {
      const subtotal = smoothW * (priorMonthly * 12) + (1 - smoothW) * (pv * spendR);
      return subtotal * (1 + cpi) / 12;
    };

    const lumpMap: Record<number, number> = {};
    lumps.forEach((l: any) => { const k = l.year * 12; lumpMap[k] = (lumpMap[k] || 0) + l.amount; });

    // Guardrail: fixed "expected balance trajectory", computed ONCE at plan inception.
    // Deterministic projection at the net return, with withdrawals always escalating at the
    // full plan rate. It is never re-baselined against actual paths and never sees a freeze —
    // it is the static yardstick the guardrail measures against for the life of the plan.
    const guardOn = skipMode === "guard" && wEsc > 0;
    const healthRuleOn = skipMode === "health" && wEsc > 0;
    // Endowment reports against the lifestyle policy on the same paths, which is the
    // comparison the approach exists to make.
    const comparingOn = guardOn || healthRuleOn || endowOn;
    const bandFrac = guardBand / 100;

    // Set once calibration has run. Null while calibrating, which is what keeps the health
    // rule from feeding on itself: the odds it consults come from paths that never used it.
    let afrLookup: ((s: VitalSigns) => number | null) | null = null;
    const expectedBalance = (() => {
      let val = init, curW = twoPhase ? 0 : (endowOn ? init * spendR / 12 : withdraw), curC = contrib;
      const arr = [val];
      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          const drawingNow = !twoPhase || m > retireM;
          if (endowOn && drawingNow) curW = endowmentNext(curW, val);
          else if (wEsc > 0 && drawingNow) curW *= (1 + wEsc);
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
      let val = init, curW = twoPhase ? 0 : (endowOn ? init * spendR / 12 : withdraw), curC = contrib, yrStart = init;
      let balAtRetirement = twoPhase ? 0 : init;
      const path = [val], wpath = [curW];
      const freezeYears = [];
      let skips = 0, incs = 0;
      // How the income moved year to year, so the policy can be described by what it does to
      // a client's income rather than only by what it does to the balance.
      let incSum = 0, incCount = 0, incDrops = 0;

      // Running vital-sign accumulators (all cumulative — that is the point of momentum).
      let drawn = 0, drawnReal = 0;   // income actually paid out, nominal and in today's money
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
          // applyRule=false is the comparison run, which always uses the lifestyle rule, so a
          // like-for-like figure exists for whichever policy is selected.
          if (endowOn && drawing && applyRule) {
            const prevW = curW;
            curW = endowmentNext(curW, val);
            if (prevW > 0) {
              const ch = curW / prevW - 1;
              incSum += ch; incCount++; if (ch < 0) incDrops++;
            }
            incs++;
          } else if (endowOn && drawing) {
            curW *= (1 + cpi);            // lifestyle at CPI, the policy being compared against
            incs++;
          } else if (wEsc > 0 && drawing) {
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
        // Take only what is there. Arithmetically the same as subtracting and flooring at
        // zero, but it makes the amount actually paid out available to count, which matters
        // in the final months of a portfolio that runs dry mid-year.
        const gross = val * (1 + monthlyReturns[m]) + curC;
        const taken = Math.min(curW, Math.max(0, gross));
        val = gross - taken;
        if (val < 0) val = 0;
        drawn += taken;
        drawnReal += taken / Math.pow(1 + inflation / 100, (m + 1) / 12);
        if ((m + 1) % 12 === 0) path.push(val);
      }
      // What the investments themselves earned, compounded across every month and annualised.
      // Independent of contributions and withdrawals, so it is a return in the sense an adviser
      // means it, unlike the change in balance which cash flows dominate.
      let growth = 1;
      for (let m = 0; m < months; m++) growth *= (1 + monthlyReturns[m]);
      const earned = Math.pow(growth, 1 / years) - 1;

      return { final: val, path, wpath, freezeYears, skips, incs, signs, balAtRetirement, earned, drawn, drawnReal,
        avgIncrease: incCount ? incSum / incCount : 0, dropShare: incCount ? incDrops / incCount : 0 };
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
    const healthOn = endowOn ? spendR > 0
      : twoPhase ? (wBasis === "percent" ? wPct > 0 : withdraw > 0)
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

      // A compact form of the same curves, for diagnosing a real portfolio's history. Keeping
      // roughly forty points per sign per year means an adviser can type in actual figures and
      // read the odds straight away, instead of re-running thousands of paths on every
      // keystroke. Interpolating between the points recovers the curve closely enough.
      const CURVE_PTS = 40;
      const curves: Record<string, Record<number, [number, number][]>> = {};
      KEYS.forEach(k => {
        curves[k] = {};
        for (const yrStr of Object.keys(sorted[k])) {
          const yr = Number(yrStr);
          const s = sorted[k][yr];
          const n = s.v.length;
          if (!n) continue;
          const pts: [number, number][] = [];
          for (let i = 0; i < CURVE_PTS; i++) {
            const idx = Math.min(n - 1, Math.round(i * (n - 1) / (CURVE_PTS - 1)));
            pts.push([s.v[idx], rateAt(s, idx)]);
          }
          curves[k][yr] = pts;
        }
      });

      return { KEYS, rateOf, afrOf, thresholdOf, worseWhenHigher, curves };
    })();

    // Arm the health rule now that the unruled odds exist.
    if (cal) afrLookup = cal.afrOf;

    const allSigns: VitalSigns[][] = [];
    const retBalances: number[] = [];   // balance each path reached at the retirement pivot
    const earneds: number[] = [];       // what the investments earned on each path, before cash flows
    const drawns: number[] = [], drawnReals: number[] = [];   // income paid out on each path
    let incSumAll = 0, dropSumAll = 0, incPaths = 0;          // how the income moved, across paths

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

      finals.push(r.final); paths.push(r.path); wpaths.push(r.wpath); earneds.push(r.earned);
      drawns.push(r.drawn); drawnReals.push(r.drawnReal);
      if (endowOn) { incSumAll += r.avgIncrease; dropSumAll += r.dropShare; incPaths++; }
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

    // Sort by outcome through an index, so each percentile keeps the return its own path
    // actually earned rather than being paired with another path's.
    const order = finals.map((_, i) => i).sort((a, b) => finals[a] - finals[b]);
    const sortedFinals = order.map(i => finals[i]);
    const sortedEarned = order.map(i => earneds[i]);
    const at = (p: number) => Math.min(N - 1, Math.floor(p / 100 * N));
    const pct = (p: number) => sortedFinals[at(p)];
    const earnedAt = (p: number) => sortedEarned[at(p)];

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
      let val = init, curW = twoPhase ? 0 : (endowOn ? init * spendR / 12 : withdraw), curC = contrib;
      const path = [val];
      for (let m = 0; m < months; m++) {
        if (m > 0 && m % 12 === 0) {
          const yr = m / 12;
          const drawingNow = !twoPhase || m > retireM;
          if (endowOn && drawingNow) curW = endowmentNext(curW, val);
          else if (wEsc > 0 && drawingNow) {
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
      let curW = twoPhase ? 0 : (endowOn ? init * spendR / 12 : withdraw);
      const path = [curW * 12];
      for (let yr = 1; yr <= years; yr++) {
        if (twoPhase && yr * 12 > retireM && curW === 0) curW = incomeAtRetirement(linPort[Math.floor(retireM / 12)] ?? 0);
        // The income line has to follow the same rule as the balances beside it. Under the
        // Income Review policy that means recalculating off the portfolio each year, using
        // the value this same fixed-return path opened the year on.
        else if (endowOn && (!twoPhase || yr * 12 > retireM)) curW = endowmentNext(curW, linPort[yr - 1] ?? 0);
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
    // Three different questions, so three different figures.
    //   earned  - what the investments returned, compounded and annualised, before any money
    //             moved in or out. This is the performance figure.
    //   real    - the same after inflation, so it is purchasing power rather than rands.
    //   balance - how the capital itself changed, which cash flows dominate: a drawdown plan
    //             shows a fall even when the investments did well, and a savings plan shows a
    //             rise far above what anything earned. Useful, but not a return.
    const balanceCagr = (t: number) => (init <= 0 || t <= 0 || years <= 0) ? null : (Math.pow(t / init, 1 / years) - 1) * 100;
    const afterInflation = (nom: number | null) =>
      nom === null ? null : ((1 + nom / 100) / (1 + inflation / 100) - 1) * 100;
    const linEarned = (Math.pow(1 + muM, 12) - 1) * 100;
    const triple = (p: number) => {
      const e = earnedAt(p) * 100;
      return { earned: e, real: afterInflation(e), balance: balanceCagr(pct(p)) };
    };
    const avgReturn = {
      p5: triple(5), p50: triple(50), p75: triple(75), p95: triple(95),
      linear: { earned: linEarned, real: afterInflation(linEarned), balance: balanceCagr(linPort[linPort.length - 1]) },
    };

    // Contributions stop at the pivot, so both the final figure and the total paid in run over
    // the saving period rather than the whole horizon. Escalation is compounded rather than
    // ignored, so an escalating plan no longer reports the year-one amount for every year.
    const contribYears = twoPhase ? retireM / 12 : years;
    const finalContrib = cEsc > 0 ? contrib * Math.pow(1 + cEsc, contribYears) : contrib;
    const totalContributed = cEsc > 0
      ? contrib * 12 * (Math.pow(1 + cEsc, contribYears) - 1) / cEsc
      : contrib * 12 * contribYears;

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
      totalIn: init + totalContributed + lumps.reduce((s: number, l: any) => s + l.amount, 0),
      // Median of the income actually paid out, which is not the income of the median-value
      // path: a plan that ran dry early paid out less, so the two distributions differ.
      drawnMedian: drawns.slice().sort((a, b) => a - b)[Math.floor(0.5 * N)],
      drawnMedianReal: drawnReals.slice().sort((a, b) => a - b)[Math.floor(0.5 * N)],
      incomeAvgIncrease: incPaths ? incSumAll / incPaths : null,
      incomeDropShare: incPaths ? dropSumAll / incPaths : null,
      p5a, p50a, p75a, p95a, w5a, w50a, w75a, w95a, linPort, linW, dep, real, avgReturn,
      labels: Array.from({ length: years + 1 }, (_, i) => "Yr " + i),
      avgInc: (totInc / N).toFixed(1), avgSkip: (totSkip / N).toFixed(1), finalContrib,
      expectedBalance,
      curves: cal ? cal.curves : null,
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
  }, [init, contrib, contribEsc, withdraw, escMode, customEsc, skipMode, skipEvery, guardBand, healthThreshold, savingsTarget, spendPolicy, spendRate, smoothing, planMode, effContrib, effWithdrawInput, effRetireMonths, wBasis, wPct, ret, vol, years, sims, effEsc, lumps, inflation, otherFees]);

  useEffect(() => { if (chartReady) runSim(); }, [chartReady]);

  // Point the baseline at the year the client has actually reached, so the two panels describe
  // the same moment. The slider still moves afterwards if a different year is wanted.
  useEffect(() => {
    if (actuals.length > 0) setHealthYear(actuals.length);
  }, [actuals.length]);

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
        // The client's real balances, drawn over the simulated spread. Solid, heavier and with
        // visible points, since these are observations rather than a projection, and it stops
        // after the last year entered rather than running to the horizon.
        ...(actuals.length ? [{
          type: "line", label: "Actual", data: [init, ...actuals.map(a => a.balance)],
          borderColor: COLORS.actual, backgroundColor: COLORS.actual,
          borderWidth: 3, pointRadius: 3, pointHoverRadius: 5, tension: 0, fill: false, order: -1,
        }] : []),
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
  }, [results, chartReady, lumps, actuals, init]);

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
    // actuals.length matters because the panel holding this canvas only renders once a
    // client history exists; without it the effect never re-runs and the chart stays blank.
  }, [results, chartReady, actuals.length]);

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
  // Free text, for the record details rather than anything the simulation reads.
  const textRow = (label: string, val: string, set: (v: string) => void, placeholder?: string) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 3 }}>{label}</div>
      <input type="text" value={val} placeholder={placeholder} onChange={e => set(e.target.value)}
        style={{ width: "100%", padding: "5px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ccc", background: "#fff", color: "#222", boxSizing: "border-box" }} />
    </div>
  );

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
    <div className="mc-shell" style={{ display: "flex", border: "1px solid #e0e0e0", borderRadius: 12, overflow: "hidden", fontFamily: "system-ui,sans-serif", background: "#fff", minHeight: 500 }}>

      {/*
        Print layout. The dashboard keeps its results in panels that scroll inside themselves,
        which on paper means everything past the first screenful is simply cut off — so these
        rules unclip them and drop the controls, leaving a report rather than a screenshot.
        !important is needed throughout because the component styles inline.
      */}
      <style>{`
        .print-only { display: none; }
        @media print {
          @page { size: A4 portrait; margin: 12mm; }
          html, body { background: #fff !important; }
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          .mc-shell { border: none !important; border-radius: 0 !important; min-height: 0 !important;
                      overflow: visible !important; display: block !important; }
          .mc-main  { overflow: visible !important; max-height: none !important; }
          /* The panels that scroll on screen; on paper they run over as many pages as they need. */
          .mc-scroll { max-height: none !important; overflow: visible !important; }
          /* Chart.js draws to a fixed-size bitmap, so scale it down to the page and keep its shape. */
          canvas { max-width: 100% !important; height: auto !important; }
          .avoid-break { break-inside: avoid; page-break-inside: avoid; }
          tr, .mc-row { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>

      {/* SIDEBAR */}
      <div className="no-print" style={{ width: 256, minWidth: 256, background: "#f8f8f6", borderRight: "1px solid #e0e0e0", padding: "14px 13px", overflowY: "auto", maxHeight: "90vh", flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #e0e0e0" }}>⚙ Parameters</div>

        {/* Saving to a file rather than the browser is deliberate: the adviser chooses where a
            client's details live and can file them with the rest of the record, instead of them
            accumulating in browser storage on a machine that may be shared. */}
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <button onClick={savePlan}
            style={{ flex: 1, padding: "6px 0", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid #185FA5", background: "#fff", color: "#185FA5", cursor: "pointer" }}>
            Save plan
          </button>
          <button onClick={() => fileRef.current?.click()}
            style={{ flex: 1, padding: "6px 0", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid #185FA5", background: "#fff", color: "#185FA5", cursor: "pointer" }}>
            Open plan
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
            onChange={e => {
              const f = e.target.files && e.target.files[0];
              if (f) loadPlan(f);
              e.target.value = "";   // so re-opening the same file still fires
            }} />
        </div>
        <button onClick={printReport} disabled={!results} title={results ? "" : "Run the simulation first"}
          style={{ width: "100%", padding: "6px 0", fontSize: 11, fontWeight: 600, borderRadius: 6, marginBottom: 6,
            border: "1px solid " + (results ? "#444" : "#ddd"), background: "#fff",
            color: results ? "#444" : "#ccc", cursor: results ? "pointer" : "not-allowed" }}>
          Save as PDF
        </button>
        {planNote && <div style={{ fontSize: 10, color: "#888", marginBottom: 10 }}>{planNote}</div>}
        {!planNote && <div style={{ fontSize: 10, color: "#ccc", marginBottom: 10 }}>
          {dirName
            ? <>Saves to <strong style={{ color: "#aaa" }}>{dirName}</strong>{curFile ? <> · editing {curFile.name}</> : <> · will create {planFileName()}</>}</>
            : <>Saves every input below to a file, including the client's details. Nothing is kept when this page closes.</>}
        </div>}

        {/* Record details. These identify the report; none of them reach the simulation. */}
        {secLabel("Client")}
        {textRow("Client name", clientName, setClientName)}
        {textRow("ID number", clientId, setClientId, "13 digits")}
        {clientId && !idLooksComplete && (
          <div style={{ fontSize: 11, color: "#BA7517", marginTop: -8, marginBottom: 10 }}>
            {clientId.replace(/\D/g, "").length} digits — a South African ID has 13
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 12, color: "#666", marginBottom: 3 }}>Date of birth</span>
            {dobTouched && dobFromId && dobFromId !== clientDob && (
              <button onClick={() => { setDobTouched(false); setClientDob(dobFromId); }}
                style={{ fontSize: 10, padding: 0, border: "none", background: "none", color: "#185FA5", cursor: "pointer", textDecoration: "underline" }}>use ID</button>
            )}
          </div>
          <input type="date" value={clientDob}
            onChange={e => { setDobTouched(true); setClientDob(e.target.value); }}
            style={{ width: "100%", padding: "5px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ccc", background: "#fff", color: clientDob ? "#222" : "#888", boxSizing: "border-box" }} />
          <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>
            {clientAge !== null ? <>Age <strong style={{ color: "#333" }}>{clientAge}</strong></> : "—"}
            {clientDob && dobFromId === clientDob && !dobTouched && <span style={{ color: "#bbb" }}> · from ID number</span>}
            {dobTouched && clientDob && <span style={{ color: "#bbb" }}> · entered manually</span>}
          </div>
        </div>

        {secLabel("Adviser")}
        {textRow("FSP practice", fspPractice, setFspPractice)}
        {textRow("FSP code", fspCode, setFspCode)}
        {textRow("Adviser name", adviserName, setAdviserName)}
        {textRow("Adviser code", adviserCode, setAdviserCode)}
        {hr}

        {/* What the plan covers. Drives which inputs below apply and which are hidden. */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#555", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".06em" }}>Plan covers</div>
          <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "2px solid #185FA5" }}>
            {[["pre", "Saving", "Building up"], ["post", "Drawing", "Already retired"], ["both", "Both", "Through retirement"]].map(([k, lbl, desc], i) => (
              <button key={k} onClick={() => setPlanMode(k)} style={{
                flex: 1, padding: "7px 3px", cursor: "pointer", border: "none",
                borderRight: i < 2 ? "2px solid #185FA5" : "none",
                background: planMode === k ? "#185FA5" : "#fff",
                color: planMode === k ? "#fff" : "#555",
              }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{lbl}</div>
                <div style={{ fontSize: 9, opacity: .8, marginTop: 2 }}>{desc}</div>
              </button>
            ))}
          </div>
          {planMode === "both" && !retireDate && (
            <div style={{ fontSize: 11, color: "#993C1D", background: "#fff7ed", border: "1px solid #f5c4b3", borderRadius: 6, padding: "6px 8px", marginTop: 8 }}>
              Set a retirement date below, otherwise this behaves as a drawing-only plan.
            </div>
          )}
        </div>

        {secLabel("Portfolio")}
        {sRowN("Starting value (R)", 100000, 200000000, 100000, init, setInit, "R")}
        {planMode !== "post" && sRowN("Monthly contribution (R)", 0, 100000, 500, contrib, setContrib, "R")}
        {planMode !== "post" && sRow("Contribution escalation (%/yr)", 0, 20, 0.5, contribEsc, setContribEsc, contribEsc === 0 ? "None" : contribEsc.toFixed(1) + "%/yr", contribEsc > 0 ? "#1D9E75" : undefined)}
        {contribEsc > 0 && results && <div style={{ fontSize: 11, color: "#1D9E75", marginTop: -8, marginBottom: 10 }}>Yr {planMode === "both" ? Math.round(effRetireMonths/12) : years} contribution: {fmt(results.finalContrib)}/mo</div>}
        {/* Only a saving plan has a target to fund; a drawdown plan is judged on lasting instead. */}
        {planMode === "pre" && (
          <>
            {sRowN("Savings goal (R, 0 = none)", 0, 500000000, 100000, savingsTarget, setSavingsTarget, "R", savingsTarget > 0 ? "#185FA5" : undefined)}
            {savingsTarget > 0 && results && results.funding && results.funding.probTarget !== null && (
              <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
                Chance of reaching it: <strong style={{ color: results.funding.probTarget >= 75 ? "#1D9E75" : results.funding.probTarget >= 50 ? "#BA7517" : "#D85A30" }}>{Math.round(results.funding.probTarget)}%</strong>
              </div>
            )}
          </>
        )}

        {planMode !== "pre" && hr}
        {planMode !== "pre" && secLabel(planMode === "both" ? "Retirement income" : "Withdrawal")}
        {/* How the income is set each year. Endowment ties part of it to the portfolio's
            current value, so it eases back in a bad market instead of rising regardless. */}
        {planMode !== "pre" && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Spending policy</div>
            {segRow([["lifestyle", "Lifestyle"], ["endowment", "Income Review"]], spendPolicy, setSpendPolicy)}
          </>
        )}
        {planMode !== "pre" && spendPolicy === "endowment" && (
          <div>
            <div style={{ fontSize: 11, color: "#185FA5", background: "#f0f6fd", border: "1px solid #c5dcf5", borderRadius: 6, padding: "7px 9px", marginBottom: 10 }}>
              Reviewed every year: <strong>{smoothing}%</strong> of last year's income plus <strong>{100 - smoothing}%</strong> of {spendRate.toFixed(1)}% of the portfolio's current value, then increased by inflation. Because part of it follows the portfolio, a falling market eases the income down gradually rather than leaving it to climb regardless.
            </div>
            {sRow("Spending rate (%/yr)", 2, 10, 0.25, spendRate, setSpendRate, spendRate.toFixed(2) + "% of portfolio", "#D85A30")}
            {sRow("Smoothing (% on last year)", 50, 100, 5, smoothing, setSmoothing, smoothing + "/" + (100 - smoothing), "#185FA5")}

            {/* Work the question backwards: pick the confidence, get the rate. Needs a drawing
                phase to solve for, so it sits out a saving-only plan. */}
            {(planMode === "post" || (planMode === "both" && effRetireMonths > 0)) && (
              <div style={{ border: "1px solid #c5dcf5", background: "#f7fbff", borderRadius: 6, padding: "8px 9px", marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#185FA5", marginBottom: 6 }}>What rate can this portfolio carry?</div>
                {sRow("Confidence wanted", 50, 99, 1, solveConf, setSolveConf, solveConf + "%", "#185FA5")}
                <button onClick={solveTargetRate}
                  style={{ width: "100%", padding: "6px 0", fontSize: 12, fontWeight: 600, borderRadius: 6, border: "1px solid #185FA5", background: "#fff", color: "#185FA5", cursor: "pointer" }}>
                  Solve target rate
                </button>
                {solved && (
                  <div style={{ fontSize: 11, color: "#555", marginTop: 7 }}>
                    {solved.capped === "above"
                      ? <>Even {(0.25 * 100).toFixed(0)}% clears {solved.conf}% over {solved.years} yrs — the horizon is short enough that the rate is not the binding constraint.</>
                      : solved.capped === "below"
                      ? <>No rate above 0.5% reaches {solved.conf}% over {solved.years} yrs on these assumptions.</>
                      : <>
                          <strong style={{ color: "#185FA5", fontSize: 13 }}>{(solved.rate * 100).toFixed(1)}%</strong>
                          {" "}for {solved.conf}% confidence over {solved.years} yrs
                          <br />
                          <span style={{ color: "#888" }}>
                            about {fmt(solved.base * solved.rate / 12)}/mo to start
                            {solved.atRet && <> — off the middle balance at retirement, {fmt(solved.base)}. Each path draws on its own, so a weaker one opens lower.</>}
                          </span>
                        </>}
                    <div style={{ fontSize: 10, color: "#bbb", marginTop: 4 }}>
                      Good to about a tenth of a percent — it is read off sampled paths, so a re-run will not land on exactly the same figure. It also moves with every other assumption here, return, volatility, inflation and fees, so it is not a portable number. Set the horizon to a cautious life expectancy rather than an average one, or this quietly becomes "older clients can draw more".
                      {solved.atRet && <> The rate is applied to the balance each path reaches, so it is judged over the {solved.years - Math.round(effRetireMonths / 12)} drawing years, not the full {solved.years}.</>}
                    </div>
                    {Math.abs(solved.rate * 100 - spendRate) > 0.05 && (
                      <button onClick={() => setSpendRate(Math.round(solved.rate * 1000) / 10)}
                        style={{ marginTop: 6, fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #1D9E75", background: "none", color: "#1D9E75", cursor: "pointer", fontWeight: 600 }}>
                        Use {(solved.rate * 100).toFixed(1)}% as the target
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <div style={{ fontSize: 11, color: "#888", marginTop: -4, marginBottom: 10 }}>
              Opening income <strong style={{ color: "#D85A30" }}>{fmt(init * spendRate / 100 / 12)}</strong>/mo
              {planMode === "both" && <> · set from the balance at retirement instead</>}
              <br />
              <span style={{ color: "#bbb" }}>Higher smoothing changes the income more slowly. 100 would ignore the portfolio entirely, which is the lifestyle policy.</span>
            </div>
          </div>
        )}
        {/* The retirement date only means anything for a plan that spans both phases. */}
        {planMode === "both" && <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 3 }}>Retirement date</div>
          <input type="month" value={retireDate} onChange={e => setRetireDate(e.target.value)}
            style={{ width: "100%", padding: "5px 8px", fontSize: 12, fontWeight: 600, borderRadius: 6, border: "1px solid #ccc", background: "#fff", color: retireMonths > 0 ? "#185FA5" : "#888" }} />
          <div style={{ fontSize: 11, color: retireMonths > 0 ? "#185FA5" : "#aaa", marginTop: 3 }}>
            {retireLabel}{retireDate && retireMonths === 0 ? " — date is not in the future" : ""}
          </div>
        </div>}
        {effRetireMonths > 0 && planMode === "both" && (
          <div style={{ fontSize: 11, color: "#185FA5", background: "#f0f6fd", border: "1px solid #c5dcf5", borderRadius: 6, padding: "7px 9px", marginBottom: 10 }}>
            Contributions run to that date, then stop and income starts, leaving {Math.max(0, years - Math.round(retireMonths / 12))} yrs of drawdown within the {years}-yr horizon.
            {retireMonths / 12 >= years && <> <strong>The date falls outside the horizon</strong> — lengthen it to see any drawdown.</>}
          </div>
        )}
        {effRetireMonths > 0 && (
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
        {planMode !== "pre" && spendPolicy !== "endowment" && (effRetireMonths > 0 && wBasis === "percent"
          ? sRow("Draw at retirement (%/yr)", 1, 12, 0.25, wPct, setWPct, wPct.toFixed(2) + "% of balance", "#D85A30")
          : sRowN(effRetireMonths === 0 ? "Monthly withdrawal (R)"
                  : wBasis === "atRet" ? "Monthly income at retirement (R)"
                  : "Monthly income wanted (R, today's money)",
                  0, 500000, 1000, withdraw, setWithdraw, "R", withdraw > 0 ? "#D85A30" : undefined))}
        {effRetireMonths > 0 && wBasis === "today" && withdraw > 0 && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            Carried forward by inflation, that is <strong style={{ color: "#D85A30" }}>{fmt(withdraw * Math.pow(1 + inflation / 100, retireMonths / 12))}</strong>/mo on the retirement date
          </div>
        )}
        {effRetireMonths > 0 && wBasis === "atRet" && withdraw > 0 && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            Taken as entered, so in today's money that is <strong style={{ color: "#D85A30" }}>{fmt(withdraw / Math.pow(1 + inflation / 100, retireMonths / 12))}</strong>/mo
          </div>
        )}
        {/* The withdrawal rate has to be measured against the capital the income is actually
            drawn from. On a combined plan that is the balance at retirement, not today's, and
            there is no net figure to give: contributions stop before income starts, so the two
            never run together and subtracting one from the other would describe a month that
            never happens. */}
        {effWithdrawInput > 0 && planMode !== "both" && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            WR: <strong style={{ color: wr > 5 ? "#D85A30" : wr > 3.5 ? "#BA7517" : "#1D9E75" }}>{wr.toFixed(1)}%/yr</strong>
            {effContrib > 0 && (
              <>
                {" · "}
                <span style={{ color: (effContrib - effWithdrawInput) < 0 ? "#D85A30" : "#1D9E75" }}>
                  Net: {effContrib - effWithdrawInput >= 0 ? "+" : "-"}R{Math.abs(effContrib - effWithdrawInput).toLocaleString()}/mo
                </span>
              </>
            )}
          </div>
        )}
        {planMode === "both" && withdraw > 0 && wBasis !== "percent" && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            {results?.retirement && results.retirement.p50 > 0
              ? (() => {
                  const r = results.retirement.medianIncome * 12 / results.retirement.p50 * 100;
                  return <>Draws <strong style={{ color: r > 5 ? "#D85A30" : r > 3.5 ? "#BA7517" : "#1D9E75" }}>{r.toFixed(1)}%/yr</strong> of the median balance at retirement</>;
                })()
              : <>The rate depends on the balance at retirement — run the simulation to see it</>}
          </div>
        )}

        {planMode !== "pre" && spendPolicy !== "endowment" && <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 6 }}>Annual withdrawal escalation</div>}
        {planMode !== "pre" && spendPolicy !== "endowment" && segRow([["none", "None"], ["custom", "Custom %"]], escMode, setEscMode)}
        {planMode !== "pre" && spendPolicy !== "endowment" && escMode === "custom" && sRow("Escalation rate (%)", 0, 20, .5, customEsc, setCustomEsc, customEsc.toFixed(1) + "%", "#D85A30")}

        {planMode !== "pre" && spendPolicy !== "endowment" && escMode !== "none" && (
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

        {/* Bucket structure — display only, so these inputs never re-run the simulation.
            Gated on the raw view rather than the switched one, or turning it off would take the
            switch away with it and leave no way back. */}
        {bucketViewRaw && (
          <>
            {hr}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              {secLabel("Bucket structure")}
              <button onClick={() => setBucketsOn(v => !v)}
                style={{ padding: "2px 9px", fontSize: 10, fontWeight: 600, borderRadius: 10, cursor: "pointer",
                  border: "1px solid " + (bucketsOn ? "#1D9E75" : "#ddd"),
                  background: bucketsOn ? "#e8f7ef" : "#fff", color: bucketsOn ? "#1a7a4a" : "#aaa" }}>
                {bucketsOn ? "On" : "Off"}
              </button>
            </div>
            {bucketsOn ? (
              <>
                <div style={{ fontSize: 11, color: "#888", marginTop: -4, marginBottom: 8 }}>
                  Splits the opening capital by how many years of withdrawals each bucket covers. Presentation only — it does not change the simulation.
                </div>
                {sRow("Bucket 1 · Conservative (years)", 0, Math.max(1, years), 1, bucket1Years, setBucket1Years, bucketViewRaw.b1Yrs + (bucketViewRaw.b1Yrs === 1 ? " yr" : " yrs"), "#1D9E75")}
                {sRow("Bucket 2 · Moderate (years)", 0, Math.max(1, years), 1, bucket2Years, setBucket2Years, bucketViewRaw.b2Yrs + (bucketViewRaw.b2Yrs === 1 ? " yr" : " yrs"), "#378ADD")}
                <div style={{ fontSize: 11, color: "#888", marginTop: -4, marginBottom: 8 }}>
                  Bucket 3 · Aggressive takes the remaining <strong style={{ color: "#8B5CF6" }}>{bucketViewRaw.b3Yrs} {bucketViewRaw.b3Yrs === 1 ? "yr" : "yrs"}</strong>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#aaa", marginTop: -4, marginBottom: 8 }}>
                Hidden — the panel and its share of the printed report are left out. The simulation is unaffected either way.
              </div>
            )}
          </>
        )}

        {/* Review of a real portfolio. Only meaningful for a plan that draws, and only once a
            run exists to supply the odds. */}
        {planDraws && (
          <>
            {hr}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              {secLabel("Actual history")}
              <button onClick={() => setActuals(a => [...a, { id: uid++, balance: init, withdrawal: Math.round(withdraw * 12) }])}
                style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #185FA5", background: "none", color: "#185FA5", cursor: "pointer", fontWeight: 600, marginTop: -6 }}>+ Year</button>
            </div>
            <div style={{ fontSize: 11, color: "#888", marginTop: -4, marginBottom: 8 }}>
              For reviewing a client already invested. Enter each year's closing balance and what was drawn. Starting value above is treated as the balance before year 1.
            </div>
            {actuals.length === 0 && <div style={{ fontSize: 11, color: "#ccc", marginBottom: 8 }}>No history entered — the diagnostic below stays on the simulated plan.</div>}
            {actuals.map((a, i) => (
              <div key={a.id} style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#185FA5" }}>Year {i + 1}</span>
                  <button onClick={() => setActuals(xs => xs.filter(x => x.id !== a.id))}
                    style={{ background: "none", border: "none", color: "#ccc", fontSize: 16, cursor: "pointer" }}>×</button>
                </div>
                {sRowN("Closing balance (R)", 0, 1000000000, 10000, a.balance,
                       v => setActuals(xs => xs.map(x => x.id === a.id ? { ...x, balance: v } : x)), "R", "#185FA5")}
                {sRowN("Drawn during year (R)", 0, 100000000, 10000, a.withdrawal,
                       v => setActuals(xs => xs.map(x => x.id === a.id ? { ...x, withdrawal: v } : x)), "R", "#D85A30")}
                {review && review.rows[i] && (
                  <div style={{ fontSize: 11, color: "#888" }}>
                    Implied return: <strong style={{ color: review.rows[i].ret < 0 ? "#D85A30" : "#1D9E75" }}>{(review.rows[i].ret * 100).toFixed(1)}%</strong>
                  </div>
                )}
              </div>
            ))}
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
        {results && (
          <div style={{ fontSize: 11, color: "#888", marginTop: -8, marginBottom: 10 }}>
            <>Typical compound return ≈ <strong style={{ color: "#1D9E75" }}>{results.avgReturn.p50.earned.toFixed(2)}%</strong> once volatility is allowed for</>
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
      <div className="mc-main" style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflowY: "auto" }}>

        {/* Only worth a tab bar where the folder exists to browse — elsewhere the sidebar's
            save/open buttons are the whole story and a dead tab would just puzzle people. */}
        {FS_OK && (
          <div className="no-print" style={{ display: "flex", gap: 2, padding: "6px 16px 0", borderBottom: "1px solid #eee" }}>
            {([["sim", "Simulator"], ["clients", "Clients"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                style={{ padding: "6px 14px", fontSize: 12, fontWeight: tab === k ? 700 : 500, cursor: "pointer",
                  border: "none", background: "none", color: tab === k ? "#185FA5" : "#888",
                  borderBottom: tab === k ? "2px solid #185FA5" : "2px solid transparent" }}>
                {label}{k === "clients" && clientList.length > 0 ? " (" + clientList.length + ")" : ""}
              </button>
            ))}
          </div>
        )}

        {FS_OK && tab === "clients" && (
          <div className="no-print" style={{ padding: "14px 16px" }}>
            {!dirHandle ? (
              <div style={{ maxWidth: 520 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Choose a folder for client plans</div>
                <div style={{ fontSize: 12, color: "#666", lineHeight: 1.55, marginBottom: 12 }}>
                  Pick a folder — one inside OneDrive works well — and every plan saved here goes into it.
                  This list then shows what is in that folder. The plans stay ordinary files you can back up,
                  send to an adviser or delete; only a pointer to the folder is remembered, never the client details.
                </div>
                <button onClick={pickFolder}
                  style={{ padding: "8px 16px", fontSize: 12, fontWeight: 600, borderRadius: 6, border: "1px solid #185FA5", background: "#185FA5", color: "#fff", cursor: "pointer" }}>
                  Choose folder
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    Folder: <strong style={{ color: "#333" }}>{dirName}</strong>
                    {listBusy && <span style={{ color: "#bbb" }}> · reading…</span>}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={newClient} style={{ padding: "5px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid #1D9E75", background: "#fff", color: "#1D9E75", cursor: "pointer" }}>+ New client</button>
                    <button onClick={() => listClients(dirHandle)} style={{ padding: "5px 12px", fontSize: 11, borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#666", cursor: "pointer" }}>Refresh</button>
                    <button onClick={pickFolder} style={{ padding: "5px 12px", fontSize: 11, borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#666", cursor: "pointer" }}>Change folder</button>
                    <button onClick={forgetFolder} style={{ padding: "5px 12px", fontSize: 11, borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#999", cursor: "pointer" }}>Forget</button>
                  </div>
                </div>

                {/* A lapsed permission looks exactly like an empty folder unless it is said out loud. */}
                {dirBlocked ? (
                  <div style={{ fontSize: 12, color: "#666", background: "#fdf6ec", border: "1px solid #f0d9b5", borderRadius: 8, padding: "12px 14px", lineHeight: 1.55 }}>
                    The browser needs permission to read <strong>{dirName}</strong> again — it asks once per session.
                    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                      <button onClick={reconnectFolder} style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid #D85A30", background: "#fff", color: "#D85A30", cursor: "pointer" }}>Reconnect</button>
                      <button onClick={pickFolder} style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid #185FA5", background: "#fff", color: "#185FA5", cursor: "pointer" }}>Choose folder again</button>
                    </div>
                    {/* If the permission was refused rather than merely lapsed, Reconnect cannot
                        re-ask and picking the folder again is the only thing that clears it. */}
                    <div style={{ fontSize: 10, color: "#a08a6a", marginTop: 7 }}>
                      If Reconnect does nothing, the permission was refused rather than expired — the browser will not
                      ask a second time. Choose the folder again to clear it. Saving still works meanwhile; plans go to
                      your downloads folder until access is restored.
                    </div>
                  </div>
                ) : clientList.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#999", padding: "18px 0" }}>
                    {listBusy ? "Reading the folder…" : <>No plans in this folder yet. Fill in a client on the Simulator tab and press <strong>Save plan</strong>.</>}
                  </div>
                ) : (
                  <div style={{ border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
                    {clientList.map((c, i) => (
                      <div key={c.file}
                        onClick={() => openClient(c)}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                          padding: "10px 14px", cursor: "pointer",
                          borderTop: i ? "1px solid #f0f0f0" : "none",
                          background: curFile && curFile.name === c.file ? "#f0f6fd" : "#fff" }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#222", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {c.label}
                            {curFile && curFile.name === c.file && <span style={{ fontSize: 10, fontWeight: 600, color: "#185FA5", marginLeft: 8 }}>OPEN</span>}
                          </div>
                          <div style={{ fontSize: 10, color: "#bbb", marginTop: 1 }}>{c.file}</div>
                        </div>
                        <div style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap" }}>
                          {new Date(c.saved).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 10, color: "#ccc", marginTop: 10, lineHeight: 1.6, maxWidth: 620 }}>
                  The name shown is the one inside each plan, so renaming a client on the Simulator tab updates
                  this list without leaving a second file behind. To remove a client, delete the file in the folder.
                  This is a way to find and reopen a plan quickly, not a system of record — there is no history of
                  changes, and if two people have the same file open from a shared folder the last save wins.
                </div>
              </>
            )}
          </div>
        )}

        {/* display:contents keeps the existing layout untouched while the Clients tab is up. */}
        <div style={{ display: tab === "sim" || !FS_OK ? "contents" : "none" }}>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid #eee" }}>
          <div>
            <span style={{ fontSize: 15, fontWeight: 700 }}>Monte Carlo Simulation</span>
            {/* Whoever the report is for, on the report itself. */}
            {(clientName || clientId || clientDob) && (
              <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                {clientName && <strong style={{ color: "#333" }}>{clientName}</strong>}
                {clientId && <>{clientName ? " · " : ""}ID {clientId}</>}
                {clientAge !== null && <> · age {clientAge}</>}
              </div>
            )}
            {(adviserName || adviserCode || fspPractice || fspCode) && (
              <div style={{ fontSize: 11, color: "#888", marginTop: 1 }}>
                {fspPractice}
                {fspCode && <>{fspPractice ? " · " : ""}FSP {fspCode}</>}
                {adviserName && <>{(fspPractice || fspCode) ? " · " : ""}{adviserName}</>}
                {adviserCode && <> · rep {adviserCode}</>}
              </div>
            )}
            {/* On paper the reader has no way to tell when the figures were produced. */}
            <div className="print-only" style={{ fontSize: 11, color: "#888", marginTop: 3 }}>
              Prepared {new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "long", year: "numeric" })}
            </div>
          </div>
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
              {cagr != null && (
                <>
                  <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>
                    Earned: <strong style={{ color: cagr.earned >= 0 ? "#1D9E75" : "#D85A30" }}>{cagr.earned.toFixed(2)}%</strong>
                    {cagr.real != null && <> · real <strong style={{ color: cagr.real >= 0 ? "#1D9E75" : "#D85A30" }}>{cagr.real.toFixed(2)}%</strong></>}
                  </div>
                  {cagr.balance != null && (
                    <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                      Capital: <strong style={{ color: cagr.balance >= 0 ? "#1D9E75" : "#D85A30" }}>{cagr.balance.toFixed(2)}%</strong>
                      <span style={{ color: "#bbb" }}> after cash flow</span>
                    </div>
                  )}
                </>
              )}
              {realVal != null && <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Real value: <strong style={{ color: "#555" }}>{fmt(realVal)}</strong></div>}
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
                Buckets 1 and 2 as specified need {fmt(bucketView.shortfall)} more than the whole portfolio, so there is nothing left for bucket 3. Shorten one of the horizons, or revisit the withdrawal.
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
                {spendPolicy === "endowment" ? "Income Review rule vs lifestyle" : skipMode === "health" ? "Health-score rule impact" : "Withdrawal guardrail impact"}
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}> · {spendPolicy === "endowment" ? `income reset each year to ${smoothing}% of last year plus ${100 - smoothing}% of ${spendRate.toFixed(1)}% of the portfolio` : skipMode === "health" ? `freeze increase while the odds of failing exceed ${healthThreshold}%` : `freeze increase when below ${g.band}% of expected trajectory AND year's return is negative`}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", padding: "8px 4px 10px" }}>
                {cell(spendPolicy === "endowment" ? "Success — lifestyle" : skipMode === "health" ? "Success — no rule" : "Success — no guardrail", g.pctSuccessNoGuard + "%", "#D85A30", "same return paths")}
                {cell(spendPolicy === "endowment" ? "Success — Income Review" : skipMode === "health" ? "Success — with rule" : "Success — with guardrail", results.pctSuccess + "%", "#1D9E75", "same return paths")}
                {cell("Improvement", (lift >= 0 ? "+" : "") + lift + " pts", lift > 0 ? "#1D9E75" : "#888", "like for like")}
                {spendPolicy !== "endowment" && cell("Avg freezes / path", g.avgFreezes.toFixed(1), "#185FA5", `${g.avgFreezesOnSuccess.toFixed(1)} on surviving paths`)}
                {spendPolicy !== "endowment" && cell("Paths ever frozen", g.pctPathsEverFrozen + "%", "#185FA5", `most common: Yr ${g.peakFreezeYear}`)}
                {/* What the rule does to the income, which is what a client actually feels.
                    A freeze count means nothing here: the amount is recalculated every year
                    rather than held, so the useful figures are how much it typically moved and
                    how often it went backwards. */}
                {spendPolicy === "endowment" && results.incomeAvgIncrease !== null &&
                  cell("Average increase", (results.incomeAvgIncrease * 100).toFixed(1) + "%/yr",
                       results.incomeAvgIncrease >= inflation / 100 ? "#1D9E75" : "#BA7517",
                       `inflation is ${inflation.toFixed(1)}%`)}
                {spendPolicy === "endowment" && results.incomeDropShare !== null &&
                  cell("Years income fell", Math.round(results.incomeDropShare * 100) + "%",
                       results.incomeDropShare > 0.25 ? "#D85A30" : "#185FA5",
                       "the belt-tightening years")}
              </div>
            </div>
          );
        })()}

        {/* Review of the client's own figures. This is the diagnostic doing the job it was
            designed for, so it leads; the simulated version below is illustrative by comparison. */}
        {review && (() => {
          const afrPct = review.afr === null ? null : Math.round(review.afr * 100);
          const col = afrPct === null ? "#888" : afrPct < 50 ? "#1D9E75" : afrPct < 60 ? "#BA7517" : "#D85A30";
          const word = afrPct === null ? "no reading" : afrPct < 50 ? "Healthy" : afrPct < 60 ? "Fragile" : "At risk";
          const moroCol = review.moro < 100 ? "#1D9E75" : review.moro < 200 ? "#BA7517" : "#D85A30";
          const r = 26, circ = 2 * Math.PI * r;
          const trend = review.afrByYear.filter((x): x is number => x !== null);
          const rising = trend.length > 1 && trend[trend.length - 1] > trend[0];
          return (
            <div style={{ borderTop: "1px solid #eee", background: "#f7fafd" }}>
              <div style={{ padding: "10px 16px 0", fontSize: 12, fontWeight: 600, color: "#444" }}>
                Client review · {review.rows.length} {review.rows.length === 1 ? "year" : "years"} of actual history
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}> · the client's own figures read against this plan's odds</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", padding: "8px 16px 4px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 18 }}>
                  <svg width={64} height={64} viewBox="0 0 64 64">
                    <circle cx={32} cy={32} r={r} fill="none" stroke="#eee" strokeWidth={7} />
                    <circle cx={32} cy={32} r={r} fill="none" stroke={col} strokeWidth={7}
                      strokeDasharray={`${circ * (afrPct ?? 0) / 100} ${circ}`} strokeLinecap="round" transform="rotate(-90 32 32)" />
                    <text x={32} y={36} textAnchor="middle" fontSize={12} fontWeight={600} fill={col}>{afrPct === null ? "—" : afrPct + "%"}</text>
                  </svg>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: col }}>{word}</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>health score</div>
                    <div style={{ fontSize: 10, color: "#bbb" }}>aim under 50%</div>
                  </div>
                </div>
                <div style={{ paddingRight: 18, borderLeft: "1px solid #eee", paddingLeft: 18 }}>
                  <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>Momentum (MoRo)</div>
                  <div style={{ fontSize: 17, fontWeight: 600, color: moroCol }}>{review.moro >= 999 ? "all falls" : Math.round(review.moro) + "%"}</div>
                  <div style={{ fontSize: 11, color: "#bbb" }}>aim under 100%</div>
                </div>
                <div style={{ paddingRight: 18, borderLeft: "1px solid #eee", paddingLeft: 18 }}>
                  <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>Score by year</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#555" }}>
                    {review.afrByYear.map((v, i) => (
                      <span key={i} style={{ color: v === null ? "#ccc" : v >= 0.6 ? "#D85A30" : v >= 0.5 ? "#BA7517" : "#1D9E75" }}>
                        {v === null ? "—" : Math.round(v * 100) + "%"}{i < review.afrByYear.length - 1 ? " · " : ""}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "#bbb", marginTop: 2 }}>{rising ? "trending worse" : "not worsening"}</div>
                </div>
                {/* The point of the comparison: is this client tracking better or worse than
                    the plan expected by now, rather than just good or bad in isolation. */}
                {(() => {
                  const exp = results?.health?.afrByYear?.[review.latest.yr] ?? null;
                  if (exp === null || afrPct === null) return null;
                  const expPct = Math.round(exp * 100);
                  const gap = afrPct - expPct;
                  const gc = gap <= -5 ? "#1D9E75" : gap >= 5 ? "#D85A30" : "#888";
                  return (
                    <div style={{ borderLeft: "1px solid #eee", paddingLeft: 18 }}>
                      <div style={{ fontSize: 11, color: "#999", marginBottom: 3 }}>Against the plan</div>
                      <div style={{ fontSize: 17, fontWeight: 600, color: gc }}>{gap > 0 ? "+" : ""}{gap} pts</div>
                      <div style={{ fontSize: 11, color: "#bbb" }}>plan expected {expPct}% by year {review.latest.yr}</div>
                      <div style={{ fontSize: 10, color: "#bbb", marginTop: 2 }}>
                        {gap <= -5 ? "ahead of plan" : gap >= 5 ? "behind plan" : "in line with plan"}
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div style={{ padding: "0 16px 12px", overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%", minWidth: 340 }}>
                  <thead>
                    <tr style={{ color: "#999" }}>
                      <th style={{ textAlign: "left", fontWeight: 500, padding: "3px 8px 3px 0" }}>Warning sign</th>
                      <th style={{ textAlign: "right", fontWeight: 500, padding: "3px 8px" }}>This client</th>
                      <th style={{ textAlign: "right", fontWeight: 500, padding: "3px 0 3px 8px" }}>Plans like this failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.table.map(row => {
                      const o = row.odds === null ? null : Math.round(row.odds * 100);
                      const oc = o === null ? "#bbb" : o < 50 ? "#1D9E75" : o < 60 ? "#BA7517" : "#D85A30";
                      return (
                        <tr key={row.key} style={{ borderTop: "1px solid #f0f0f0" }}>
                          <td style={{ padding: "4px 8px 4px 0", color: "#555" }}>{row.label}</td>
                          <td style={{ padding: "4px 8px", textAlign: "right", fontWeight: 600, color: "#333" }}>{row.value}</td>
                          <td style={{ padding: "4px 0 4px 8px", textAlign: "right", fontWeight: 600, color: oc }}>{o === null ? "—" : o + "%"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ fontSize: 10, color: "#bbb", marginTop: 6 }}>
                  Odds come from the simulated plan above, so the parameters need to match this client's mandate for them to mean anything. Returns are implied from the balances entered, treating each year's withdrawal as taken at year end.
                  {review.beyond && <> <strong style={{ color: "#BA7517" }}>The history now runs past the simulated horizon, so the later years have no odds to read against.</strong></>}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Portfolio health — Sandidge's vital signs on the median path */}
        {/* Held back until there is a client history to compare against. At planning there is
            nothing to monitor — the signs measure experience the plan has not had, and at year
            one they separate the plans that failed from those that came through by about two
            points, so they would add machinery without adding information. Once actual figures
            exist this becomes the baseline the client is read against. */}
        {results && results.health && actuals.length > 0 && (() => {
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
                Plan baseline · median outcome, year {yr}
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}> · what the simulated plan looked like at this stage, for comparison with the client above</span>
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
                  <div style={{ fontSize: 17, fontWeight: 600, color: moroColor }}>{moro >= 999 ? "all falls" : Math.round(moro) + "%"}</div>
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
          {legend([
            ...(actuals.length ? [[COLORS.actual, "Actual", false] as [string, string, boolean]] : []),
            [COLORS.p95, "P95 best case", true], [COLORS.p90, "P75 optimistic", true],
            [COLORS.p50, "P50 median", false], [COLORS.p10, "P5 conservative", true],
            [COLORS.linear, "Fixed return", true],
          ])}
          <div style={{ position: "relative", height: 220 }}><canvas ref={c1Ref} /></div>
        </div>

        {/* Withdrawal chart */}
        {planDraws && (
          <div style={{ padding: "12px 16px 14px", borderTop: "1px solid #eee" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#444", marginBottom: 8 }}>Annual income withdrawal</div>
            {legend([[COLORS.p95, "P95 best case", true], [COLORS.p90, "P75 optimistic", true], [COLORS.p50, "P50 median", false], [COLORS.p10, "P5 conservative", true], [COLORS.linear, "Fixed return", true]])}
            <div style={{ position: "relative", height: 200 }}><canvas ref={c2Ref} /></div>

            {/* Year by year on the central projection. The chart shows the income; these are
                the two figures a review actually turns on — what share of the portfolio is
                being drawn, and how much the income moved. Read off the fixed-return path so
                the arithmetic is followable; the percentile bands above carry the spread. */}
            {(() => {
              const bal = results?.linPort, inc = results?.linW;
              if (!bal || !inc || inc.length < 2) return null;
              const rows = [];
              for (let y = 1; y <= years; y++) {
                const opening = bal[y - 1], income = inc[y - 1];
                if (opening === undefined || income === undefined) break;
                const prev = y >= 2 ? inc[y - 2] : null;
                rows.push({
                  y, opening, income,
                  rate: opening > 0 ? income / opening * 100 : null,
                  change: prev && prev > 0 ? (income / prev - 1) * 100 : null,
                });
              }
              return (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#444", marginBottom: 6 }}>
                    Year by year
                    <span style={{ fontSize: 11, fontWeight: 400, color: "#888" }}> · on the fixed-return projection</span>
                  </div>
                  <div className="mc-scroll" style={{ maxHeight: 240, overflowY: "auto", overflowX: "auto", border: "1px solid #eee", borderRadius: 6 }}>
                    <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%", minWidth: 330 }}>
                      <thead>
                        <tr style={{ color: "#999", background: "#fafafa", position: "sticky", top: 0 }}>
                          <th style={{ textAlign: "left",  fontWeight: 500, padding: "4px 8px" }}>Year</th>
                          <th style={{ textAlign: "right", fontWeight: 500, padding: "4px 8px" }}>Opening value</th>
                          <th style={{ textAlign: "right", fontWeight: 500, padding: "4px 8px" }}>Income</th>
                          <th style={{ textAlign: "right", fontWeight: 500, padding: "4px 8px" }}>Draw rate</th>
                          <th style={{ textAlign: "right", fontWeight: 500, padding: "4px 8px" }}>Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.y} style={{ borderTop: "1px solid #f2f2f2" }}>
                            <td style={{ padding: "3px 8px", color: "#555" }}>{r.y}</td>
                            <td style={{ padding: "3px 8px", textAlign: "right", color: "#555" }}>{fmt(r.opening)}</td>
                            <td style={{ padding: "3px 8px", textAlign: "right", fontWeight: 600, color: "#333" }}>{fmt(r.income)}</td>
                            <td style={{ padding: "3px 8px", textAlign: "right", fontWeight: 600, color: r.rate === null ? "#bbb" : r.rate > 6 ? "#D85A30" : r.rate > 5 ? "#BA7517" : "#1D9E75" }}>
                              {r.rate === null ? "—" : r.rate.toFixed(1) + "%"}
                            </td>
                            <td style={{ padding: "3px 8px", textAlign: "right", fontWeight: 600, color: r.change === null ? "#bbb" : r.change < 0 ? "#D85A30" : r.change < inflation ? "#BA7517" : "#1D9E75" }}>
                              {r.change === null ? "—" : (r.change > 0 ? "+" : "") + r.change.toFixed(1) + "%"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 10, color: "#bbb", marginTop: 5 }}>
                    Draw rate is the year's income against the value it started from, so it rises when the portfolio falls even if the income never changed. Change is amber below inflation ({inflation.toFixed(1)}%), since income growing slower than prices is losing ground even while the number goes up.
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Footer */}
        {results && (
          <div style={{ padding: "8px 16px", borderTop: "1px solid #eee", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "#888", marginTop: "auto" }}>
            <span>Beat start: <strong style={{ color: "#222" }}>{results.pctBeat}%</strong></span>
            <span>Total invested: <strong style={{ color: "#222" }}>{fmt(results.totalIn)}</strong></span>
            {planDraws && results.drawnMedian > 0 && (
              <span>Income drawn: <strong style={{ color: "#222" }}>{fmt(results.drawnMedian)}</strong>
                <span style={{ color: "#bbb" }}> · {fmt(results.drawnMedianReal)} in today's money</span>
              </span>
            )}
            {planDraws && results.pctRuined > 0 && <span style={{ color: results.pctRuined > 20 ? "#D85A30" : "#888" }}>Depleted: <strong>{results.pctRuined}%</strong></span>}
          </div>
        )}

        {/*
          On screen the assumptions are visible in the sidebar the whole time. On paper the
          sidebar is gone, so a reader would be looking at outcomes with no idea what produced
          them — which is the difference between a report and a set of unattributed numbers.
        */}
        {results && (
          <div className="print-only avoid-break" style={{ padding: "14px 16px", borderTop: "1px solid #eee", fontSize: 10, color: "#555", lineHeight: 1.6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#333", marginBottom: 5 }}>Assumptions</div>
            <div>
              Expected return {ret.toFixed(1)}%/yr before fees
              {otherFees > 0 && <> · advice {adviceFee.toFixed(2)}% and platform {platformFee.toFixed(2)}%, so {(ret - otherFees).toFixed(2)}% net</>}
              {" "}· volatility {vol.toFixed(1)}%/yr · inflation {inflation.toFixed(1)}%/yr
              {" "}· horizon {years} years · {sims.toLocaleString()} simulated paths
              {activeModel && <> · model {activeModel.name}</>}
            </div>
            <div>
              Starting value {fmt(init)}
              {planMode !== "post" && contrib > 0 && <> · contributing {fmt(contrib)}/mo{contribEsc > 0 && <> rising {contribEsc.toFixed(1)}%/yr</>}</>}
              {planMode === "both" && retireDate && <> · retiring {retireDate}</>}
              {planDraws && spendPolicy === "endowment"
                ? <> · Income Review rule at {spendRate.toFixed(2)}% with {smoothing}/{100 - smoothing} smoothing</>
                : planDraws && <> · drawing {fmt(withdraw)}/mo{effEsc > 0 && <> rising {effEsc.toFixed(1)}%/yr</>}</>}
              {lumps.length > 0 && <> · {lumps.length} capital injection{lumps.length > 1 ? "s" : ""} totalling {fmt(lumps.reduce((s, l) => s + l.amount, 0))}</>}
            </div>
            <div style={{ marginTop: 8, fontSize: 9, color: "#888" }}>
              A Monte Carlo simulation projects many possible return sequences drawn at random around the
              assumptions above. It shows how a plan behaves across a range of outcomes; it does not forecast
              any of them. Returns are assumed to be normally distributed, which understates the chance of a
              severe market fall, and the assumptions themselves — return, volatility, inflation and fees —
              are estimates that will not hold exactly. Figures are before tax and take no account of changes
              in legislation. Past performance is not a guide to future returns. This is not advice: it is a
              planning illustration to be read with the adviser named above, whose firm is responsible for
              any recommendation made from it.
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
