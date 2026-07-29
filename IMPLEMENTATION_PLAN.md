# Plan v2 — rebuild the UI for one phone, one person, daily use

Written after re-reading every message. Supersedes v1 (native/AI phases, now shipped).

**Target device is not "Android".** It is one Xiaomi 2411DRN47I (Redmi Note 14 Pro),
HyperOS on Android 16 / SDK 36, en-GB, with Google Pay, PhonePe, Paytm, BHIM, Amazon
Pay, WhatsApp, Kotak 811, Kotak Neo, Navi and Google Messages installed. Every default
should be derived from that, not from a generic list.

---

## What is actually wrong

Your words, mapped to what I found in the code.

### "UI and navigation is bad, and you are building on top of it"

Correct, and I was. The inherited structure is five flat peer tabs (Home, Accounts,
Activity, Budgets, Goals) — an *object model*, not a *task model*. It answers "what
kinds of records exist" when the daily question is "what do I do right now".

Measured cost of the two things you do every day:

| Task | Taps today | Should be |
|---|---|---|
| Log a spend | FAB → verb → amount → save (+2 sheet animations) | 2 |
| Confirm a captured SMS txn | Settings → Automation → queue → item → accept | 1, on the first screen |
| Pay someone and record it | not a single flow at all | 3 |

### "UPI and payment modules logic and UI is very bad"

- `upi.js:scanUpiQr` polls `BarcodeDetector` on a `<video>` at 300 ms with no viewfinder,
  no torch, no "move closer", and no result if the API is missing. On HyperOS this is
  the difference between a scanner that works and one that stares blankly.
- There is **no pre-payment screen**. The whole premise — decide *before* paying — is absent.
- There is **no post-payment confirmation**. The app cannot distinguish paid from cancelled.
- The UI never lets you pick which app to pay with, so the native routing I just shipped
  is unreachable.
- Static QR (no amount) has no amount-entry path.

### "Automation modules logic and UI is very bad, not customised for my phone"

- `automation.js` stores the queue in **`localStorage`** while the entire rest of the app
  uses IndexedDB through `store.js`. Consequences: the review queue is invisible to
  backup/export, survives "erase everything", and is capped at 30 items.
- `POPULAR_FINANCE_APPS` is a hardcoded generic list that does not contain Kotak 811,
  Kotak Neo or Navi — three apps actually on your phone.
- The queue is buried behind Settings → Automation. Captures you never see are captures
  that do nothing.
- Nothing reconciles a capture against a transaction you already logged manually.

### Already fixed this session (native layer, shipped in `e0b7517`)

Biometric callbacks · directed UPI `setPackage` routing · `getInstalledUpiApps` ·
SMS receive + inbox back-fill · one shared integer-paise parser · `QUERY_ALL_PACKAGES`
(Kotak/Navi were invisible) · Xiaomi autostart + battery escape hatches · device
auto-profiling · new logo.

**The plumbing works. Nothing in the UI exposes it yet.** That is the whole of this plan.

---

## The rebuild

### 1. Four hubs, chosen by task

```
Today     what do I do right now      review queue, quick-log, safe-to-spend, today's movements
Pay       move money                  scan, pay a person, routing rules, pre/post payment
Ask       think about money           AI chief of staff
Money     the records                 accounts, budgets, goals, debts, insights
```

Accounts/Budgets/Goals/Activity stop being top-level. They are *records*, consulted
weekly. The queue and quick-log are *daily*, so they get the front page.

- [ ] Rewrite `app.js` routing: 4 hubs, horizontal swipe, direction-aware transitions.
- [ ] `Today` gets: review-queue cards (accept/edit/dismiss inline), an always-visible
      quick-log bar, safe-to-spend, today's list.
- [ ] `Money` becomes a segmented hub over the existing four screens — those render
      fine, they are just mis-placed in the hierarchy.
- [ ] Delete the FAB. A quick-log bar on Today beats a button that opens a sheet that
      opens a sheet.

### 2. Quick-log: two taps, no sheet

- [ ] Amount pad inline on Today. Category chips ranked by your actual frequency.
      Account defaults to last used. Save commits and clears without navigating.
- [ ] Long-press a chip to make it the default.

### 3. Payment flow, end to end

- [ ] **Scan** — proper viewfinder: framing box, torch toggle, "move closer" on small
      QR, gallery import, and manual VPA entry as a first-class path (not a fallback).
- [ ] **Pre-payment card** (the actual differentiator): payee, what you usually pay them,
      which budget it hits and how much headroom is left, duplicate-payment warning,
      new-VPA-for-known-payee warning — *before* the UPI app opens.
- [ ] **Route** — which app, and why, from the rules engine already in `store.js`
      (`resolveUpiApp`: vendor > category > amount band > default). One tap to override,
      one tap to make the override permanent.
- [ ] **Post-payment** — on resume, ask: Paid / Probably / Failed / Cancelled. Never
      assume success because an app opened. Attach note, category, receipt photo.
- [ ] Static QR with no amount → amount entry pre-filled with your usual for that payee.

### 4. Automation you can actually see

- [ ] Move the capture queue out of `localStorage` into IndexedDB via `store.js`, so it
      is backed up, exportable, and erasable with everything else.
- [ ] Queue cards on `Today`: amount, merchant, source app, one tap to accept as a
      transaction, swipe to dismiss.
- [ ] **Reconciliation** — a capture matching a transaction you already logged (same
      amount, ±90 s) offers to merge instead of duplicating.
- [ ] App picker built from `getInstalledApps()` — your real apps, with real names,
      pre-ticked from the device profile.
- [ ] **Health card**: notification access, SMS permission, battery unrestricted,
      Xiaomi autostart — each with a one-tap fix. Without this the automation dies
      silently and looks like it was never built.
- [ ] SMS back-fill button: pull the last N days from the inbox on demand.

### 5. Ask

- [ ] Chat surface over the engine already in `ai.js`. Streaming, suggested openers
      drawn from live state ("why was this month expensive?"), and an inspectable,
      deletable memory list.
- [ ] Voice input via `SpeechRecognition` — one tap, speak, confirm.

### 6. Xiaomi-specific polish

- [ ] Respect the gesture-nav inset; HyperOS's pill overlaps a bottom bar at default insets.
- [ ] 120 Hz: keep transforms/opacity only on animated paths, no layout thrash.
- [ ] Honour the device's dark mode and the en-GB locale already detected.

---

## Order

1. Hub navigation + Today (unblocks everything; biggest daily win)
2. Automation queue on Today + health card (makes shipped native work visible)
3. Payment flow (scan → pre-pay → route → confirm)
4. Ask
5. Xiaomi polish

Each step ends with `node test.js`, a Gradle build, an `adb install`, and a clean
Logcat boot before the next one starts.

---

## Not doing

AR overlays · merchant/gateway mode · Account Aggregator · accessibility scraping ·
community fraud data · split/household/trip modes · on-device ML.

Rules plus frequency counts beat a classifier until there are thousands of
transactions. Revisit at year two.

---

## Needs you

1. **Rotate the OpenRouter key** and paste it into `secrets.js` (gitignored, bundled
   into the APK, never into the public repo). AI is inert until then.
2. One-time on the phone, after the next install: enable Notification access, grant SMS,
   set battery to Unrestricted, and turn on Autostart. The health card will link to each.
