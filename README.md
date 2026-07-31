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
- **Withdrawal guardrail** — freezes next year's increase only when *both* the balance is below a
  configurable band (default 90%) of a fixed expected-balance trajectory *and* that year's market
  return was negative. The trajectory is projected once at inception at the net return with
  withdrawals always escalating, and is never re-baselined against actual paths. Frozen increases are
  permanently forgone, not banked. Because each path's returns are replayed with and without the rule,
  the reported improvement is a like-for-like comparison rather than two independent draws.
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
