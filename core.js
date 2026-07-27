/* core.js — pure money math. No DOM, no storage, no side effects.
 *
 * RULE: every amount in this app is an INTEGER number of PAISE (1 rupee = 100 paise).
 * Floats are never used for money. ₹5 crore = 5e9 paise, comfortably inside
 * Number.MAX_SAFE_INTEGER (9e15), so integer arithmetic stays exact at any scale
 * this app will ever see.
 *
 * RULE: balances are NEVER stored. They are derived from the transaction log via
 * effects(). That makes "edited a transaction but forgot to fix the balance"
 * structurally impossible.
 */

/* Coerce to a whole number of paise.
 * NOT `x | 0` — bitwise operators truncate to 32 bits and wrap at ₹21,47,483.65,
 * which would silently corrupt any large deal. Math.trunc has no such ceiling. */
const int = (v) => Math.trunc(v) || 0;

/* ── Transaction vocabulary ──────────────────────────────────────────────────
 * Eight verbs, and that is the whole language. Anything the app can do to money
 * is one of these.
 */
export const TYPES = {
  receive:  { label: 'Receive',  verb: 'Received',  dir: 'in',   tone: 'in',    icon: 'arrow-down',  hint: 'Salary, gift, refund' },
  spend:    { label: 'Spend',    verb: 'Spent',     dir: 'out',  tone: 'out',   icon: 'arrow-up',    hint: 'Anything you paid for' },
  transfer: { label: 'Transfer', verb: 'Moved',     dir: 'move', tone: 'move',  icon: 'arrows',      hint: 'Between your accounts' },
  save:     { label: 'Save',     verb: 'Saved',     dir: 'move', tone: 'save',  icon: 'shield',      hint: 'Set money aside' },
  withdraw: { label: 'Withdraw', verb: 'Withdrew',  dir: 'move', tone: 'move',  icon: 'shield-off',  hint: 'Take back from savings' },
  borrow:   { label: 'Borrow',   verb: 'Borrowed',  dir: 'in',   tone: 'owe',   icon: 'hand-in',     hint: 'You took money from someone' },
  lend:     { label: 'Lend',     verb: 'Lent',      dir: 'out',  tone: 'due',   icon: 'hand-out',    hint: 'You gave money to someone' },
  repay:    { label: 'Repay',    verb: 'Repaid',    dir: 'both', tone: 'settle',icon: 'check',       hint: 'Settle a debt, fully or partly' },
};

/* The single source of truth for what a transaction does to account balances.
 * Returns [{ account, delta }] in paise. Everything else in the app — every
 * total, chart, ring and stat — is downstream of this one function. */
export function effects(t) {
  const a = int(t.amount);
  switch (t.type) {
    case 'receive':
    case 'borrow':
      return [{ account: t.account, delta: a }];
    case 'spend':
    case 'lend':
      return [{ account: t.account, delta: -a }];
    case 'transfer':
    case 'save':
    case 'withdraw':
      // Money leaves `account` and lands in `to`. Net effect on net worth: zero.
      return [{ account: t.account, delta: -a }, { account: t.to, delta: a }];
    case 'repay':
      // dir 'in'  = someone repaid you   → money arrives
      // dir 'out' = you repaid someone   → money leaves
      return [{ account: t.account, delta: t.dir === 'in' ? a : -a }];
    default:
      return [];
  }
}

/* True when the transaction changes net worth (as opposed to just relocating
 * money). Transfers/saves/withdrawals move money without creating or destroying
 * any, so they must be excluded from income-vs-spending maths. */
export const isNetChange = (t) => t.type !== 'transfer' && t.type !== 'save' && t.type !== 'withdraw';

/* ── Balances ─────────────────────────────────────────────────────────────── */

/** @returns {Map<string, number>} accountId → balance in paise */
export function balances(accounts, txns) {
  const m = new Map(accounts.map((a) => [a.id, int(a.opening)]));
  for (const t of txns) {
    for (const e of effects(t)) {
      if (m.has(e.account)) m.set(e.account, m.get(e.account) + e.delta);
    }
  }
  return m;
}

/** The six numbers the Home screen exists to answer. */
export function totals(accounts, txns, debts) {
  const bal = balances(accounts, txns);
  let total = 0, available = 0, savings = 0;
  for (const a of accounts) {
    if (a.archived) continue;
    const b = bal.get(a.id) || 0;
    total += b;
    if (a.kind === 'savings') savings += b; else available += b;
  }
  let owedToYou = 0, youOwe = 0;
  for (const d of debts) {
    const out = debtOutstanding(d, txns);
    if (out <= 0) continue;
    if (d.direction === 'lent') owedToYou += out; else youOwe += out;
  }
  // Net worth counts what you're owed as an asset and what you owe as a liability.
  return { total, available, savings, owedToYou, youOwe, net: total + owedToYou - youOwe, balances: bal };
}

/* ── Debts (borrowing & lending) ──────────────────────────────────────────── */

/** Remaining balance on one debt, after all partial repayments. */
export function debtOutstanding(debt, txns) {
  let paid = 0;
  for (const t of txns) if (t.type === 'repay' && t.debtId === debt.id) paid += t.amount;
  return Math.max(0, int(debt.principal) - paid);
}

/** Roll debts up per person so the UI can show "Ravi owes you ₹12,000" in one row. */
export function debtsByPerson(debts, txns) {
  const map = new Map();
  for (const d of debts) {
    const out = debtOutstanding(d, txns);
    const key = d.person.trim().toLowerCase() + '|' + d.direction;
    if (!map.has(key)) map.set(key, { person: d.person.trim(), direction: d.direction, outstanding: 0, principal: 0, items: [] });
    const g = map.get(key);
    g.outstanding += out;
    g.principal += int(d.principal);
    g.items.push({ ...d, outstanding: out });
  }
  return [...map.values()]
    .filter((g) => g.outstanding > 0 || g.items.some((i) => !i.settledAt))
    .sort((a, b) => b.outstanding - a.outstanding);
}

/* ── Goals ────────────────────────────────────────────────────────────────── */

/** Money currently parked against a goal = saves in, withdrawals out. */
export function goalSaved(goal, txns) {
  let v = 0;
  for (const t of txns) {
    if (t.goalId !== goal.id) continue;
    if (t.type === 'save') v += t.amount;
    else if (t.type === 'withdraw') v -= t.amount;
  }
  return Math.max(0, v);
}

/** Progress + the "what do I need to put away each month" answer. */
export function goalProgress(goal, txns, now = Date.now()) {
  const saved = goalSaved(goal, txns);
  const target = int(goal.target);
  const pct = target > 0 ? Math.min(1, saved / target) : 0;
  const remaining = Math.max(0, target - saved);
  let perMonth = null, monthsLeft = null, overdue = false;
  if (goal.deadline && remaining > 0) {
    monthsLeft = monthsBetween(now, goal.deadline);
    overdue = goal.deadline < now;
    perMonth = monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining;
  }
  return { saved, target, pct, remaining, perMonth, monthsLeft, overdue, done: target > 0 && saved >= target };
}

/* ── Budgets ──────────────────────────────────────────────────────────────── */

/** Spending charged against a budget for one calendar month.
 *  A budget with category === null is an overall cap on all spending. */
export function budgetSpent(budget, txns, mKey) {
  let v = 0;
  for (const t of txns) {
    if (t.type !== 'spend') continue;
    if (monthKey(t.date) !== mKey) continue;
    if (budget.category && t.category !== budget.category) continue;
    v += t.amount;
  }
  return v;
}

export function budgetStatus(budget, txns, mKey, now = Date.now()) {
  const spent = budgetSpent(budget, txns, mKey);
  const limit = int(budget.amount);
  const pct = limit > 0 ? spent / limit : 0;
  const left = limit - spent;
  const [start, end] = monthBounds(mKey);
  const span = end - start;
  // How far through the month we are — used to say "you're ahead/behind pace".
  const elapsed = Math.min(1, Math.max(0, (now - start) / span));
  const pace = elapsed > 0 ? pct / elapsed : 0;
  const state = pct >= 1 ? 'over' : pct >= 0.85 ? 'close' : pace > 1.15 && elapsed > 0.15 ? 'fast' : 'ok';
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
  return { spent, limit, left, pct, state, daysLeft, perDay: daysLeft > 0 ? Math.max(0, Math.floor(left / daysLeft)) : 0 };
}

/* ── Time ─────────────────────────────────────────────────────────────────── */
/* All date maths is LOCAL time — a wallet lives where its owner does. */

const p2 = (n) => String(n).padStart(2, '0');
export const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export const monthKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; };

export function monthBounds(mKey) {
  const [y, m] = mKey.split('-').map(Number);
  return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
}

export function addMonths(mKey, n) {
  const [y, m] = mKey.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

export function monthsBetween(a, b) {
  const x = new Date(a), y = new Date(b);
  return Math.max(0, (y.getFullYear() - x.getFullYear()) * 12 + (y.getMonth() - x.getMonth()) + (y.getDate() >= x.getDate() ? 0 : -1));
}

/** Last N month keys ending at (and including) `mKey`. */
export function lastMonths(n, mKey) {
  return Array.from({ length: n }, (_, i) => addMonths(mKey, i - n + 1));
}

/* ── Recurring transactions ───────────────────────────────────────────────────
 * Rent and salary shouldn't cost 60 manual entries over five years.
 */
export function nextDue(rule, from) {
  const d = new Date(from);
  const n = Math.max(1, rule.interval || 1);
  switch (rule.freq) {
    case 'day':   d.setDate(d.getDate() + n); break;
    case 'week':  d.setDate(d.getDate() + 7 * n); break;
    case 'year':  d.setFullYear(d.getFullYear() + n); break;
    case 'month':
    default: {
      // Clamp to the end of the target month: 31 Jan + 1 month = 28 Feb, not 3 Mar.
      const day = rule.anchorDay || d.getDate();
      const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(day, lastDay));
      target.setHours(d.getHours(), d.getMinutes(), 0, 0);
      return target.getTime();
    }
  }
  return d.getTime();
}

/** Every occurrence of a rule that has come due but not yet been created. */
export function dueOccurrences(rule, now = Date.now(), cap = 60) {
  const out = [];
  let t = rule.nextAt;
  while (t <= now && out.length < cap) {
    out.push(t);
    t = nextDue(rule, t);
  }
  return { occurrences: out, nextAt: t };
}

/* ── Formatting ───────────────────────────────────────────────────────────── */

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Full precision, Indian digit grouping: 5000000000 → "5,00,00,000" */
export function fmt(paise, { sign = false, decimals = 'auto', symbol = '' } = {}) {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = abs / 100;
  const whole = abs % 100 === 0;
  const body = decimals === 'never' || (decimals === 'auto' && whole) ? inr0.format(Math.round(rupees)) : inr.format(rupees);
  const s = sign ? (neg ? '−' : '+') : neg ? '−' : '';
  return s + symbol + body;
}

/** Tight spaces: 152300000 → "₹15.2L". Indian units, because ₹1.5M means nothing here. */
export function fmtCompact(paise, symbol = '') {
  const neg = paise < 0;
  const r = Math.abs(paise) / 100;
  const trim = (n, d) => Number(n.toFixed(d)).toString();
  let body;
  if (r >= 1e7) body = trim(r / 1e7, r / 1e7 >= 100 ? 0 : 2) + 'Cr';
  else if (r >= 1e5) body = trim(r / 1e5, r / 1e5 >= 100 ? 0 : 2) + 'L';
  else if (r >= 1000) body = trim(r / 1000, r / 1000 >= 100 ? 0 : 1) + 'K';
  else body = inr0.format(Math.round(r));
  return (neg ? '−' : '') + symbol + body;
}

/** Parse what a human types. Accepts "1,200.50", "5k", "1.5l", "2cr", "12 lakh". */
export function parseAmount(str) {
  if (typeof str === 'number') return Math.round(str * 100);
  let s = String(str).toLowerCase().replace(/[,\s₹]/g, '').trim();
  if (!s) return 0;
  let mult = 1;
  const m = s.match(/^(-?[\d.]+)(k|thousand|l|lac|lakh|lakhs|cr|crore|crores)?$/);
  if (!m) return 0;
  const unit = m[2];
  if (unit) {
    if (unit[0] === 'k' || unit === 'thousand') mult = 1e3;
    else if (unit[0] === 'l') mult = 1e5;
    else mult = 1e7;
  }
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return 0;
  // Round at the paise boundary so 0.1 + 0.2 style drift can never enter the ledger.
  return Math.round(n * mult * 100);
}

export function relativeDay(ts, now = Date.now()) {
  const a = dayKey(ts), b = dayKey(now);
  if (a === b) return 'Today';
  if (a === dayKey(now - 86400000)) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

export const monthLabel = (mKey, long = false) => {
  const [y, m] = mKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: long ? 'long' : 'short', year: 'numeric' });
};

/* ── Insight series ───────────────────────────────────────────────────────── */

/** Income vs spending per month — the only two lines that matter. */
export function monthlyFlow(txns, months) {
  const idx = new Map(months.map((m, i) => [m, i]));
  const income = new Array(months.length).fill(0);
  const spend = new Array(months.length).fill(0);
  for (const t of txns) {
    const i = idx.get(monthKey(t.date));
    if (i === undefined) continue;
    if (t.type === 'receive') income[i] += t.amount;
    else if (t.type === 'spend') spend[i] += t.amount;
  }
  return { months, income, spend, saved: income.map((v, i) => v - spend[i]) };
}

/** Running total held across all accounts at the end of each month.
 *  One pass over the ledger, then a prefix sum — not months × transactions. */
export function balanceHistory(accounts, txns, months) {
  const idx = new Map(months.map((m, i) => [m, i]));
  const [firstStart] = monthBounds(months[0]);
  const delta = new Array(months.length).fill(0);
  let running = accounts.reduce((s, a) => s + int(a.opening), 0);
  for (const t of txns) {
    let net = 0;
    for (const e of effects(t)) net += e.delta; // transfers net to zero, as they should
    if (!net) continue;
    if (t.date < firstStart) running += net;
    else { const i = idx.get(monthKey(t.date)); if (i !== undefined) delta[i] += net; }
  }
  return delta.map((d) => (running += d));
}

/** Spending grouped by category for a month, largest first. */
export function categoryBreakdown(txns, mKey) {
  const m = new Map();
  for (const t of txns) {
    if (t.type !== 'spend' || monthKey(t.date) !== mKey) continue;
    const k = t.category || 'uncategorised';
    m.set(k, (m.get(k) || 0) + t.amount);
  }
  return [...m.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
