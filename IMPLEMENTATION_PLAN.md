# Fin → SpendRouter: Implementation Plan

Grounded in a read of the actual code at commit `078ace5`, not the aspirational spec.
Positioning: **a payment router and expense-intelligence wrapper.** Money never passes
through the app. It scans, classifies, routes to a UPI app, records, and learns.

Single user, single device. No commercial constraints, no Play Store policy limits,
no multi-tenant concerns. That changes what is worth building: SMS reading is fine,
hardcoded keys are fine (with the caveat in §0), and there is no onboarding to design
for strangers.

---

## §0 — Blocking issue: the API key

`vyas-devgna/fin` is a **public** repository. Committing `sk-or-v1-…` there gets it
scraped and drained within minutes; this is automated and reliable, not hypothetical.
The key in the request has also been pasted in plaintext chat, so it is already burned.

**Resolution shipped in Phase 2:**

| Surface | Key source | Setup cost |
|---|---|---|
| Android APK (primary) | `secrets.js`, gitignored, copied into APK assets at build | zero |
| Public PWA | prompt once → IndexedDB | one paste, once |
| Public repo | `secrets.example.js` placeholder only | n/a |

Action required from you: rotate the key, put the new one in `secrets.js`, and set a
credit limit on it at openrouter.ai.

---

## §1 — What is actually broken right now

Verified by reading the source, not by claim.

| # | Defect | Location | Root cause |
|---|---|---|---|
| 1 | **Biometric lock never unlocks** | `MainActivity.kt:246` | `onAuthenticationSucceeded` only shows a Toast. No `onAuthenticationError`, no `onAuthenticationFailed`, and no call back into JS. The web layer waits forever. |
| 2 | Device-credential fallback also silent | `MainActivity.kt:266` | `startActivityForResult(…, 102)` with no `onActivityResult` override. |
| 3 | **Cannot set a default UPI app** | `MainActivity.kt:166` | Always `Intent.createChooser(...)`. Never `setPackage(...)`. |
| 4 | No way to list installed UPI apps | `MainActivity.kt` | `getInstalledUpiApps()` does not exist. |
| 5 | UPI apps may be invisible on Android 11+ | `AndroidManifest.xml:10` | `<queries>` declares only the `upi` scheme; explicit packages are absent. |
| 6 | **No SMS reading at all** | `AndroidManifest.xml` | `RECEIVE_SMS` / `READ_SMS` absent; no receiver; `FinSmsReceiver.kt` does not exist. |
| 7 | Notification queue is write-only from native | `MainActivity.kt:206` | JS polls `getNotificationQueue()`; nothing pushes on arrival except one `evaluateJavascript` path. |
| 8 | AI has no memory and no persona | `ai.js:82` | System prompt is rebuilt per call from nothing. No vendor graph, no ledger context, no continuity. |
| 9 | AI key requires manual entry | `ai.js:40` | Throws if `localStorage` is empty. |
| 10 | Navigation is a flat 5-tab list | `app.js` | Every task costs 3–5 taps. No quick-log. No review queue surfacing. |

---

## §2 — Phase plan

### Phase 1 — Native layer (fixes 1–7)

- [ ] `AndroidManifest.xml`: add `RECEIVE_SMS`, `READ_SMS`, `USE_BIOMETRIC`,
      `QUERY_ALL_PACKAGES`; register `FinSmsReceiver`; add explicit `<package>`
      entries for GPay, PhonePe, Paytm, BHIM, Amazon Pay, CRED, WhatsApp, Samsung Pay,
      and the major bank apps.
- [ ] `MainActivity.kt`:
  - [ ] `requestBiometricLock()` → wire **all four** callbacks
        (`Succeeded`, `Failed`, `Error`, negative-button) to
        `window.FinApp.onBiometricResult(bool, reason)`.
  - [ ] Override `onActivityResult` for the device-credential path (request 102).
  - [ ] `getInstalledUpiApps()` → JSON `[{package, label}]` via `queryIntentActivities`.
  - [ ] `launchUpiIntent(uri, targetPackage)` → `setPackage()` when a package is given,
        chooser only when it is empty or resolution fails.
  - [ ] `readRecentSms(limit, sinceMillis)` → on-demand inbox read for back-fill.
  - [ ] `postToWeb(fn, json)` helper so native→JS calls stop being ad-hoc strings.
- [ ] `FinSmsReceiver.kt` (new): `SMS_RECEIVED` broadcast → parse → append to the
      shared queue → nudge the WebView if it is alive.
- [ ] `FinNotificationListener.kt`: widen the parser; share one parsing function with
      the SMS receiver rather than duplicating regex.
- [ ] `android/.gitignore` — `build/`, `.gradle/`, `local.properties` are currently
      untracked but would be committed by a blanket `git add`.

### Phase 2 — AI that actually remembers (fixes 8–9)

- [ ] `secrets.js` (gitignored) + `secrets.example.js` + `.gitignore` entry.
- [ ] `ai.js` key resolution order: `secrets.js` → IndexedDB → prompt.
- [ ] **Persona**: a Chief-of-Staff system prompt that is blunt, numeric, and refuses
      to give generic advice. Rebuilt each call from live ledger state, not static text.
- [ ] **Memory**, three tiers, all local:
  - `vendorMemory` — VPA/merchant → category, usual amount range, preferred app,
    visit count, last seen, trust.
  - `aiFacts` — durable user facts the model may write ("rent is due on the 3rd",
    "Ravi is a flatmate"), each with provenance and a delete button.
  - `chatLog` — last N turns, trimmed by token budget, never unbounded.
- [ ] **Structured output only.** The model returns JSON commands against a schema;
      `store.js` validates and applies. The model never writes the ledger directly —
      an LLM that can silently mutate a money database is a bug generator.
- [ ] Offline heuristic stays the fallback on every path.

### Phase 3 — Navigation rebuilt for daily use (fix 10)

Current cost of the most common action (log a spend): tap FAB → pick verb → type →
save = 4 interactions plus two sheet animations.

Target: **one thumb, one screen, under two seconds.**

- [ ] **Persistent quick-log bar** on Home: amount pad is always present, category is
      one tap, save is one tap. No sheet for the common case.
- [ ] **Four hubs** instead of five flat tabs:
  - `Today` — safe-to-spend, quick-log, review queue badge, today's movements
  - `Pay` — scan, VPA entry, routing rules, pre-payment budget check
  - `Ask` — AI chief of staff
  - `Money` — accounts, budgets, goals, debts, insights (was four separate tabs)
- [ ] **Review queue** front and centre — SMS/notification captures are worthless if
      they are three taps deep.
- [ ] Swipe between hubs; back gesture always safe; every destructive action undoable.
- [ ] Biometric shield renders **before** first paint, not after.

### Phase 4 — Routing intelligence

- [ ] Vendor → app rules, category → app rules, amount-band rules, with an explicit
      precedence order (vendor > category > amount > default) and a visible
      "why this app" explanation.
- [ ] Pre-payment card: usual amount, budget headroom, duplicate-payment warning,
      new-VPA-for-known-vendor warning.
- [ ] Post-payment reconciliation: `Paid / Probably / Failed / Cancelled`, never
      assume success because an app opened.

### Phase 5 — Verification

- [ ] `node test.js` — extend to cover SMS regex variants, routing precedence,
      envelope maths, and AI command-schema validation. Target: all green.
- [ ] `gradlew assembleDebug` → `adb install -r` → Logcat clean boot.
- [ ] Manual: biometric unlock, directed UPI launch to a chosen package, live SMS
      capture appearing in the review queue.

---

## §3 — Deliberately not building

| Item | Why |
|---|---|
| AR overlays | You said no. Also solves nothing a static card does not. |
| Payment-gateway / merchant mode | You are not a merchant. Nothing to reconcile against. |
| Account Aggregator | Needs a licensed partner. Months of compliance for one user. |
| Accessibility-service scraping | Fragile, and reads every screen on the device. |
| Community fraud database | One user is not a community. |
| Split / household / trip modes | Build when a second person actually needs settling. |
| On-device ML classifier | Rules plus frequency counts will beat it until there are
  thousands of transactions. Revisit at year two. |

The spec listed ~115 features. Most are variations of six real ones: capture, classify,
route, warn, record, explain. Building 115 shallow features produces an app that is
worse at all six.

---

## §4 — Status

Phase 1 and 2 are being implemented now. Phase 3 follows. Phases 4–5 after that.
