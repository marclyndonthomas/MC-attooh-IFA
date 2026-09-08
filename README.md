# Monte Carlo Investment Simulator

A single-page React dashboard that runs a Monte Carlo simulation of a portfolio's future value under
contributions, withdrawals, escalation, lump-sum capital injections, and stochastic market returns.
Results are shown as percentile bands (P5 / P50 / P75) against a naive fixed-return (no-volatility) projection.

Currency labels are in ZAR (R), but the model is currency-agnostic — the number is just a starting value.

## Features

- **Single simulation mode — *variable return and sequence risk*** — every simulated path draws its own
  random monthly returns, so results carry both an uncertain realised average return and
  sequence-of-returns risk. (The master simulator also offers a "same mean" mode that holds the average
  fixed to isolate sequence risk; this attooh IFA variant deliberately leaves it out so there is one consistent
  basis for every projection shown to a client. The label is worded for advisers explaining the chart to
  clients, not in statistical terms.)
- **One run from working life through retirement.** Set a retirement date and the plan
  contributes until then, stops, and draws afterwards — so accumulation and drawdown are a
  single simulation rather than two. Leave the date blank and it behaves as it always did,
  drawing from the start. The pivot is month-granular, and the simulated paths, the guardrail's
  trajectory, the fixed-return line and the income line all switch phase at the same month.

  Retirement income can be set three ways: an amount in **today's money** (carried forward by
  inflation), an amount **at the retirement date** (used exactly as entered), or a **% of the
  balance** that path actually reached. The first two put the same demand on every path
  regardless of how the saving phase went, which is what makes the success rate meaningful; the
  third adapts to the balance. An "At retirement" panel reports the balance handed over.

  Horizon runs to 70 years to fit both phases.
- **Risk profile check.** The client's profiled risk is recorded from the questionnaire, and the
  panel states the profile the bucket structure *implies* alongside it, with the difference named
  in steps on the firm's own model ladder.

  The reason it exists: cover is an allocation decision wearing a different label. Years of cover
  multiplied by the drawdown rate **is** the defensive share — arithmetic, not a modelling choice —
  so 4+4 years at a 7% drawdown fixes the portfolio at 56% defensive whatever the client was
  profiled as, and a higher income automatically produces a more cautious portfolio. Without this
  the two could disagree indefinitely and nobody would see it.

  The implied volatility is computed from the split using asset-class figures (defensive 3.85%,
  growth 12.90%, correlation 0.12) rather than the single blended volatility the simulation runs
  on, because the question is what the *split* implies. It is then matched to the nearest rung of
  the selected model range, so the comparison is in the adviser's own language. The profiled
  figure drives nothing in the simulation — it is recorded and compared, never applied.
- **Bucket structure** can be switched off. One flag gates the whole overlay — its sidebar
  sliders, its results panel and its share of the printed report — rather than three places kept
  in step by hand. The switch is gated on the unswitched view, so turning it off does not take
  the switch away with it. Off or on, the simulation is identical: the overlay never reaches the
  engine, and the state is saved with the plan.
- **Advice annexure** — a second printed document, built against a generic FAIS-shaped Record of
  Advice, for attaching to the adviser's own ROA. It carries client and adviser details, the risk
  profile comparison with space to record a difference, what was modelled, the projection evidence,
  the assumptions, the limitations, and signature blocks.

  Two things about it are deliberate. The **basis of the recommendation** leads with the paired
  comparison — the same plan replayed on identical market paths with and without the rule — rather
  than a bare success rate, because a probability is a fact about the assumptions while a
  like-for-like difference survives them. And it states the **bounded commitment**: the most the
  income can fall in a year, disclosed in advance.

  It also prints, in full, **what it does not cover** — product and platform selection, whether an
  annuity would suit better, replacement disclosures, fee reasonableness, and the client's own
  objectives and position — with blank fields for the adviser to complete. Sections the simulator
  cannot populate are printed as blanks rather than omitted, so a reader sees what is still owed.
  The closing paragraph states plainly that the annexure is not advice and is not a Record of Advice.
- **Save as PDF** — prints a client report through the browser's own *Save as PDF* destination,
  so there is no PDF library and it honours the user's paper size. The sidebar, tab bar and
  controls drop out; the header carries the client, adviser and FSP details plus the date the
  figures were produced; and an assumptions block and disclaimer are added, since on paper the
  sidebar is gone and the outcomes would otherwise be unattributed numbers.

  The reason this needed doing at all is that the results live in panels that scroll inside
  themselves — the year-by-year table is capped at 240px on screen — so a plain Ctrl+P captured
  only the first screenful of each and silently cut the rest. The print rules unclip them, and
  because the component styles inline, every one of those rules needs `!important` to win.
- **Clients tab** — nominate a folder once (one inside OneDrive works well) and the tab lists every
  plan in it, most recently saved first, with a click to open. *Save plan* then writes straight into
  that folder, and *+ New client* clears the form while keeping the adviser and FSP details, since
  re-typing those invites a wrong code.

  The browser holds only a handle to the folder, kept in IndexedDB — never the client details, which
  stay in ordinary files that OneDrive backs up, that can be sent to an adviser, and that are deleted
  by deleting the file. An open plan is written back to the file it came from, so renaming a client
  updates the record rather than leaving a second copy under the new name; the list shows the name
  from inside each file for the same reason. Files that are not plans are ignored rather than guessed at.

  The folder permission does not always survive a reload and can only be re-granted from a click, so
  a lapsed one shows a *Reconnect* prompt — otherwise it would be indistinguishable from an empty folder.

  Needs the File System Access API (Chrome/Edge). Elsewhere the tab is hidden entirely and the
  save/open buttons below carry on as before, so nothing breaks for an adviser on another browser.

  It is a way to find and reopen a plan quickly, **not a system of record**: no search across clients,
  no history of changes, and if two people open the same file from a shared folder the last save wins.
- **Save / open a plan.** *Save plan* writes every input — client and adviser details, portfolio,
  policy, fees, injections and entered history — to a `<client>-plan.json` file; *Open plan* reads
  it back. That is the only persistence: nothing is written to browser storage, so a client's ID
  number and date of birth do not accumulate on a machine that may be shared, and the adviser
  chooses where the file is filed. The trade-off is that closing the page without saving loses
  the work.

  Loading applies only fields the tool knows, and only where the type matches the field, so a
  hand-edited or truncated file is reported rather than half-applied — the note says how many
  settings were taken and how many were ignored. Results and the solved rate are cleared on load,
  since they belong to the inputs being replaced. Derived values are never written to the file;
  they are recomputed, and storing them would let a stale figure outlive its inputs.
- **Contributions** with optional annual escalation (%/yr).
- **Withdrawals** with optional annual escalation, and rules to *skip* an escalation in a given year:
  - never, only in years with a negative portfolio return, on a fixed cadence (e.g. every 3rd year),
    or via the **guardrail** below.
- **Health-score rule** — freezes next year's increase whenever the health score (below) passes a
  chosen threshold, default 50%: the point at which plans showing these warning signs more often
  than not end below 40% of their capital. Because the signs are cumulative it responds to
  built-up momentum, so unlike the guardrail its strength scales with how stressed the plan is.
  Measured on shared return sequences at 40 years: on a 2.67% draw it reaches 98% success with
  3.6 freezes (guardrail: 96%, 5.2 freezes); on a 4.7% draw it reaches 95% where the guardrail
  manages 17%.

  The odds it consults come from a separate unruled calibration pass, never from paths that
  already used the rule — otherwise it would be judging itself.
- **Funding-level rule** — holds next year's increase when the portfolio falls below a configurable
  share (default 100%) of the present value of the income it still has to pay, **or** below its
  starting rand value. Available under either spending policy, since the test is on the state of the
  plan rather than on how the income is set. Frozen increases are permanently forgone, not banked,
  and because each path's returns are replayed with and without the rule the reported improvement is
  like-for-like rather than two independent draws.

  This replaced an earlier guardrail that held only when the balance was below an expected-balance
  trajectory **and** the year's return was negative. The return condition is the error: a plan can
  grind into serious underfunding through a run of small positive years, and a rule that waits for a
  loss never sees it. The two limbs kept here fail at different times — the funded ratio fires early
  on a poor opening sequence then falls quiet, while the starting-value test adds nothing in the
  first decade and catches plans late as its threshold deflates.

  The income is valued as a level real stream at a **real discount rate** (default 4.5%) over the
  years remaining to a **planning age** (default 95), taken from the client's date of birth where one
  is entered and from the plan horizon otherwise. Those two are calibrations rather than client
  facts and they move the answer, so they are exposed rather than buried: a cautious pair buys no
  extra survival and pays the client less.
- **Explicit reduction**, off by default. Below a funded ratio of 0.85 the income is cut so the
  **total real reduction** for that year reaches 8%, the withheld increase supplying part of it and
  an explicit cut the rest.

  The reason it exists: a rule whose only action is withholding an increase has a maximum
  intervention exactly equal to the inflation rate, so its strength is set by the inflation regime
  rather than by how much trouble the plan is in — at 3% inflation it cannot remove more than 2.9%
  of real income however underfunded the plan becomes. Measured on this engine at a 7% drawdown with
  real returns held identical and only inflation varying between 3% and 5.5%, a hold-only rule's
  30-year survival spans 72–95% (22 points); with the reduction it spans 94–98% (4 points).

  It is off by default because it changes what a client must be told at outset — that their income
  can fall 8% in real terms in a year — which is a disclosure decision rather than a modelling one.
- **Capital injections** — one-off lump sums added in a specific year (multiple supported).
- **Market assumptions** — expected annual return and annual volatility (σ), used to draw normally-distributed monthly returns (Box-Muller `randn()`).
- **Portfolio health diagnostic** (shown once there are withdrawals) — the "vital signs" from
  Sandidge's *Linear Thinking in a Nonlinear Retirement-Income World*, read off the median
  simulated path for any chosen year. Two headline figures: a **health score** (his Average
  Failure Rate, aim under 50%) and **MoRo**, his momentum ratio of falls to rises in account
  value (aim under 100%). Beneath them, nine warning signs with the reading, its target, and
  the share of comparable plans that failed.

  Failure rates are calibrated from the current run rather than his proprietary tables, so the
  odds reflect the assumptions on screen. Targets are derived **per year** — the reading at
  which those odds pass 50% — because a fixed target would flag healthy plans as failing
  (five negative years is alarming by year 5 and unremarkable by year 25). Note the calibrated
  MoRo threshold independently lands on his published 100%.

  This catches what the guardrail cannot: the guardrail only ever inspects the current year,
  while these signs are cumulative and so measure built-up momentum. A stressed plan reads
  "at risk" by year 3, well before the balance looks obviously damaged.
- **Funding position** (shown for saving plans, i.e. no withdrawal) — the accumulation
  counterpart to the health diagnostic: funding ratio (median ÷ the fixed-return plan), median
  and 25th-percentile outcomes, and, when a savings goal is set, the probability of reaching it
  plus the contribution that would reach it on the central projection.

  Sandidge's vital signs are deliberately **not** shown here, and that is a finding rather than
  an omission. Testing on this model: with contributions going in, account value rarely falls,
  so his momentum ratio has almost no variation to measure; his signs separated best from worst
  outcomes by only 5–15 percentage points, against 38 for a plain funding ratio. More
  importantly the direction of sequence risk **inverts** — weak returns early proved 22.9%
  *better* for a saver, because contributions buy in cheaply — so his signs would raise the
  alarm exactly when a saving plan is doing well. (His own paper says accumulation is linear and
  order does not matter; that holds for a lump sum, but with monthly contributions the forward
  and reversed orderings differed by a median 20% of final value.)

  Note the required-contribution figure ignores volatility, so clearing the goal on that
  projection still leaves roughly even odds — the probability figure is the honest one.
- **Inflation-adjusted ("real") results** alongside nominal.
- **Implied CAGR** for each percentile outcome and the fixed-return projection.
- **Depletion date estimate** — first calendar month/year a percentile path hits zero.
- **Success/ruin metrics** — % of paths that stay positive, beat the starting value, or are fully depleted.
- Two live charts (portfolio value over time, and annual withdrawal income over time) rendered with Chart.js, including a shaded P5–P75 band and annotated injection markers.

## Tech stack

- [React 19](https://react.dev/) + [Vite](https://vitejs.dev/) + TypeScript
- [Chart.js 4](https://www.chartjs.org/) — loaded at runtime from a CDN (no npm dependency), so no chart libraries need installing
- No backend — everything runs client-side in the browser

## Getting started

Prerequisites: [Node.js](https://nodejs.org/) 18+ and npm.

```bash
git clone https://github.com/marclyndonthomas/Monte-Carlo-Simulator.git
cd Monte-Carlo-Simulator
npm install
npm run dev
```

Then open the URL Vite prints (default `http://localhost:5173`).

Other scripts:

```bash
npm run build     # type-check and produce a production build in dist/
npm run preview   # serve the production build locally
```

## Project structure

```
mc_dashboard_react.tsx   # the simulator itself — all state, sim logic, and UI (source of truth)
src/
  App.tsx                # thin re-export of mc_dashboard_react.tsx as the app's root component
  main.tsx                # React entry point, mounts <App /> into index.html
  index.css               # global styles
index.html                # Vite HTML entry
vite.config.ts            # Vite + @vitejs/plugin-react config
tsconfig*.json             # TypeScript project configs
```

The simulator's actual logic lives entirely in [`mc_dashboard_react.tsx`](mc_dashboard_react.tsx) at the
repo root, not inside `src/`. `src/App.tsx` just does `export { default } from "../mc_dashboard_react"`
so the scaffolding around it (Vite, TS config, HTML entry) can stay generic while the model file stays a
single, easy-to-share component.

## How the simulation works (brief)

For each of `N` simulated paths, monthly returns are drawn as `expectedReturn/12 + (vol/√12) * Z`
where `Z` is a standard normal random draw. The portfolio is stepped month-by-month, applying
contributions, withdrawals, any lump-sum injections due that month, and escalation rules at each
year boundary. Final values across all paths are sorted to read off the 5th/50th/75th percentiles;
the same percentile logic is applied to the year-by-year portfolio value to draw the percentile bands
on the chart. A separate fixed-return path (`linPort` in the code) uses the expected return with zero
volatility as a naive comparison baseline. Note it still *compounds*, so it is a smooth curve rather
than a straight line — the UI calls it "fixed return", not "linear", for that reason.

## Working with this project in Claude Code

If you're picking this repo up with [Claude Code](https://claude.com/claude-code):

- The whole app is one component: read `mc_dashboard_react.tsx` first — it contains all state,
  the simulation loop, and the render/UI code together (no separate reducer/store/component files).
- `src/App.tsx` is intentionally a one-line re-export; edit the model in `mc_dashboard_react.tsx`,
  not in `src/`.
- There's no test suite or backend — verifying a change means running `npm run dev` and checking the
  dashboard renders and recalculates correctly in a browser (e.g. via the Preview tool), not just that
  it type-checks or builds.
- Chart.js is injected at runtime via a `<script>` tag pointed at a CDN URL inside a `useEffect` — it is
  *not* an npm dependency, so don't add `chart.js` to `package.json` when working on chart-related code.
- `.claude/launch.json` (gitignored, machine-local) defines a `mc-dashboard-dev` launch config that runs
  `npm run dev` on port 5173 for use with Claude Code's preview tools.
