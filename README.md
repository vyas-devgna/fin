# Fin

A calm, offline-first money app. It exists to answer five questions and nothing else:
how much you have, where it is, where it came from, where it went, and where it should go next.

**Live:** <https://fin.vyasdevgna.online>

Install it from the browser menu ("Add to Home Screen"). After that it works with no network at all.

---

## What it does

**Eight verbs, and that is the whole vocabulary.** Receive, Spend, Transfer, Save, Withdraw,
Borrow, Lend, Repay. Every screen, chart and total is derived from those.

- **Accounts** — as many as you like, each either *spendable* or *set aside*. Set-aside accounts
  are held back from "available to spend" and counted as savings.
- **Borrowing and lending** are real money flows, not notes. Partial repayments, running balances
  per person, optional due dates.
- **Budgets** are a monthly ceiling with a progress ring, a daily allowance, and a quiet warning
  when you are spending faster than usual. Only spending counts — transfers never touch a budget.
- **Goals** track a target, an optional deadline, and tell you the monthly pace to hit it.
- **Repeating entries** for rent, salary and EMIs, created automatically when they fall due —
  including any that came due while the app was closed.
- **Insights** — income against spending, balance over time, where it went, savings growth,
  spread across accounts. Six charts, no jargon.

Handles ₹5 and ₹5 crore in the same ledger, with Indian digit grouping throughout
(`₹50,00,000`, compact `₹15.2L` / `₹2.5Cr`).

## Where the data lives

On your device, in IndexedDB. Nothing is uploaded, there is no account, and there is no server.

That cuts both ways: **if you lose the device, you lose the records.** Settings → *Export a backup*
writes a single `.json` file; *Restore a backup* reads it back. The app nudges you if it has been
more than a month. Settings → *Storage* asks the browser not to evict the data under pressure.

## Running it locally

No build step. No dependencies. The files you see are the files that ship.

```bash
node tools/serve.js
```

Then open <http://localhost:4321>.

## Tests

```bash
node test.js
```

25 checks over the money maths in `core.js` — conservation across transfers, partial debt
repayment, budget and goal arithmetic, month-end recurrence clamping, Indian formatting, and
integer-paise exactness at both ends of the scale.

Two bugs this suite caught that reading the code did not:

- `x | 0` truncates to **32 bits**, silently wrapping any amount above **₹21,47,483.65** — so a
  property deal or a large loan would have corrupted the ledger with no error. Fixed with
  `Math.trunc`.
- A thousand ₹0.10 entries must total exactly ₹100. They do, because money is stored as integer
  paise and never as a float.

## Layout

| File | What it holds |
|---|---|
| `core.js` | Pure money maths. No DOM, no storage — this is what `test.js` pins down. |
| `db.js` | IndexedDB. Reads everything once at boot, writes through on change. |
| `store.js` | State and mutations. The only place the ledger can change. |
| `ui.js` | Sheets, toasts, haptics, swipe, animated numbers. |
| `sheets.js` | The composer and every editor. |
| `charts.js` | All six charts, hand-drawn in SVG. |
| `app.js` | Router and the five screens. |
| `sw.js` | Offline shell. |

**No dependencies, on purpose.** A chart library would be ~180 KB to draw six shapes and would
fight the app's typography and easing. Everything here has to be vendored anyway, because the app
must work in aeroplane mode — so "add a library" really means "commit and maintain someone else's
code for five years".

## Icons

```bash
node tools/gen-icons.js
```

Rasterises the app mark to PNG with a hand-rolled encoder on `node:zlib`, so there is no image
dependency in a project whose whole point is having no build step.

## Deploying

Push to `main`. GitHub Pages serves the repository root; `CNAME` points the custom domain.

`sw.js` uses a cached shell, so a deploy reaches installed users on their **next** visit —
the page offers a "Reload" toast when a new version has been fetched.
