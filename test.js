/* test.js — the one runnable check. `node test.js`
 * Pins down the money maths in core.js. If any of this fails, the ledger lies.
 */
import assert from 'node:assert/strict';
import {
  effects, balances, totals, debtOutstanding, goalProgress, budgetStatus,
  parseAmount, fmt, fmtCompact, nextDue, dueOccurrences, balanceHistory,
  monthKey, monthBounds, addMonths, lastMonths, categoryBreakdown, monthlyFlow,
} from './core.js';

let n = 0;
const test = (name, fn) => { fn(); n++; process.stdout.write(`  ✓ ${name}\n`); };

const R = (rupees) => Math.round(rupees * 100); // rupees → paise, for readability
const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

const accounts = [
  { id: 'cash',  name: 'Cash',      kind: 'spend',   opening: R(5000) },
  { id: 'bank',  name: 'Bank',      kind: 'spend',   opening: R(50000) },
  { id: 'emerg', name: 'Emergency', kind: 'savings', opening: R(100000) },
];

/* ── The core invariant: money is never created or destroyed by accident ──── */

test('transfer conserves total balance', () => {
  const txns = [{ id: '1', type: 'transfer', amount: R(2000), account: 'bank', to: 'cash', date: at(2026, 1, 5) }];
  const before = accounts.reduce((s, a) => s + a.opening, 0);
  const b = balances(accounts, txns);
  assert.equal([...b.values()].reduce((s, v) => s + v, 0), before);
  assert.equal(b.get('cash'), R(7000));
  assert.equal(b.get('bank'), R(48000));
});

test('save moves money from available into savings, total unchanged', () => {
  const txns = [{ id: '1', type: 'save', amount: R(10000), account: 'bank', to: 'emerg', date: at(2026, 1, 5) }];
  const t = totals(accounts, txns, []);
  assert.equal(t.total, R(155000));
  assert.equal(t.available, R(45000));   // 5000 cash + 40000 bank
  assert.equal(t.savings, R(110000));
});

test('withdraw is the exact inverse of save', () => {
  const save = [{ id: '1', type: 'save', amount: R(7500), account: 'bank', to: 'emerg', date: at(2026, 1, 5) }];
  const both = [...save, { id: '2', type: 'withdraw', amount: R(7500), account: 'emerg', to: 'bank', date: at(2026, 2, 5) }];
  const a = balances(accounts, []), b = balances(accounts, both);
  for (const k of a.keys()) assert.equal(a.get(k), b.get(k));
});

test('receive and spend move the needle the right way', () => {
  const txns = [
    { id: '1', type: 'receive', amount: R(80000), account: 'bank', date: at(2026, 1, 1) },
    { id: '2', type: 'spend', amount: R(450), account: 'cash', date: at(2026, 1, 2) },
  ];
  const b = balances(accounts, txns);
  assert.equal(b.get('bank'), R(130000));
  assert.equal(b.get('cash'), R(4550));
});

/* ── Borrowing & lending ──────────────────────────────────────────────────── */

test('lending removes cash and creates a receivable', () => {
  const debts = [{ id: 'd1', person: 'Ravi', direction: 'lent', principal: R(20000) }];
  const txns = [{ id: '1', type: 'lend', amount: R(20000), account: 'bank', debtId: 'd1', date: at(2026, 1, 3) }];
  const t = totals(accounts, txns, debts);
  assert.equal(t.balances.get('bank'), R(30000));
  assert.equal(t.owedToYou, R(20000));
  assert.equal(t.youOwe, 0);
  assert.equal(t.net, R(155000)); // net worth unchanged: cash became a receivable
});

test('borrowing adds cash and a matching liability', () => {
  const debts = [{ id: 'd2', person: 'Dad', direction: 'borrowed', principal: R(300000) }];
  const txns = [{ id: '1', type: 'borrow', amount: R(300000), account: 'bank', debtId: 'd2', date: at(2026, 1, 3) }];
  const t = totals(accounts, txns, debts);
  assert.equal(t.balances.get('bank'), R(350000));
  assert.equal(t.youOwe, R(300000));
  assert.equal(t.net, R(155000)); // borrowed money is not wealth
});

test('partial repayments whittle a debt down and settle at exactly zero', () => {
  const debt = { id: 'd1', person: 'Ravi', direction: 'lent', principal: R(20000) };
  const txns = [
    { id: '1', type: 'lend', amount: R(20000), account: 'bank', debtId: 'd1', date: at(2026, 1, 3) },
    { id: '2', type: 'repay', amount: R(7000), dir: 'in', account: 'cash', debtId: 'd1', date: at(2026, 2, 3) },
    { id: '3', type: 'repay', amount: R(13000), dir: 'in', account: 'cash', debtId: 'd1', date: at(2026, 3, 3) },
  ];
  assert.equal(debtOutstanding(debt, txns), 0);
  const t = totals(accounts, txns, [debt]);
  assert.equal(t.owedToYou, 0);
  assert.equal(t.balances.get('cash'), R(25000));
});

test('overpaying a debt cannot push it negative', () => {
  const debt = { id: 'd1', person: 'Ravi', direction: 'lent', principal: R(1000) };
  const txns = [{ id: '2', type: 'repay', amount: R(1500), dir: 'in', account: 'cash', debtId: 'd1', date: at(2026, 2, 3) }];
  assert.equal(debtOutstanding(debt, txns), 0);
});

test('repay direction decides which way the cash moves', () => {
  const out = effects({ type: 'repay', amount: R(500), account: 'cash', dir: 'out' });
  const inn = effects({ type: 'repay', amount: R(500), account: 'cash', dir: 'in' });
  assert.equal(out[0].delta, R(-500));
  assert.equal(inn[0].delta, R(500));
});

/* ── Scale: ₹5 chai and a ₹5 crore deal in the same ledger ────────────────── */

test('crore-scale amounts stay exact', () => {
  const big = [
    { id: '1', type: 'receive', amount: R(50000000), account: 'bank', date: at(2026, 1, 1) },
    { id: '2', type: 'spend', amount: R(5), account: 'cash', date: at(2026, 1, 1) },
  ];
  const b = balances(accounts, big);
  assert.equal(b.get('bank'), R(50050000));
  assert.equal(b.get('cash'), R(4995));
  assert.ok(Number.isSafeInteger(b.get('bank')));
});

test('a thousand ₹0.10 spends sum to exactly ₹100 (no float drift)', () => {
  const txns = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), type: 'spend', amount: 10, account: 'cash', date: at(2026, 1, 1) }));
  const b = balances(accounts, txns);
  assert.equal(b.get('cash'), R(5000) - R(100));
});

/* ── Parsing what a human actually types ──────────────────────────────────── */

test('parseAmount handles shorthand, symbols and separators', () => {
  const cases = [
    ['1200', R(1200)], ['1,200.50', R(1200.5)], ['₹ 350', R(350)],
    ['5k', R(5000)], ['1.5l', R(150000)], ['12 lakh', R(1200000)],
    ['2cr', R(20000000)], ['0.05', 5], ['', 0], ['abc', 0], ['.5', 50],
  ];
  for (const [input, want] of cases) assert.equal(parseAmount(input), want, `parseAmount(${JSON.stringify(input)})`);
});

test('parseAmount never yields a fractional paise', () => {
  for (const s of ['0.005', '1.999', '33.333', '0.1', '0.2']) assert.ok(Number.isInteger(parseAmount(s)), s);
});

test('formatting uses Indian digit grouping', () => {
  assert.equal(fmt(R(5000000), { symbol: '₹' }), '₹50,00,000');
  assert.equal(fmt(R(1234.5), { symbol: '₹' }), '₹1,234.50');
  assert.equal(fmt(R(1234), { symbol: '₹' }), '₹1,234');       // auto-hides .00
  assert.equal(fmt(R(-250), { symbol: '₹' }), '−₹250');
  assert.equal(fmt(R(250), { sign: true, symbol: '₹' }), '+₹250');
  assert.equal(fmtCompact(R(1520000), '₹'), '₹15.2L');
  assert.equal(fmtCompact(R(25000000), '₹'), '₹2.5Cr');
  assert.equal(fmtCompact(R(4500), '₹'), '₹4.5K');
  assert.equal(fmtCompact(R(99), '₹'), '₹99');
});

/* ── Budgets ──────────────────────────────────────────────────────────────── */

test('budget counts only spending, only in its month, only in its category', () => {
  const b = { id: 'b1', category: 'food', amount: R(8000) };
  const txns = [
    { id: '1', type: 'spend', amount: R(2000), category: 'food', date: at(2026, 3, 2) },
    { id: '2', type: 'spend', amount: R(1000), category: 'travel', date: at(2026, 3, 3) },  // wrong category
    { id: '3', type: 'spend', amount: R(9000), category: 'food', date: at(2026, 2, 3) },    // wrong month
    { id: '4', type: 'transfer', amount: R(5000), account: 'a', to: 'b', date: at(2026, 3, 4) }, // not spending
    { id: '5', type: 'spend', amount: R(3000), category: 'food', date: at(2026, 3, 20) },
  ];
  const s = budgetStatus(b, txns, '2026-03', at(2026, 3, 31));
  assert.equal(s.spent, R(5000));
  assert.equal(s.left, R(3000));
  assert.equal(s.state, 'ok');
});

test('budget flags close, over, and ahead-of-pace', () => {
  const b = { id: 'b1', category: null, amount: R(10000) };
  const mk = (amt, day) => [{ id: 'x', type: 'spend', amount: amt, date: at(2026, 3, day) }];
  assert.equal(budgetStatus(b, mk(R(9000), 20), '2026-03', at(2026, 3, 20)).state, 'close');
  assert.equal(budgetStatus(b, mk(R(11000), 20), '2026-03', at(2026, 3, 20)).state, 'over');
  assert.equal(budgetStatus(b, mk(R(5000), 5), '2026-03', at(2026, 3, 6)).state, 'fast');
  assert.equal(budgetStatus(b, mk(R(11000), 20), '2026-03', at(2026, 3, 20)).left, R(-1000));
});

/* ── Goals ────────────────────────────────────────────────────────────────── */

test('goal progress tracks saves minus withdrawals', () => {
  const g = { id: 'g1', name: 'Japan', target: R(200000) };
  const txns = [
    { id: '1', type: 'save', amount: R(50000), goalId: 'g1', account: 'bank', to: 'emerg', date: at(2026, 1, 1) },
    { id: '2', type: 'save', amount: R(30000), goalId: 'g1', account: 'bank', to: 'emerg', date: at(2026, 2, 1) },
    { id: '3', type: 'withdraw', amount: R(10000), goalId: 'g1', account: 'emerg', to: 'bank', date: at(2026, 2, 15) },
    { id: '4', type: 'save', amount: R(99999), goalId: 'other', account: 'bank', to: 'emerg', date: at(2026, 2, 1) },
  ];
  const p = goalProgress(g, txns, at(2026, 3, 1));
  assert.equal(p.saved, R(70000));
  assert.equal(p.remaining, R(130000));
  assert.equal(p.pct, 0.35);
  assert.equal(p.done, false);
});

test('goal with a deadline says how much per month', () => {
  const g = { id: 'g1', target: R(120000), deadline: at(2026, 7, 1) };
  const p = goalProgress(g, [], at(2026, 1, 1));
  assert.equal(p.monthsLeft, 6);
  assert.equal(p.perMonth, R(20000));
});

test('a completed goal reports done and caps at 100%', () => {
  const g = { id: 'g1', target: R(1000) };
  const txns = [{ id: '1', type: 'save', amount: R(1500), goalId: 'g1', account: 'a', to: 'b', date: at(2026, 1, 1) }];
  const p = goalProgress(g, txns, at(2026, 1, 2));
  assert.equal(p.done, true);
  assert.equal(p.pct, 1);
  assert.equal(p.remaining, 0);
});

/* ── Recurring ────────────────────────────────────────────────────────────── */

test('monthly recurrence clamps to the end of short months', () => {
  const jan31 = at(2026, 1, 31);
  const feb = nextDue({ freq: 'month', interval: 1, anchorDay: 31 }, jan31);
  const d = new Date(feb);
  assert.equal(d.getMonth(), 1);   // February
  assert.equal(d.getDate(), 28);   // not 3 March
  // ...and it recovers the 31st the next time a long month comes round
  const mar = nextDue({ freq: 'month', interval: 1, anchorDay: 31 }, feb);
  assert.equal(new Date(mar).getDate(), 31);
});

test('due occurrences catch up after the app was closed for months', () => {
  const rule = { freq: 'month', interval: 1, anchorDay: 1, nextAt: at(2026, 1, 1) };
  const { occurrences, nextAt } = dueOccurrences(rule, at(2026, 5, 15));
  assert.equal(occurrences.length, 5);           // Jan–May
  assert.ok(nextAt > at(2026, 5, 15));
  assert.equal(dueOccurrences({ ...rule, nextAt: at(2027, 1, 1) }, at(2026, 5, 15)).occurrences.length, 0);
});

/* ── Series feeding the charts ────────────────────────────────────────────── */

test('balance history is a running total, ignoring transfers', () => {
  const months = ['2026-01', '2026-02', '2026-03'];
  const txns = [
    { id: '0', type: 'receive', amount: R(1000), account: 'cash', date: at(2025, 12, 1) }, // before the window
    { id: '1', type: 'receive', amount: R(10000), account: 'cash', date: at(2026, 1, 10) },
    { id: '2', type: 'spend', amount: R(4000), account: 'cash', date: at(2026, 2, 10) },
    { id: '3', type: 'transfer', amount: R(9999), account: 'cash', to: 'bank', date: at(2026, 2, 11) },
  ];
  const base = R(155000) + R(1000);
  assert.deepEqual(balanceHistory(accounts, txns, months), [base + R(10000), base + R(6000), base + R(6000)]);
});

test('monthly flow separates income from spending', () => {
  const months = ['2026-01', '2026-02'];
  const txns = [
    { id: '1', type: 'receive', amount: R(60000), date: at(2026, 1, 5) },
    { id: '2', type: 'spend', amount: R(20000), date: at(2026, 1, 6) },
    { id: '3', type: 'save', amount: R(30000), date: at(2026, 1, 7) },  // not spending
    { id: '4', type: 'spend', amount: R(25000), date: at(2026, 2, 6) },
  ];
  const f = monthlyFlow(txns, months);
  assert.deepEqual(f.income, [R(60000), 0]);
  assert.deepEqual(f.spend, [R(20000), R(25000)]);
  assert.deepEqual(f.saved, [R(40000), R(-25000)]);
});

test('category breakdown ranks largest first and buckets the uncategorised', () => {
  const txns = [
    { id: '1', type: 'spend', amount: R(500), category: 'food', date: at(2026, 4, 1) },
    { id: '2', type: 'spend', amount: R(3000), category: 'rent', date: at(2026, 4, 2) },
    { id: '3', type: 'spend', amount: R(700), date: at(2026, 4, 3) },
    { id: '4', type: 'spend', amount: R(200), category: 'food', date: at(2026, 4, 4) },
  ];
  assert.deepEqual(categoryBreakdown(txns, '2026-04'), [
    { category: 'rent', amount: R(3000) },
    { category: 'food', amount: R(700) },
    { category: 'uncategorised', amount: R(700) },
  ]);
});

/* ── Calendar plumbing ────────────────────────────────────────────────────── */

test('month keys and arithmetic wrap across years', () => {
  assert.equal(monthKey(at(2026, 3, 15)), '2026-03');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-11', 3), '2027-02');
  assert.deepEqual(lastMonths(3, '2026-02'), ['2025-12', '2026-01', '2026-02']);
  const [s, e] = monthBounds('2026-02');
  assert.equal(new Date(s).getDate(), 1);
  assert.equal((e - s) / 86400000, 28);
});

console.log(`\n${n} checks passed — the ledger is honest.\n`);
