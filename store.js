/* store.js — application state, mutations, and everything that touches disk.
 *
 * The whole database lives in `S`. Mutations write through to IndexedDB and
 * then emit; screens subscribe and re-render. Nothing else in the app is
 * allowed to touch db.js directly, so there is exactly one place where the
 * ledger can change.
 */
import * as db from './db.js';
import { uid, dueOccurrences, monthKey, parseAmount } from './core.js';

export const S = {
  accounts: [], txns: [], debts: [], goals: [], budgets: [], categories: [], recurring: [],
  meta: {},
  ready: false,
};

/* ── Change notification ──────────────────────────────────────────────────── */
const subs = new Set();
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const emit = (reason = 'change') => { for (const fn of subs) fn(reason); };

/* ── Palette ──────────────────────────────────────────────────────────────── */
export const COLORS = ['#0A84FF', '#30D158', '#FF9F0A', '#FF453A', '#BF5AF2', '#64D2FF', '#FF375F', '#5E5CE6', '#FFD60A', '#AC8E68', '#66D4CF', '#8E8E93'];

const SEED_ACCOUNTS = [
  { name: 'Cash', kind: 'spend', icon: '👛', color: '#30D158' },
  { name: 'Bank', kind: 'spend', icon: '🏦', color: '#0A84FF' },
  { name: 'Savings', kind: 'savings', icon: '🛡️', color: '#5E5CE6' },
];

const SEED_CATEGORIES = [
  { name: 'Food', emoji: '🍜', color: '#FF9F0A', kind: 'spend' },
  { name: 'Transport', emoji: '🚕', color: '#64D2FF', kind: 'spend' },
  { name: 'Bills', emoji: '💡', color: '#FFD60A', kind: 'spend' },
  { name: 'Shopping', emoji: '🛍️', color: '#BF5AF2', kind: 'spend' },
  { name: 'Health', emoji: '💊', color: '#FF453A', kind: 'spend' },
  { name: 'Home', emoji: '🏠', color: '#AC8E68', kind: 'spend' },
  { name: 'Fun', emoji: '🎬', color: '#FF375F', kind: 'spend' },
  { name: 'Family', emoji: '🧡', color: '#FF8A65', kind: 'spend' },
  { name: 'Salary', emoji: '💼', color: '#30D158', kind: 'receive' },
  { name: 'Business', emoji: '📈', color: '#66D4CF', kind: 'receive' },
  { name: 'Gift', emoji: '🎁', color: '#BF5AF2', kind: 'receive' },
];

/* ── Boot ─────────────────────────────────────────────────────────────────── */

export async function load() {
  const data = await db.loadAll();
  Object.assign(S, data);
  S.meta.currency ??= '₹';
  if (!S.accounts.length && !S.meta.onboarded) await seed();
  S.accounts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sortTxns();
  await runRecurring();
  S.ready = true;
  emit('load');
}

async function seed() {
  const now = Date.now();
  S.accounts = SEED_ACCOUNTS.map((a, i) => ({ ...a, id: uid(), opening: 0, order: i, createdAt: now }));
  S.categories = SEED_CATEGORIES.map((c, i) => ({ ...c, id: uid(), order: i }));
  await db.putMany('accounts', S.accounts);
  await db.putMany('categories', S.categories);
}

/** Newest first — every list in the app reads in this order. */
const sortTxns = () => S.txns.sort((a, b) => b.date - a.date || b.createdAt - a.createdAt);

/* ── Lookups ──────────────────────────────────────────────────────────────── */
export const account = (id) => S.accounts.find((a) => a.id === id);
export const category = (id) => S.categories.find((c) => c.id === id);
export const goal = (id) => S.goals.find((g) => g.id === id);
export const debt = (id) => S.debts.find((d) => d.id === id);
export const liveAccounts = () => S.accounts.filter((a) => !a.archived);
export const spendAccounts = () => liveAccounts().filter((a) => a.kind === 'spend');
export const savingsAccounts = () => liveAccounts().filter((a) => a.kind === 'savings');

/** Remembers the last account/category used per action, so the sheet opens
 *  pre-filled and most entries are just "amount, save". */
export function lastUsed(type) {
  const t = S.txns.find((x) => x.type === type);
  return t ? { account: t.account, to: t.to, category: t.category } : {};
}

/** Categories ordered by how often you actually use them, not alphabetically. */
export function rankedCategories(kind) {
  const freq = new Map();
  const cutoff = Date.now() - 180 * 86400000;
  for (const t of S.txns) {
    if (!t.category || t.date < cutoff) continue;
    freq.set(t.category, (freq.get(t.category) || 0) + 1);
  }
  return S.categories.filter((c) => c.kind === kind).sort((a, b) => (freq.get(b.id) || 0) - (freq.get(a.id) || 0));
}

/* ── Transactions ─────────────────────────────────────────────────────────── */

export async function addTxn(t) {
  const rec = { id: uid(), createdAt: Date.now(), date: Date.now(), ...t };
  S.txns.push(rec);
  sortTxns();
  await db.put('txns', rec);
  emit('txn');
  return rec;
}

export async function updateTxn(id, patch) {
  const t = S.txns.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  sortTxns();
  await db.put('txns', t);
  emit('txn');
}

/** Deleting a lend/borrow must take its debt with it, or the Owed totals
 *  would keep counting a debt whose money movement no longer exists. */
export async function deleteTxn(id) {
  const i = S.txns.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [t] = S.txns.splice(i, 1);
  const removed = { txn: t, debt: null, repayments: [] };
  await db.del('txns', id);

  if ((t.type === 'lend' || t.type === 'borrow' || t.type === 'receivable') && t.debtId) {
    const di = S.debts.findIndex((d) => d.id === t.debtId);
    if (di >= 0) {
      removed.debt = S.debts.splice(di, 1)[0];
      await db.del('debts', removed.debt.id);
      // Repayments against a debt that no longer exists are orphans; take them too.
      removed.repayments = S.txns.filter((x) => x.debtId === t.debtId);
      S.txns = S.txns.filter((x) => x.debtId !== t.debtId);
      await db.delMany('txns', removed.repayments.map((r) => r.id));
    }
  }
  emit('txn');
  return removed;
}

/** Puts back exactly what deleteTxn removed — the undo toast depends on this. */
export async function restoreTxn(removed) {
  if (!removed) return;
  S.txns.push(removed.txn, ...removed.repayments);
  sortTxns();
  await db.putMany('txns', [removed.txn, ...removed.repayments]);
  if (removed.debt) { S.debts.push(removed.debt); await db.put('debts', removed.debt); }
  emit('txn');
}

/* ── Debts ────────────────────────────────────────────────────────────────── */

/** Lending and borrowing create the money movement and the obligation together,
 *  so the two can never drift apart. */
export async function addDebt({ person, direction, amount, account: acc, note, dueDate, date }) {
  const d = { id: uid(), person: person.trim(), direction, principal: amount, note: note || '', dueDate: dueDate || null, createdAt: Date.now(), date: date || Date.now() };
  S.debts.push(d);
  await db.put('debts', d);
  const txnType = direction === 'lent' ? 'lend' : direction === 'receivable' ? 'receivable' : 'borrow';
  await addTxn({ type: txnType, amount, account: acc, debtId: d.id, person: d.person, note, date: date || Date.now() });
  return d;
}

export async function repay({ debtId, amount, account: acc, note, date }) {
  const d = debt(debtId);
  if (!d) return;
  const dir = (d.direction === 'lent' || d.direction === 'receivable') ? 'in' : 'out';
  return addTxn({ type: 'repay', amount, account: acc, debtId, dir, person: d.person, note, date: date || Date.now() });
}

export async function updateDebt(id, patch) {
  const d = debt(id);
  if (!d) return;
  Object.assign(d, patch);
  await db.put('debts', d);
  emit('debt');
}

/* ── Generic record helpers (accounts, goals, budgets, categories) ─────────── */

const collection = { accounts: 'accounts', goals: 'goals', budgets: 'budgets', categories: 'categories' };

export async function save(store, obj) {
  const list = S[collection[store]];
  const existing = obj.id && list.find((x) => x.id === obj.id);
  if (existing) Object.assign(existing, obj);
  else { obj = { id: uid(), createdAt: Date.now(), ...obj }; list.push(obj); }
  await db.put(store, existing || obj);
  emit(store);
  return existing || obj;
}

export async function remove(store, id) {
  const key = collection[store];
  S[key] = S[key].filter((x) => x.id !== id);
  await db.del(store, id);
  emit(store);
}

/** Accounts hold history, so they are archived rather than deleted unless
 *  they're empty. Deleting one with transactions would silently rewrite
 *  past months' totals. */
export function accountInUse(id) {
  return S.txns.some((t) => t.account === id || t.to === id) || S.goals.some((g) => g.accountId === id);
}

export async function reorderAccounts(ids) {
  ids.forEach((id, i) => { const a = account(id); if (a) a.order = i; });
  S.accounts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  await db.putMany('accounts', S.accounts);
  emit('accounts');
}

/* ── Recurring ────────────────────────────────────────────────────────────────
 * Rent, salary, EMI, subscriptions. Over five years these are the difference
 * between an app you keep using and one you abandon in March.
 */

export async function addRecurring(rule) {
  const r = { id: uid(), createdAt: Date.now(), ...rule };
  S.recurring.push(r);
  await db.put('recurring', r);
  emit('recurring');
  return r;
}

export async function removeRecurring(id) {
  S.recurring = S.recurring.filter((r) => r.id !== id);
  await db.del('recurring', id);
  emit('recurring');
}

/** Called at every boot: creates any scheduled transactions that came due while
 *  the app was closed, then advances each rule to its next date. */
export async function runRecurring(now = Date.now()) {
  const created = [];
  for (const r of S.recurring) {
    if (r.paused) continue;
    const { occurrences, nextAt } = dueOccurrences(r, now);
    if (!occurrences.length) continue;
    for (const at of occurrences) {
      const t = { id: uid(), createdAt: Date.now(), ...r.template, date: at, recurringId: r.id };
      S.txns.push(t);
      created.push(t);
    }
    r.nextAt = nextAt;
    r.lastRun = now;
    await db.put('recurring', r);
  }
  if (created.length) {
    sortTxns();
    await db.putMany('txns', created);
    S.meta.pendingRecurring = created.length;
  }
  return created;
}

/* ── Settings ─────────────────────────────────────────────────────────────── */

export async function setMeta(k, v) {
  S.meta[k] = v;
  await db.setMeta(k, v);
  emit('meta');
}

/* ── Backup ────────────────────────────────────────────────────────────────── */

export function exportData() {
  return {
    format: 'fin.backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: { accounts: S.accounts.length, txns: S.txns.length, debts: S.debts.length, goals: S.goals.length, budgets: S.budgets.length },
    accounts: S.accounts, txns: S.txns, debts: S.debts, goals: S.goals,
    budgets: S.budgets, categories: S.categories, recurring: S.recurring, meta: S.meta,
  };
}

/** Validates before it destroys anything. A backup file that is subtly wrong
 *  must fail loudly rather than half-replace five years of records. */
export async function importData(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  if (d?.format !== 'fin.backup') throw new Error('Not a Fin backup file.');
  for (const k of ['accounts', 'txns']) {
    if (!Array.isArray(d[k])) throw new Error(`Backup is missing its ${k}.`);
  }
  const bad = d.txns.find((t) => typeof t.amount !== 'number' || !Number.isFinite(t.amount) || !t.type);
  if (bad) throw new Error('Backup contains a damaged transaction.');

  const clean = {
    accounts: d.accounts, txns: d.txns, debts: d.debts || [], goals: d.goals || [],
    budgets: d.budgets || [], categories: d.categories?.length ? d.categories : S.categories,
    recurring: d.recurring || [], meta: { ...d.meta, lastBackupAt: S.meta.lastBackupAt },
  };
  await db.replaceAll(clean);
  Object.assign(S, clean);
  S.accounts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sortTxns();
  emit('import');
  return clean.txns.length;
}

/** Merges a CSV of simple spends/receives. Useful for a first-time import from
 *  a spreadsheet: date, type, amount, account, category, note */
export async function importCSV(text) {
  const rows = text.trim().split(/\r?\n/);
  const head = rows.shift().split(',').map((s) => s.trim().toLowerCase());
  const col = (r, name) => r[head.indexOf(name)]?.trim() ?? '';
  const fallback = spendAccounts()[0] || liveAccounts()[0];
  if (!fallback) throw new Error('Create an account first.');
  const made = [];
  for (const line of rows) {
    if (!line.trim()) continue;
    const r = line.split(',');
    const amount = parseAmount(col(r, 'amount'));
    if (!amount) continue;
    const type = /rec|income|credit|in/i.test(col(r, 'type')) ? 'receive' : 'spend';
    const accName = col(r, 'account').toLowerCase();
    const acc = liveAccounts().find((a) => a.name.toLowerCase() === accName) || fallback;
    const catName = col(r, 'category').toLowerCase();
    const cat = S.categories.find((c) => c.name.toLowerCase() === catName);
    const when = Date.parse(col(r, 'date'));
    made.push({ id: uid(), createdAt: Date.now(), type, amount, account: acc.id, category: cat?.id, note: col(r, 'note'), date: isNaN(when) ? Date.now() : when });
  }
  S.txns.push(...made);
  sortTxns();
  await db.putMany('txns', made);
  emit('import');
  return made.length;
}

/** Days since the last export. Drives the gentle backup nudge. */
export function daysSinceBackup() {
  if (!S.meta.lastBackupAt) return S.txns.length > 12 ? 999 : 0;
  return Math.floor((Date.now() - S.meta.lastBackupAt) / 86400000);
}

export const thisMonth = () => monthKey(Date.now());
