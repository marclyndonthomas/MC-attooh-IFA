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
- **Contributions** with optional annual escalation (%/yr).
- **Withdrawals** with optional annual escalation, and rules to *skip* an escalation in a given year:
  - never, only in years with a negative portfolio return, or on a fixed cadence (e.g. every 3rd year).
- **Capital injections** — one-off lump sums added in a specific year (multiple supported).
- **Market assumptions** — expected annual return and annual volatility (σ), used to draw normally-distributed monthly returns (Box-Muller `randn()`).
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
