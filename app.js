/* app.js — router, the five screens, and boot.
 *
 * Rendering is deliberately simple: state changes, the active screen redraws
 * from scratch. With everything already in memory that costs under a
 * millisecond, and it removes any chance of the UI disagreeing with the ledger.
 */
import * as St from './store.js';
import { S } from './store.js';
import {
  el, $, $$, esc, icon, haptic, toast, openSheet, pickSheet, confirmSheet,
  $$$, $c, animateNumber, stagger, swipeable, closeSwipes, longPress,
  anySheetOpen, closeTopSheet, reduceMotion,
} from './ui.js';
import {
  TYPES, totals, balances, monthKey, monthLabel, lastMonths, addMonths, relativeDay,
  budgetStatus, goalProgress, debtsByPerson, debtOutstanding, categoryBreakdown,
  monthlyFlow, balanceHistory, monthBounds, effects, isNetChange, fmt,
  safeToSpend, financialHealth, recurringRadar,
} from './core.js';
import { areaChart, hydrateArea, pairedBars, ring, donut, stackBar, sparkline } from './charts.js';
import * as Native from './native.js';
import * as Ai from './ai.js';
import {
  openActions, openComposer, openAccountEditor, openBudgetEditor, openGoalEditor,
  openCategoryEditor, openTxnDetail, openDebtDetail, openOnboarding, deleteWithUndo,
  openDatePicker, openUpiScanner, openAiCopilot, openAiSettings, openNotificationReview, openAutomationSettings,
} from './sheets.js';

const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'accounts', label: 'Accounts', icon: 'wallet' },
  { id: 'activity', label: 'Activity', icon: 'list' },
  { id: 'budgets', label: 'Budgets', icon: 'rings' },
  { id: 'goals', label: 'Goals', icon: 'flag' },
];

const view = { name: 'home', param: null, month: monthKey(Date.now()), filter: 'all', query: '', limit: 60 };
const scrollMemory = new Map();

/* ── Router ───────────────────────────────────────────────────────────────── */

function go(name, param = null, { replace = false, back = false } = {}) {
  if (view.name === name && view.param === param) return;
  scrollMemory.set(routeKey(), $('#app').scrollTop);
  const fromIndex = TABS.findIndex((t) => t.id === view.name);
  const toIndex = TABS.findIndex((t) => t.id === name);
  const dir = back ? -1 : toIndex >= 0 && fromIndex >= 0 ? Math.sign(toIndex - fromIndex) : 1;
  view.name = name; view.param = param; view.limit = 60;
  if (!replace) history.pushState({ name, param }, '', '');
  render(dir);
}

const routeKey = () => view.name + ':' + (view.param || '');

addEventListener('popstate', () => {
  if (anySheetOpen()) { closeTopSheet(); history.pushState({}, '', ''); return; }
  const stackDepth = history.state?.name;
  if (view.name !== 'home') { view.name = stackDepth || 'home'; view.param = history.state?.param || null; render(-1); }
});

/* ── Render ───────────────────────────────────────────────────────────────── */

/* Coalesce a burst of mutations into a single paint.
 * Deliberately a microtask rather than requestAnimationFrame: rAF is throttled
 * whenever the page is not compositing (background tab, hidden window, restored
 * from bfcache), which would leave the UI showing stale figures until the next
 * frame happened to arrive. A microtask always runs. */
let scheduled = false, pendingDir = 0;
function render(dir = 0) {
  pendingDir = dir;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const d = pendingDir; pendingDir = 0;
    try { paint(d); }
    catch (err) { paintCrash(err); }
  });
}

function paint(dir) {
  const app = $('#app');
  const html = {
    home: Home, accounts: Accounts, activity: Activity, budgets: Budgets,
    goals: Goals, insights: Insights, settings: Settings, account: AccountDetail,
  }[view.name]?.() ?? Home();

  app.innerHTML = html;
  app.classList.remove('slide-l', 'slide-r');
  if (dir && !reduceMotion()) app.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
  app.scrollTop = scrollMemory.get(routeKey()) || 0;
  bind(app);
  paintTabs();
}

/* If a screen ever fails to draw, the one thing that must still work is
 * getting the data out. A blank screen with no escape is the worst possible
 * outcome for something holding five years of records. */
function paintCrash(err) {
  console.error('[fin] render failed', err);
  const app = $('#app');
  app.innerHTML = `${header('Something went wrong')}
    <div class="card pad-card">
      <p class="hint">A screen failed to draw. Your records are safe — they live in this device's
      database and were not touched. Save a backup before anything else.</p>
      <p class="hint" style="opacity:.6;margin-top:8px">${esc(String(err && err.message || err))}</p>
      <button class="btn btn-primary full" data-backup>Export a backup</button>
      <button class="btn btn-ghost full" onclick="location.reload()">Reload</button>
    </div>`;
  // Falling back to Home gives the next render a route that is known to work.
  view.name = 'home'; view.param = null;
}

function paintTabs() {
  const bar = $('#tabbar');
  const idx = TABS.findIndex((t) => t.id === view.name);
  bar.classList.toggle('hidden', idx < 0 && view.name !== 'home');
  $$('.tab', bar).forEach((b, i) => b.classList.toggle('on', i === idx));
  bar.style.setProperty('--i', idx < 0 ? -1 : idx);
}

/* ── Shared fragments ─────────────────────────────────────────────────────── */

const state = () => {
  const t = totals(St.liveAccounts(), S.txns, S.debts);
  return t;
};

function header(title, { sub = '', back = null, action = '' } = {}) {
  return `<header class="topbar">
    ${back ? `<button class="icon-btn" data-back>${icon('back')}</button>` : ''}
    <div class="topbar-titles"><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    <div class="topbar-actions">${action}</div>
  </header>`;
}

/** One transaction row. Used on Home, Activity, and account detail. */
function txnRow(t, { showAccount = true } = {}) {
  const meta = TYPES[t.type];
  const cat = St.category(t.category);
  const acc = St.account(t.account), to = St.account(t.to);
  const sign = meta.dir === 'in' || (t.type === 'repay' && t.dir === 'in') ? '+' : meta.dir === 'out' || (t.type === 'repay' && t.dir === 'out') ? '−' : '';
  const tone = sign === '+' ? 'good' : sign === '−' ? '' : 'move';
  const face = cat ? cat.emoji : t.person ? '👤' : acc?.icon || '•';
  const title = t.note || cat?.name || t.person || meta.verb;
  const where = t.type === 'transfer' || t.type === 'save' || t.type === 'withdraw'
    ? `${esc(acc?.name || '?')} → ${esc(to?.name || '?')}`
    : showAccount ? esc(acc?.name || '') : esc(meta.verb);

  // The row and its actions sit side by side in one track that is wider than
  // the row; the row clips. Sliding the track reveals the buttons. They are
  // never stacked behind the row, so they cannot bleed through it.
  return `<div class="swipe-row" data-id="${t.id}">
    <div class="swipe-track">
      <button class="row swipe-surface row-tap">
        <span class="row-face tone-${meta.tone}" style="${cat ? `--c:${cat.color}` : acc ? `--c:${acc.color}` : ''}">${esc(face)}</span>
        <span class="row-main">
          <b>${esc(title)}</b>
          <small>${where}${t.recurringId ? ' · repeats' : ''}</small>
        </span>
        <span class="row-amt ${tone}">${sign}${esc($$$(t.amount))}</span>
      </button>
      <div class="swipe-actions">
        <button class="swipe-edit" aria-label="Edit">${icon('edit')}</button>
        <button class="swipe-del" aria-label="Delete">${icon('trash')}</button>
      </div>
    </div>
  </div>`;
}

/** Transactions grouped under day headings. */
function txnGroups(list, opts = {}) {
  if (!list.length) return '';
  let out = '', lastDay = '';
  for (const t of list) {
    const d = relativeDay(t.date);
    if (d !== lastDay) {
      lastDay = d;
      const dayTotal = list.filter((x) => relativeDay(x.date) === d && isNetChange(x))
        .reduce((s, x) => s + (TYPES[x.type].dir === 'in' || (x.type === 'repay' && x.dir === 'in') ? x.amount : -x.amount), 0);
      out += `<div class="day-head"><span>${esc(d)}</span>${dayTotal ? `<b class="${dayTotal > 0 ? 'good' : ''}">${esc(fmt(dayTotal, { sign: true, symbol: S.meta.currency || '₹' }))}</b>` : ''}</div>`;
    }
    out += txnRow(t, opts);
  }
  return out;
}

const empty = (ico, title, sub, cta = '') => `<div class="empty">
  <span class="empty-ico">${icon(ico)}</span><h3>${esc(title)}</h3><p>${esc(sub)}</p>${cta}</div>`;

/* ── Home ─────────────────────────────────────────────────────────────────── */

function Home() {
  const t = state();
  const now = Date.now();
  const m = monthKey(now);
  const [mStart] = monthBounds(m);
  const monthTxns = S.txns.filter((x) => x.date >= mStart);
  const inM = monthTxns.filter((x) => x.type === 'receive').reduce((s, x) => s + x.amount, 0);
  const outM = monthTxns.filter((x) => x.type === 'spend').reduce((s, x) => s + x.amount, 0);
  const today = S.txns.filter((x) => relativeDay(x.date) === 'Today');
  const todayOut = today.filter((x) => x.type === 'spend').reduce((s, x) => s + x.amount, 0);
  const todayIn = today.filter((x) => x.type === 'receive').reduce((s, x) => s + x.amount, 0);

  const months = lastMonths(7, m);
  const history = balanceHistory(St.liveAccounts(), S.txns, months);
  const bal = t.balances;
  const liveAccs = St.liveAccounts();
  const slices = liveAccs.map((a) => ({ label: a.name, value: Math.max(0, bal.get(a.id) || 0), color: a.color }));

  const budgets = S.budgets.map((b) => ({ b, s: budgetStatus(b, S.txns, m) }));
  const alerts = budgets.filter((x) => x.s.state === 'over' || x.s.state === 'close');
  const goals = S.goals.filter((g) => !g.archivedAt).map((g) => ({ g, p: goalProgress(g, S.txns) }));
  const recent = S.txns.slice(0, 7);
  const nudge = St.daysSinceBackup();

  const sts = safeToSpend(St.liveAccounts(), S.txns, S.budgets, S.recurring, m, now);

  return `
  ${header(greeting(), {
    sub: new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
    action: `<button class="icon-btn" data-go="settings" aria-label="Settings">${icon('gear')}</button>`,
  })}

  <section class="hero glass rise">
    <p class="hero-label">Total balance</p>
    <h2 class="hero-amount" data-animate data-value="0">${esc($$$(t.total))}</h2>
    <div class="hero-meta">
      <span class="${inM - outM >= 0 ? 'good' : 'bad'}">${esc(fmt(inM - outM, { sign: true, symbol: S.meta.currency || '₹' }))}</span>
      <small>this month</small>
    </div>
    <div class="hero-spark">${areaChart(history, { w: 320, h: 64, id: 'hero', color: 'var(--tint)' })}</div>
  </section>

  <section class="stats">
    ${statCard('Available', t.available, 'wallet', 'tint', 'accounts')}
    ${statCard('Savings', t.savings, 'shield', 'indigo', 'accounts')}
    ${statCard(t.receivables > 0 ? 'Receivables & Owed' : 'Owed to you', t.owedToYou, 'handIn', 'green', 'debts')}
    ${statCard('You owe', t.youOwe, 'handOut', 'orange', 'debts')}
  </section>

  ${(t.available > 0 || S.budgets.length > 0) ? `<section class="radar-card glass rise" data-go="budgets">
    <div class="radar-top">
      <span class="radar-badge tone-due">${icon(sts.perDay > 0 ? 'trend' : 'alert')} <b>Safe to Spend</b></span>
      <span class="radar-days">${sts.daysLeft} days remaining</span>
    </div>
    <div class="radar-main">
      <div class="radar-val"><b class="${sts.perDay <= 0 ? 'bad' : ''}">${esc($$$(sts.perDay))}</b><small>/ day</small></div>
      <div class="radar-meta">
        <div><small>Remaining Allowance</small><span>${esc($c(sts.allowance))}</span></div>
        ${sts.upcomingOutflow > 0 ? `<div><small>Reserved Bills</small><span>${esc($c(sts.upcomingOutflow))}</span></div>` : ''}
      </div>
    </div>
  </section>` : ''}

  ${today.length ? `<section class="today glass rise">
    <div class="today-head"><b>Today</b><small>${today.length} ${today.length === 1 ? 'movement' : 'movements'}</small></div>
    <div class="today-bars">
      ${todayIn ? `<div class="tb tb-in"><span>In</span><b>${esc($$$(todayIn))}</b></div>` : ''}
      ${todayOut ? `<div class="tb tb-out"><span>Out</span><b>${esc($$$(todayOut))}</b></div>` : ''}
      ${!todayIn && !todayOut ? '<div class="tb"><span>Moved only</span></div>' : ''}
    </div>
  </section>` : ''}

  ${alerts.length ? `<section class="alerts">${alerts.map((x) => {
    const c = St.category(x.b.category);
    return `<button class="alert ${x.s.state}" data-go="budgets">
      ${icon(x.s.state === 'over' ? 'alert' : 'trend')}
      <span><b>${esc(c ? c.name : 'Overall')}</b> ${x.s.state === 'over' ? `over by ${esc($c(-x.s.left))}` : `${esc($c(x.s.left))} left`}</span>
    </button>`;
  }).join('')}</section>` : ''}

  ${budgets.length ? `<section class="block">
    <div class="block-head"><h3>Budgets</h3><button class="link" data-go="budgets">All ${icon('chevron')}</button></div>
    <div class="hscroll">${budgets.slice(0, 6).map(({ b, s }) => {
    const c = St.category(b.category);
    return `<button class="ringcard rise" data-go="budgets">
        ${ring(s.pct, { size: 62, stroke: 6, color: s.state === 'over' ? 'var(--red)' : s.state === 'close' ? 'var(--orange)' : c?.color || 'var(--tint)' })}
        <b>${esc(c ? c.name : 'Overall')}</b>
        <small>${s.left >= 0 ? esc($c(s.left)) + ' left' : esc($c(-s.left)) + ' over'}</small>
      </button>`;
  }).join('')}</div>
  </section>` : ''}

  ${goals.length ? `<section class="block">
    <div class="block-head"><h3>Goals</h3><button class="link" data-go="goals">All ${icon('chevron')}</button></div>
    <div class="hscroll">${goals.slice(0, 6).map(({ g, p }) => `
      <button class="ringcard rise" data-goal="${g.id}">
        ${ring(p.pct, { size: 62, stroke: 6, color: g.color || 'var(--purple)' })}
        <span class="ringcard-emoji">${esc(g.emoji || '🎯')}</span>
        <b>${esc(g.name)}</b>
        <small>${esc($c(p.saved))} of ${esc($c(p.target))}</small>
      </button>`).join('')}</div>
  </section>` : ''}

  <section class="block">
    <div class="block-head"><h3>Recent</h3>${S.txns.length > 7 ? `<button class="link" data-go="activity">All ${icon('chevron')}</button>` : ''}</div>
    <div class="card list">${recent.length ? txnGroups(recent) : empty('wave', 'Nothing yet', 'Tap the + to record your first movement of money.')}</div>
  </section>

  ${slices.some((s) => s.value > 0) ? `<section class="block">
    <div class="block-head"><h3>Where it is</h3><button class="link" data-go="accounts">All ${icon('chevron')}</button></div>
    <div class="card">
      ${stackBar(slices)}
      <div class="dist">${liveAccs.filter((a) => (bal.get(a.id) || 0) > 0).sort((a, b) => (bal.get(b.id) || 0) - (bal.get(a.id) || 0)).map((a) => `
        <button class="dist-row" data-account="${a.id}">
          <i style="background:${a.color}"></i>
          <span>${esc(a.icon || '')} ${esc(a.name)}</span>
          <b>${esc($$$(bal.get(a.id) || 0))}</b>
        </button>`).join('')}</div>
    </div>
  </section>` : ''}

  ${S.txns.length > 4 ? `<button class="insight-teaser glass rise" data-go="insights">
    <span class="it-ico">${icon('pie')}</span>
    <span class="it-text"><b>Insights</b><small>Income, spending, and where it is drifting</small></span>
    ${icon('chevron')}
  </button>` : ''}

  ${nudge > 30 ? `<button class="nudge" data-backup>${icon('down2')} <span>It has been a while since your last backup.</span></button>` : ''}
  <div class="tail"></div>`;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
};

const statCard = (label, value, ico, tone, target) => `
  <button class="stat glass rise tone-${tone}" data-go="${target}">
    <span class="stat-ico">${icon(ico)}</span>
    <span class="stat-label">${esc(label)}</span>
    <b class="stat-value">${esc($c(value))}</b>
  </button>`;

/* ── Accounts ─────────────────────────────────────────────────────────────── */

function Accounts() {
  const t = state();
  const bal = t.balances;
  const spend = St.spendAccounts(), savings = St.savingsAccounts();
  const archived = S.accounts.filter((a) => a.archived);
  const groups = debtsByPerson(S.debts, S.txns);

  const accCard = (a) => {
    const b = bal.get(a.id) || 0;
    const months = lastMonths(6, monthKey(Date.now()));
    const trend = accountTrend(a.id, months);
    return `<button class="acc rise" data-account="${a.id}" style="--c:${a.color}">
      <span class="acc-face">${esc(a.icon || '•')}</span>
      <span class="acc-main"><b>${esc(a.name)}</b><small>${a.kind === 'savings' ? 'Set aside' : 'Spendable'}</small></span>
      <span class="acc-right">
        <b class="${b < 0 ? 'bad' : ''}">${esc($$$(b))}</b>
        <span class="acc-spark">${sparkline(trend, { color: a.color })}</span>
      </span>
    </button>`;
  };

  return `
  ${header('Accounts', { action: `<button class="icon-btn" data-newacc aria-label="New account">${icon('plus')}</button>` })}
  <section class="hero glass small rise">
    <p class="hero-label">Across every account</p>
    <h2 class="hero-amount" data-animate data-value="0">${esc($$$(t.total))}</h2>
    <div class="split">
      <div><small>Spendable</small><b>${esc($$$(t.available))}</b></div>
      <div><small>Set aside</small><b>${esc($$$(t.savings))}</b></div>
    </div>
  </section>

  ${spend.length ? `<section class="block"><div class="block-head"><h3>Spendable</h3></div>
    <div class="card list">${spend.map(accCard).join('')}</div></section>` : ''}
  ${savings.length ? `<section class="block"><div class="block-head"><h3>Set aside</h3></div>
    <div class="card list">${savings.map(accCard).join('')}</div></section>` : ''}

  ${groups.length ? `<section class="block">
    <div class="block-head"><h3>Clients & People</h3></div>
    <div class="card list">${groups.map((g, i) => `
      <button class="row row-tap" data-person="${i}">
        <span class="row-face ${(g.direction === 'lent' || g.direction === 'receivable') ? 'tone-due' : 'tone-owe'}">${g.direction === 'lent' ? '↙' : g.direction === 'receivable' ? '📄' : '↗'}</span>
        <span class="row-main"><b>${esc(g.person)}</b><small>${g.direction === 'lent' ? 'owes you' : g.direction === 'receivable' ? 'service receivable' : 'you owe'}</small></span>
        <span class="row-amt ${(g.direction === 'lent' || g.direction === 'receivable') ? 'good' : 'bad'}">${esc($$$(g.outstanding))}</span>
      </button>`).join('')}</div>
  </section>` : ''}

  <button class="btn btn-ghost full" data-newacc>${icon('plus')} New account</button>

  ${archived.length ? `<section class="block"><div class="block-head"><h3>Archived</h3></div>
    <div class="card list dim">${archived.map((a) => `<button class="row row-tap" data-account="${a.id}">
      <span class="row-face">${esc(a.icon || '•')}</span>
      <span class="row-main"><b>${esc(a.name)}</b><small>Archived</small></span>
      <span class="row-amt">${esc($$$(bal.get(a.id) || 0))}</span></button>`).join('')}</div></section>` : ''}
  <div class="tail"></div>`;
}

/** Balance at the end of each of the last N months, for the row sparkline. */
function accountTrend(id, months) {
  const a = St.account(id);
  let running = a?.opening || 0;
  const [firstStart] = monthBounds(months[0]);
  const byMonth = new Map(months.map((m) => [m, 0]));
  for (const t of S.txns) {
    let d = 0;
    for (const e of effects(t)) if (e.account === id) d += e.delta;
    if (!d) continue;
    if (t.date < firstStart) running += d;
    else { const k = monthKey(t.date); if (byMonth.has(k)) byMonth.set(k, byMonth.get(k) + d); }
  }
  return months.map((m) => (running += byMonth.get(m)));
}

/* ── Account detail ───────────────────────────────────────────────────────── */

function AccountDetail() {
  const a = St.account(view.param);
  if (!a) return Accounts();
  const bal = balances(S.accounts, S.txns).get(a.id) || 0;
  const list = S.txns.filter((t) => t.account === a.id || t.to === a.id);
  const months = lastMonths(9, monthKey(Date.now()));
  const trend = accountTrend(a.id, months);
  const inSum = list.filter((t) => effects(t).find((e) => e.account === a.id && e.delta > 0)).reduce((s, t) => s + t.amount, 0);
  const outSum = list.filter((t) => effects(t).find((e) => e.account === a.id && e.delta < 0)).reduce((s, t) => s + t.amount, 0);

  return `
  ${header(a.name, {
    back: true, sub: a.kind === 'savings' ? 'Set aside' : 'Spendable',
    action: `<button class="icon-btn" data-editacc aria-label="Edit">${icon('edit')}</button>`,
  })}
  <section class="hero glass rise" style="--tint:${a.color}">
    <p class="hero-label">${esc(a.icon || '')} Balance</p>
    <h2 class="hero-amount" data-animate data-value="0">${esc($$$(bal))}</h2>
    <div class="hero-spark">${areaChart(trend, { w: 320, h: 72, id: 'acc', color: a.color })}</div>
    <div class="split">
      <div><small>In</small><b class="good">${esc($$$(inSum))}</b></div>
      <div><small>Out</small><b>${esc($$$(outSum))}</b></div>
    </div>
  </section>
  <div class="quickrow">
    <button class="quick" data-quick="receive">${icon('in')}<span>Receive</span></button>
    <button class="quick" data-quick="spend">${icon('out')}<span>Spend</span></button>
    <button class="quick" data-quick="transfer">${icon('move')}<span>Move</span></button>
  </div>
  <section class="block"><div class="block-head"><h3>History</h3><small class="muted">${list.length}</small></div>
    <div class="card list">${list.length ? txnGroups(list.slice(0, 100), { showAccount: false }) : empty('wave', 'No movements yet', 'Money in and out of this account will show up here.')}</div>
  </section>
  <div class="tail"></div>`;
}

/* ── Activity ─────────────────────────────────────────────────────────────── */

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'in', label: 'In' },
  { id: 'out', label: 'Out' },
  { id: 'move', label: 'Moved' },
  { id: 'people', label: 'People' },
];

function Activity() {
  const q = view.query.trim().toLowerCase();
  let list = S.txns;

  if (view.filter === 'in') list = list.filter((t) => t.type === 'receive' || t.type === 'borrow' || (t.type === 'repay' && t.dir === 'in'));
  else if (view.filter === 'out') list = list.filter((t) => t.type === 'spend' || t.type === 'lend' || (t.type === 'repay' && t.dir === 'out'));
  else if (view.filter === 'move') list = list.filter((t) => ['transfer', 'save', 'withdraw'].includes(t.type));
  else if (view.filter === 'people') list = list.filter((t) => ['lend', 'borrow', 'repay'].includes(t.type));

  if (q) {
    list = list.filter((t) => {
      const cat = St.category(t.category), acc = St.account(t.account);
      return (t.note || '').toLowerCase().includes(q)
        || (t.person || '').toLowerCase().includes(q)
        || (cat?.name || '').toLowerCase().includes(q)
        || (acc?.name || '').toLowerCase().includes(q)
        || String(t.amount / 100).includes(q);
    });
  }

  const m = view.month;
  const [ms, me] = monthBounds(m);
  const inMonth = list.filter((t) => t.date >= ms && t.date < me);
  const showing = q ? list.slice(0, view.limit) : inMonth.slice(0, view.limit);
  const monthIn = inMonth.filter((t) => t.type === 'receive').reduce((s, t) => s + t.amount, 0);
  const monthOut = inMonth.filter((t) => t.type === 'spend').reduce((s, t) => s + t.amount, 0);
  const isThisMonth = m === monthKey(Date.now());

  return `
  ${header('Activity', { action: `<button class="icon-btn" data-search aria-label="Search">${icon('search')}</button>` })}
  <div class="searchwrap ${view.query ? 'open' : ''}">
    <label class="search">${icon('search')}
      <input data-q placeholder="Search notes, people, amounts" value="${esc(view.query)}" enterkeyhint="search">
      ${view.query ? `<button class="icon-btn tiny" data-clearq>${icon('x')}</button>` : ''}
    </label>
  </div>

  <div class="chips chips-scroll">${FILTERS.map((f) => `<button class="chip ${view.filter === f.id ? 'on' : ''}" data-filter="${f.id}">${esc(f.label)}</button>`).join('')}</div>

  ${q ? `<p class="result-count">${list.length} ${list.length === 1 ? 'result' : 'results'}</p>` : `
  <div class="monthbar glass">
    <button class="icon-btn" data-month="-1">${icon('back')}</button>
    <button class="monthbar-mid" data-monthpick>
      <b>${esc(monthLabel(m, true))}</b>
      <small><span class="good">+${esc($c(monthIn))}</span> · <span>−${esc($c(monthOut))}</span></small>
    </button>
    <button class="icon-btn" data-month="1" ${isThisMonth ? 'disabled' : ''}>${icon('chevron')}</button>
  </div>`}

  <div class="card list" data-list>
    ${showing.length ? txnGroups(showing) : empty('list', q ? 'Nothing matches' : 'Nothing this month', q ? 'Try a different word or amount.' : 'Movements you record will appear here.')}
  </div>
  ${(q ? list.length : inMonth.length) > view.limit ? '<button class="btn btn-ghost full" data-more>Show more</button>' : ''}
  <div class="tail"></div>`;
}

/* ── Budgets ──────────────────────────────────────────────────────────────── */

function Budgets() {
  const m = view.month;
  const isThisMonth = m === monthKey(Date.now());
  const now = isThisMonth ? Date.now() : monthBounds(m)[1] - 1;
  const list = S.budgets.map((b) => ({ b, s: budgetStatus(b, S.txns, m, now) }))
    .sort((a, b) => b.s.pct - a.s.pct);
  const overall = list.find((x) => !x.b.category);
  const rest = list.filter((x) => x.b.category);
  const [ms, me] = monthBounds(m);
  const spentAll = S.txns.filter((t) => t.type === 'spend' && t.date >= ms && t.date < me).reduce((s, t) => s + t.amount, 0);

  const card = ({ b, s }) => {
    const c = St.category(b.category);
    const col = s.state === 'over' ? 'var(--red)' : s.state === 'close' || s.state === 'fast' ? 'var(--orange)' : c?.color || 'var(--tint)';
    return `<button class="budget rise" data-budget="${b.id}">
      ${ring(s.pct, { size: 58, stroke: 6, color: col })}
      <span class="budget-main">
        <b>${esc(c ? `${c.emoji} ${c.name}` : '🌐 Everything')}</b>
        <small>${esc($$$(s.spent))} of ${esc($$$(s.limit))}</small>
        <span class="budget-note ${s.state}">${budgetNote(s, isThisMonth)}</span>
      </span>
      <span class="budget-left ${s.left < 0 ? 'bad' : ''}">${esc(s.left >= 0 ? $c(s.left) : '−' + $c(-s.left))}</span>
    </button>`;
  };

  return `
  ${header('Budgets', { action: `<button class="icon-btn" data-newbudget aria-label="New budget">${icon('plus')}</button>` })}
  <div class="monthbar glass">
    <button class="icon-btn" data-month="-1">${icon('back')}</button>
    <button class="monthbar-mid" data-monthpick><b>${esc(monthLabel(m, true))}</b><small>${esc($$$(spentAll))} spent</small></button>
    <button class="icon-btn" data-month="1" ${isThisMonth ? 'disabled' : ''}>${icon('chevron')}</button>
  </div>

  ${overall ? `<section class="bigbudget glass rise ${overall.s.state}">
    <div class="bb-ring">${ring(overall.s.pct, { size: 132, stroke: 11, color: overall.s.state === 'over' ? 'var(--red)' : overall.s.state === 'close' || overall.s.state === 'fast' ? 'var(--orange)' : 'var(--green)' })}
      <span class="bb-centre"><b>${esc($c(Math.abs(overall.s.left)))}</b><small>${overall.s.left >= 0 ? 'left' : 'over'}</small></span>
    </div>
    <p class="bb-note">${budgetNote(overall.s, isThisMonth)}</p>
    <button class="link" data-budget="${overall.b.id}">Adjust ${icon('chevron')}</button>
  </section>` : ''}

  ${rest.length ? `<div class="card list">${rest.map(card).join('')}</div>`
      : !overall ? empty('rings', 'No budgets yet', 'A budget is just a monthly ceiling. Set one and the app quietly keeps score.',
        '<button class="btn btn-primary" data-newbudget>Create a budget</button>') : ''}

  ${list.length ? '<button class="btn btn-ghost full" data-newbudget>' + icon('plus') + ' New budget</button>' : ''}
  <div class="tail"></div>`;
}

function budgetNote(s, isThisMonth) {
  if (!isThisMonth) return s.left >= 0 ? `Finished ${$c(s.left)} under` : `Went ${$c(-s.left)} over`;
  if (s.state === 'over') return `Over by ${$c(-s.left)}`;
  if (s.daysLeft === 0) return 'Last day of the month';
  if (s.state === 'close') return `${$c(s.left)} left with ${s.daysLeft} days to go`;
  if (s.state === 'fast') return `Spending faster than usual — ${$c(s.perDay)} a day from here`;
  return `About ${$c(s.perDay)} a day for the rest of the month`;
}

/* ── Goals ────────────────────────────────────────────────────────────────── */

function Goals() {
  const list = S.goals.filter((g) => !g.archivedAt).map((g) => ({ g, p: goalProgress(g, S.txns) }));
  const done = list.filter((x) => x.p.done);
  const active = list.filter((x) => !x.p.done);
  const totalSaved = list.reduce((s, x) => s + x.p.saved, 0);
  const totalTarget = list.reduce((s, x) => s + x.p.target, 0);

  const card = ({ g, p }) => `<button class="goal rise ${p.done ? 'done' : ''}" data-goal="${g.id}" style="--c:${g.color || 'var(--purple)'}">
    <div class="goal-top">
      <span class="goal-emoji">${esc(g.emoji || '🎯')}</span>
      <span class="goal-name"><b>${esc(g.name)}</b>
        <small>${p.done ? 'Reached 🎉' : p.perMonth ? `${esc($c(p.perMonth))} a month to make it` : p.overdue ? 'Past its date' : 'No deadline'}</small></span>
      <span class="goal-pct">${Math.round(p.pct * 100)}%</span>
    </div>
    <div class="goal-bar"><i style="--w:${(p.pct * 100).toFixed(1)}%"></i></div>
    <div class="goal-foot"><b>${esc($$$(p.saved))}</b><small>of ${esc($$$(p.target))}</small></div>
  </button>`;

  return `
  ${header('Goals', { action: `<button class="icon-btn" data-newgoal aria-label="New goal">${icon('plus')}</button>` })}
  ${list.length ? `<section class="hero glass small rise">
    <p class="hero-label">Put aside towards goals</p>
    <h2 class="hero-amount" data-animate data-value="0">${esc($$$(totalSaved))}</h2>
    <div class="hero-meta"><small>of ${esc($$$(totalTarget))} across ${list.length} ${list.length === 1 ? 'goal' : 'goals'}</small></div>
  </section>` : ''}

  ${active.length ? `<div class="goals">${active.map(card).join('')}</div>` : ''}
  ${done.length ? `<section class="block"><div class="block-head"><h3>Reached</h3></div><div class="goals">${done.map(card).join('')}</div></section>` : ''}
  ${!list.length ? empty('flag', 'No goals yet', 'Name something you are saving for and watch it fill up.',
    '<button class="btn btn-primary" data-newgoal>Create a goal</button>') : '<button class="btn btn-ghost full" data-newgoal>' + icon('plus') + ' New goal</button>'}
  <div class="tail"></div>`;
}

function openGoalDetail(g) {
  const p = goalProgress(g, S.txns);
  const acc = St.account(g.accountId);
  const moves = S.txns.filter((t) => t.goalId === g.id).slice(0, 30);
  const h = openSheet({
    title: g.name, subtitle: acc ? `Kept in ${acc.name}` : null,
    body: `<div class="goalview">
      <div class="gv-ring">${ring(p.pct, { size: 168, stroke: 13, color: g.color || 'var(--purple)' })}
        <span class="gv-centre"><i>${esc(g.emoji || '🎯')}</i><b>${esc($$$(p.saved))}</b><small>of ${esc($$$(p.target))}</small></span></div>
      <p class="gv-line">${p.done ? 'You made it.' : p.perMonth
      ? `${esc($$$(p.perMonth))} a month gets you there by ${esc(relativeDay(g.deadline))}.`
      : `${esc($$$(p.remaining))} still to go.`}</p>
      ${moves.length ? `<h4 class="mini-head">Movements</h4><div class="list plain">${moves.map((t) => `
        <div class="row static"><span class="row-face tone-${t.type === 'save' ? 'save' : 'move'}">${t.type === 'save' ? '↑' : '↓'}</span>
        <span class="row-main"><b>${t.type === 'save' ? 'Added' : 'Taken out'}</b><small>${esc(relativeDay(t.date))}</small></span>
        <span class="row-amt ${t.type === 'save' ? 'good' : ''}">${t.type === 'save' ? '+' : '−'}${esc($$$(t.amount))}</span></div>`).join('')}</div>` : ''}
    </div>`,
    actions: `<button class="btn btn-ghost" data-edit>Edit</button>
      ${p.done ? `<button class="btn btn-primary" data-take>Take it out</button>`
      : `<button class="btn btn-primary" data-add>Add money</button>`}`,
    onMount(sheet) {
      sheet.querySelector('[data-add]')?.addEventListener('click', () => {
        haptic('tap'); h.close(); openComposer({ type: 'save', prefill: { goalId: g.id, to: g.accountId } });
      });
      sheet.querySelector('[data-take]')?.addEventListener('click', () => {
        haptic('tap'); h.close(); openComposer({ type: 'withdraw', prefill: { goalId: g.id, account: g.accountId } });
      });
      sheet.querySelector('[data-edit]').addEventListener('click', () => { h.close(); openGoalEditor(g, render); });
    },
  });
}

/* ── Insights ─────────────────────────────────────────────────────────────── */

function Insights() {
  const m = view.month;
  const months6 = lastMonths(6, m);
  const months12 = lastMonths(12, m);
  const flow = monthlyFlow(S.txns, months6);
  const history = balanceHistory(St.liveAccounts(), S.txns, months12);
  const cats = categoryBreakdown(S.txns, m);
  const totalSpend = cats.reduce((s, c) => s + c.amount, 0);
  const t = state();
  const bal = t.balances;
  const accSlices = St.liveAccounts().map((a) => ({ label: a.name, value: Math.max(0, bal.get(a.id) || 0), color: a.color }));
  const savingsSeries = months12.map((mm) => {
    const [, end] = monthBounds(mm);
    let v = 0;
    for (const tx of S.txns) {
      if (tx.date >= end) continue;
      if (tx.type === 'save') v += tx.amount;
      else if (tx.type === 'withdraw') v -= tx.amount;
    }
    return v;
  });
  const avgSpend = Math.round(flow.spend.reduce((s, v) => s + v, 0) / Math.max(1, flow.spend.filter((v) => v > 0).length));
  const thisSpend = flow.spend[flow.spend.length - 1];
  const health = financialHealth(St.liveAccounts(), S.txns, S.debts, m);
  const radar = recurringRadar(S.recurring);

  return `
  ${header('Insights', { back: true, sub: monthLabel(m, true) })}

  <section class="block"><div class="block-head"><h3>Financial Vitality</h3></div>
    <div class="health-card glass rise">
      <div class="health-header">
        <div class="health-score-ring">
          ${ring(health.score, { size: 76, stroke: 7, color: health.score >= 85 ? 'var(--good)' : health.score >= 55 ? 'var(--tint)' : 'var(--orange)' })}
          <span class="health-num">${health.score}</span>
        </div>
        <div class="health-info">
          <span class="health-status">${esc(health.status)}</span>
          <p class="health-desc">Computed from emergency reserve runway, savings trajectory & asset liquidity.</p>
        </div>
      </div>
      <div class="health-grid">
        <div class="health-stat"><span>Runway</span><b>${health.runway === Infinity ? '36+ mos' : `${health.runway} mos`}</b></div>
        <div class="health-stat"><span>Savings Rate</span><b>${health.savingsRate}%</b></div>
        <div class="health-stat"><span>Net Worth</span><b>${esc($c(health.netWorth))}</b></div>
        ${radar.count > 0 ? `<div class="health-stat"><span>Auto Outflow</span><b>${esc($c(radar.monthlySpend))}/mo</b></div>` : `<div class="health-stat"><span>Receivables</span><b>${esc($c(t.receivables))}</b></div>`}
      </div>
    </div>
  </section>

  <section class="block"><div class="block-head"><h3>Income and spending</h3></div>
    <div class="card pad-card">
      <div class="legend"><span><i class="sw-in"></i>In</span><span><i class="sw-out"></i>Out</span></div>
      ${pairedBars(flow.income, flow.spend, months6.map((x) => monthLabel(x).split(' ')[0]))}
      <p class="insight-line">${thisSpend > avgSpend * 1.15
      ? `This month is running about ${esc($c(thisSpend - avgSpend))} above your usual.`
      : thisSpend < avgSpend * 0.85 && thisSpend > 0
        ? `About ${esc($c(avgSpend - thisSpend))} lighter than your usual month.`
        : 'Roughly in line with your usual months.'}</p>
    </div>
  </section>

  <section class="block"><div class="block-head"><h3>Balance over time</h3></div>
    <div class="card pad-card">
      <div class="scrub"><b data-scrub-val>${esc($$$(history[history.length - 1]))}</b><small data-scrub-lab>${esc(monthLabel(months12[months12.length - 1], true))}</small></div>
      <div data-area-host>${areaChart(history, { w: 340, h: 140, id: 'hist', color: 'var(--tint)' })}</div>
    </div>
  </section>

  ${totalSpend ? `<section class="block"><div class="block-head"><h3>Where it went</h3></div>
    <div class="card pad-card">
      <div class="donutwrap">
        ${donut(cats.map((c) => { const cc = St.category(c.category); return { label: cc?.name || 'Other', value: c.amount, color: cc?.color || 'var(--grey)' }; }))}
        <span class="donut-centre"><b>${esc($c(totalSpend))}</b><small>spent</small></span>
      </div>
      <div class="legend-list">${cats.slice(0, 8).map((c) => {
      const cc = St.category(c.category);
      return `<div class="lg-row"><i style="background:${cc?.color || 'var(--grey)'}"></i>
          <span>${esc(cc ? `${cc.emoji} ${cc.name}` : 'Uncategorised')}</span>
          <b>${esc($$$(c.amount))}</b><small>${Math.round((c.amount / totalSpend) * 100)}%</small></div>`;
    }).join('')}</div>
    </div>
  </section>` : ''}

  ${savingsSeries.some((v) => v) ? `<section class="block"><div class="block-head"><h3>Savings growth</h3></div>
    <div class="card pad-card">${areaChart(savingsSeries, { w: 340, h: 120, id: 'sav', color: 'var(--indigo)' })}
      <p class="insight-line">${esc($$$(savingsSeries[savingsSeries.length - 1]))} set aside in total.</p></div>
  </section>` : ''}

  ${accSlices.some((s) => s.value > 0) ? `<section class="block"><div class="block-head"><h3>Spread across accounts</h3></div>
    <div class="card pad-card">
      <div class="donutwrap">${donut(accSlices)}
        <span class="donut-centre"><b>${esc($c(t.total))}</b><small>total</small></span></div>
      <div class="legend-list">${accSlices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value).map((s) => `
        <div class="lg-row"><i style="background:${s.color}"></i><span>${esc(s.label)}</span>
        <b>${esc($$$(s.value))}</b><small>${Math.round((s.value / t.total) * 100)}%</small></div>`).join('')}</div>
    </div>
  </section>` : ''}
  <div class="tail"></div>`;
}

/* ── Settings ─────────────────────────────────────────────────────────────── */

function Settings() {
  const rec = S.recurring;
  const days = St.daysSinceBackup();
  return `
  ${header('Settings', { back: true })}
  <section class="block"><div class="block-head"><h3>Android OS & AI Automation</h3></div>
    <div class="card list">
      <button class="row row-tap" data-open-upi><span class="row-face">${icon('qr')}</span>
        <span class="row-main"><b>UPI Payment Manager</b><small>Scan QR codes and invoke system apps</small></span>${icon('chevron')}</button>
      <button class="row row-tap" data-open-auto><span class="row-face">${icon('trend')}</span>
        <span class="row-main"><b>Selective OS Notification Access</b><small>Configure monitored payment & SMS apps</small></span>${icon('chevron')}</button>
      <button class="row row-tap" data-open-aicfg><span class="row-face">${icon('spark')}</span>
        <span class="row-main"><b>OpenRouter AI Advisor</b><small>Free intelligent financial copilot</small></span>${icon('chevron')}</button>
      <button class="row row-tap" data-biometric-lock><span class="row-face">${icon('lock')}</span>
        <span class="row-main"><b>Biometric Security</b><small>Require fingerprint/face on launch</small></span>${icon('chevron')}</button>
    </div>
  </section>
  <section class="block"><div class="block-head"><h3>Your data</h3></div>
    <div class="card list">
      <button class="row row-tap" data-export><span class="row-face">${icon('down2')}</span>
        <span class="row-main"><b>Export a backup</b><small>${S.txns.length} records${S.meta.lastBackupAt ? ` · last saved ${esc(relativeDay(S.meta.lastBackupAt))}` : ' · never saved'}</small></span>${icon('chevron')}</button>
      <button class="row row-tap" data-import><span class="row-face">${icon('up2')}</span>
        <span class="row-main"><b>Restore a backup</b><small>Replaces everything on this device</small></span>${icon('chevron')}</button>
      <button class="row row-tap" data-csv><span class="row-face">${icon('note')}</span>
        <span class="row-main"><b>Import a spreadsheet</b><small>CSV: date, type, amount, account, category, note</small></span>${icon('chevron')}</button>
    </div>
    ${days > 30 ? `<p class="hint warn">Your last backup was ${days === 999 ? 'never' : days + ' days ago'}. This app keeps everything on this device only — if you lose the phone, you lose the records.</p>`
      : '<p class="hint">Everything lives on this device. Nothing is uploaded anywhere.</p>'}
  </section>

  <section class="block"><div class="block-head"><h3>Repeating</h3></div>
    <div class="card list">
      ${rec.length ? rec.map((r) => {
        const t = TYPES[r.template.type];
        return `<div class="swipe-row" data-rec="${r.id}">
          <div class="swipe-track">
            <div class="row swipe-surface static">
              <span class="row-face tone-${t.tone}">${icon('repeat')}</span>
              <span class="row-main"><b>${esc(r.template.note || t.label)}</b>
                <small>${esc({ day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[r.freq])} · next ${esc(relativeDay(r.nextAt))}</small></span>
              <span class="row-amt">${esc($$$(r.template.amount))}</span>
            </div>
            <div class="swipe-actions"><button class="swipe-del" aria-label="Delete">${icon('trash')}</button></div>
          </div></div>`;
      }).join('') : '<p class="hint pad">Mark a transaction as repeating when you create it and it will show up here.</p>'}
    </div>
  </section>

  <section class="block"><div class="block-head"><h3>Categories</h3></div>
    <div class="card list">
      ${S.categories.map((c) => `<button class="row row-tap" data-cat="${c.id}">
        <span class="row-face" style="--c:${c.color}">${esc(c.emoji)}</span>
        <span class="row-main"><b>${esc(c.name)}</b><small>${c.kind === 'receive' ? 'Income' : 'Spending'}</small></span>${icon('chevron')}</button>`).join('')}
      <button class="row row-tap" data-newcat><span class="row-face">${icon('plus')}</span>
        <span class="row-main"><b>New category</b></span></button>
    </div>
  </section>

  <section class="block"><div class="block-head"><h3>Preferences</h3></div>
    <div class="card list">
      <button class="row row-tap" data-currency><span class="row-face">${esc(S.meta.currency || '₹')}</span>
        <span class="row-main"><b>Currency symbol</b></span><span class="row-amt muted">${esc(S.meta.currency || '₹')}</span></button>
      <button class="row row-tap" data-theme><span class="row-face">${icon('spark')}</span>
        <span class="row-main"><b>Appearance</b></span><span class="row-amt muted">${esc({ auto: 'Automatic', light: 'Light', dark: 'Dark' }[S.meta.theme || 'auto'])}</span></button>
      <label class="row"><span class="row-face">${icon('wave')}</span>
        <span class="row-main"><b>Haptics</b><small>A small tap when things happen</small></span>
        <input type="checkbox" class="tog" data-haptics ${S.meta.haptics === false ? '' : 'checked'}></label>
    </div>
  </section>

  <section class="block">
    <div class="card list">
      <button class="row row-tap" data-storage><span class="row-face">${icon('archive')}</span>
        <span class="row-main"><b>Storage</b><small data-storagesub>Checking…</small></span></button>
      <button class="row row-tap danger-text" data-erase><span class="row-face">${icon('trash')}</span>
        <span class="row-main"><b>Erase everything</b><small>Cannot be undone</small></span></button>
    </div>
  </section>
  <p class="version">Fin · offline · v1.0</p>
  <div class="tail"></div>`;
}

/* ── Event wiring ─────────────────────────────────────────────────────────── */

function bind(root) {
  // Entrance animation for anything marked .rise
  stagger($$('.rise', root));

  $$('[data-go]', root).forEach((b) => b.addEventListener('click', () => {
    haptic('tap');
    const target = b.dataset.go;
    if (target === 'debts') { go('accounts'); return; }
    go(target);
  }));
  $('[data-back]', root)?.addEventListener('click', () => { haptic('light'); history.back(); });

  $$('[data-account]', root).forEach((b) => b.addEventListener('click', () => { haptic('tap'); go('account', b.dataset.account); }));
  $$('[data-goal]', root).forEach((b) => b.addEventListener('click', () => { haptic('tap'); const g = St.goal(b.dataset.goal); if (g) openGoalDetail(g); }));
  $$('[data-budget]', root).forEach((b) => b.addEventListener('click', () => {
    haptic('tap'); const x = S.budgets.find((y) => y.id === b.dataset.budget); if (x) openBudgetEditor(x, render);
  }));
  // Indexed rather than keyed by name: a person called "A|B" would otherwise
  // split into the wrong lookup.
  $$('[data-person]', root).forEach((b) => b.addEventListener('click', () => {
    const g = debtsByPerson(S.debts, S.txns)[Number(b.dataset.person)];
    if (g) { haptic('tap'); openDebtDetail(g, render); }
  }));

  $$('[data-newacc]', root).forEach((b) => b.addEventListener('click', () => { haptic('tap'); openAccountEditor({}, render); }));
  $$('[data-newbudget]', root).forEach((b) => b.addEventListener('click', () => { haptic('tap'); openBudgetEditor({}, render); }));
  $$('[data-newgoal]', root).forEach((b) => b.addEventListener('click', () => { haptic('tap'); openGoalEditor({}, render); }));
  $('[data-editacc]', root)?.addEventListener('click', () => { const a = St.account(view.param); if (a) openAccountEditor(a, () => { if (!St.account(view.param)) go('accounts', null, { back: true }); else render(); }); });
  $$('[data-quick]', root).forEach((b) => b.addEventListener('click', () => {
    haptic('tap');
    const type = b.dataset.quick;
    openComposer({ type, prefill: type === 'receive' ? { account: view.param } : { account: view.param } });
  }));

  // Transaction rows: tap for detail, swipe for actions, long-press for a shortcut.
  $$('.swipe-row[data-id]', root).forEach((row) => {
    const t = S.txns.find((x) => x.id === row.dataset.id);
    if (!t) return;
    swipeable(row, {
      onDelete: () => deleteWithUndo(t, render),
      onEdit: () => (['lend', 'borrow', 'repay'].includes(t.type) ? openTxnDetail(t, render) : openComposer({ type: t.type, editing: t })),
    });
    row.querySelector('.row-tap')?.addEventListener('click', () => { haptic('light'); openTxnDetail(t, render); });
    longPress(row, () => openTxnDetail(t, render));
  });

  // Recurring rows in Settings
  $$('.swipe-row[data-rec]', root).forEach((row) => {
    swipeable(row, {
      onDelete: async () => {
        if (!await confirmSheet({ title: 'Stop repeating?', message: 'Past entries stay. It just will not add itself again.', confirm: 'Stop' })) return;
        await St.removeRecurring(row.dataset.rec); render();
      },
    });
  });

  root.addEventListener('scroll', () => closeSwipes(root), { passive: true });

  /* Activity controls */
  $$('[data-filter]', root).forEach((b) => b.addEventListener('click', () => {
    haptic('select'); view.filter = b.dataset.filter; view.limit = 60; render();
  }));
  const q = $('[data-q]', root);
  if (q) {
    let timer;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { view.query = q.value; view.limit = 60; const at = q.selectionStart; render(); const nq = $('[data-q]'); if (nq) { nq.focus(); nq.setSelectionRange(at, at); } }, 180);
    });
  }
  $('[data-clearq]', root)?.addEventListener('click', () => { view.query = ''; render(); });
  $('[data-search]', root)?.addEventListener('click', () => { haptic('tap'); $('[data-q]')?.focus(); });
  $('[data-more]', root)?.addEventListener('click', () => { view.limit += 60; render(); });

  /* Month stepping */
  $$('[data-month]', root).forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    haptic('select');
    const next = addMonths(view.month, Number(b.dataset.month));
    if (next > monthKey(Date.now())) return;
    view.month = next; view.limit = 60; render();
  }));
  $('[data-monthpick]', root)?.addEventListener('click', () => {
    const opts = lastMonths(24, monthKey(Date.now())).reverse();
    pickSheet({
      title: 'Jump to month',
      items: opts.map((mm) => ({ id: mm, label: monthLabel(mm, true), selected: mm === view.month })),
      onPick(id) { view.month = id; render(); },
    });
  });

  /* Insights scrubbing */
  const host = $('[data-area-host] svg', root);
  if (host) {
    const months12 = lastMonths(12, view.month);
    const history = balanceHistory(St.liveAccounts(), S.txns, months12);
    const valNode = $('[data-scrub-val]', root), labNode = $('[data-scrub-lab]', root);
    hydrateArea(host, history.length, (i) => {
      const idx = i ?? history.length - 1;
      valNode.textContent = $$$(history[idx]);
      labNode.textContent = monthLabel(months12[idx], true);
    });
  }

  /* Settings */
  bindSettings(root);

  animateHeroes(root);
}

function animateHeroes(root) {
  $$('[data-animate]', root).forEach((n) => {
    const text = n.textContent;
    const value = parseFinal(text);
    n.dataset.value = '0';
    animateNumber(n, value, (v) => $$$(v));
  });
}
/** Recovers the paise value from already-rendered currency text. */
function parseFinal(text) {
  const neg = text.includes('−') || text.includes('-');
  const digits = text.replace(/[^\d.]/g, '');
  return Math.round(parseFloat(digits || '0') * 100) * (neg ? -1 : 1);
}

function bindSettings(root) {
  $('[data-open-upi]', root)?.addEventListener('click', () => openUpiScanner());
  $('[data-open-auto]', root)?.addEventListener('click', () => openAutomationSettings());
  $('[data-open-aicfg]', root)?.addEventListener('click', () => openAiSettings());
  $('[data-biometric-lock]', root)?.addEventListener('click', () => {
    haptic('tap');
    if (window.FinNative && typeof window.FinNative.requestBiometricLock === 'function') {
      window.FinNative.requestBiometricLock();
    } else {
      toast('Biometric hardware authentication active in native Android app only.');
    }
  });
  $('[data-export]', root)?.addEventListener('click', exportBackup);
  $('[data-import]', root)?.addEventListener('click', () => pickFile('.json', importBackup));
  $('[data-csv]', root)?.addEventListener('click', () => pickFile('.csv,text/csv', async (file) => {
    try {
      const n = await St.importCSV(await file.text());
      toast(`Added ${n} records.`, { tone: 'good' }); render();
    } catch (e) { toast(e.message || 'Could not read that file.'); }
  }));
  $$('[data-cat]', root).forEach((b) => b.addEventListener('click', () => {
    const c = St.category(b.dataset.cat); if (c) openCategoryEditor(c, render);
  }));
  $('[data-newcat]', root)?.addEventListener('click', () => openCategoryEditor({}, render));
  $('[data-haptics]', root)?.addEventListener('change', (e) => { St.setMeta('haptics', e.target.checked); haptic('tap'); });
  $('[data-currency]', root)?.addEventListener('click', () => {
    pickSheet({
      title: 'Currency symbol',
      items: ['₹', '$', '€', '£', '¥', '฿', 'د.إ', 'Rs'].map((s) => ({ id: s, label: s, selected: (S.meta.currency || '₹') === s })),
      onPick: async (s) => { await St.setMeta('currency', s); render(); },
    });
  });
  $('[data-theme]', root)?.addEventListener('click', () => {
    pickSheet({
      title: 'Appearance',
      items: [
        { id: 'auto', label: 'Automatic', sub: 'Follows your device', selected: (S.meta.theme || 'auto') === 'auto' },
        { id: 'light', label: 'Light', selected: S.meta.theme === 'light' },
        { id: 'dark', label: 'Dark', selected: S.meta.theme === 'dark' },
      ],
      onPick: async (t) => { await St.setMeta('theme', t); applyTheme(); render(); },
    });
  });
  const sub = $('[data-storagesub]', root);
  if (sub) {
    (async () => {
      const u = await (await import('./db.js')).usage();
      const persisted = await (await import('./db.js')).isPersisted();
      sub.textContent = u
        ? `${(u.used / 1048576).toFixed(1)} MB used${persisted ? ' · protected from cleanup' : ''}`
        : `${S.txns.length} records stored`;
    })();
  }
  $('[data-storage]', root)?.addEventListener('click', async () => {
    const ok = await (await import('./db.js')).persist();
    toast(ok ? 'This data is now protected from browser cleanup.' : 'Install the app to protect your data from cleanup.');
  });
  $('[data-erase]', root)?.addEventListener('click', async () => {
    if (!await confirmSheet({
      title: 'Erase everything?',
      message: `All ${S.txns.length} records, every account, budget and goal. There is no undo and no copy anywhere else.`,
      confirm: 'Erase it all',
    })) return;
    if (!await confirmSheet({ title: 'Really sure?', message: 'Export a backup first if there is any doubt.', confirm: 'Yes, erase' })) return;
    await St.importData({ format: 'fin.backup', accounts: [], txns: [], debts: [], goals: [], budgets: [], categories: S.categories, recurring: [], meta: { currency: S.meta.currency } });
    await St.setMeta('onboarded', false);
    location.reload();
  });
}

/* ── Backup ───────────────────────────────────────────────────────────────── */

async function exportBackup() {
  haptic('tap');
  const data = St.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const name = `fin-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });

  // Share sheet on phones (lets you drop it into Files, Drive, WhatsApp);
  // a plain download everywhere else.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Fin backup' });
      await St.setMeta('lastBackupAt', Date.now());
      toast('Backup saved.', { tone: 'good' }); render();
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  await St.setMeta('lastBackupAt', Date.now());
  toast('Backup downloaded.', { tone: 'good' });
  render();
}

function pickFile(accept, fn) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept });
  input.addEventListener('change', () => { if (input.files[0]) fn(input.files[0]); });
  input.click();
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const preview = JSON.parse(text);
    const c = preview.counts || {};
    const ok = await confirmSheet({
      title: 'Restore this backup?',
      message: `${c.txns ?? preview.txns?.length ?? 0} transactions, ${c.accounts ?? preview.accounts?.length ?? 0} accounts${preview.exportedAt ? `, saved ${new Date(preview.exportedAt).toLocaleDateString('en-IN')}` : ''}. Everything currently on this device will be replaced.`,
      confirm: 'Restore',
    });
    if (!ok) return;
    const n = await St.importData(preview);
    haptic('success');
    toast(`Restored ${n} transactions.`, { tone: 'good' });
    go('home', null, { replace: true });
    render();
  } catch (e) {
    haptic('warn');
    toast(e.message || 'That file could not be read.');
  }
}

/* ── Theme ────────────────────────────────────────────────────────────────── */

function applyTheme() {
  const t = S.meta.theme || 'auto';
  document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#000000' : '#F6F6F8');
}

/* ── Lock shield ──────────────────────────────────────────────────────────────
 * Holds until native authentication actually reports back. The old build never
 * received that callback, so this is the half that was missing.
 */
async function runLockShield() {
  const shield = $('#lock');
  const msg = $('#lock-msg');
  const btn = $('#lock-btn');
  shield.hidden = false;
  document.body.classList.add('locked-shield');

  for (;;) {
    btn.disabled = true;
    msg.textContent = 'Verify to continue';
    const { ok, reason } = await Native.unlock();
    if (ok) {
      shield.classList.add('away');
      document.body.classList.remove('locked-shield');
      setTimeout(() => { shield.hidden = true; shield.classList.remove('away'); }, 440);
      return;
    }
    // Failed or cancelled: stay locked, offer a retry. Never fall through.
    shield.classList.add('denied');
    msg.textContent = reason === 'cancelled' ? 'Cancelled. Tap to try again.'
      : reason === 'timeout' ? 'Timed out. Tap to try again.'
      : `Not verified — ${reason || 'try again'}`;
    btn.disabled = false;
    Native.haptic(40);
    await new Promise((r) => btn.addEventListener('click', r, { once: true }));
    shield.classList.remove('denied');
  }
}

/** Native events that must reach the UI wherever it is. */
function wireNativeEvents() {
  Native.on('capture', () => render());

  // Hardware back: close a sheet, else step back a screen, else let Android exit.
  Native.on('back', () => {
    if (anySheetOpen()) { closeTopSheet(); return true; }
    if (view.name !== 'home') { go('home', null, { back: true }); return true; }
    return false;
  });

  Native.on('quick', (a) => {
    if (a === 'scan') openActions();
    else if (TYPES[a]) openComposer({ type: a });
  });

  Native.on('resume', async () => {
    const made = await St.runRecurring();
    if (made.length) render();
    const pending = Native.drainCaptureQueue();
    if (pending.length) {
      toast(`${pending.length} transaction${pending.length > 1 ? 's' : ''} detected`, {
        action: 'Review', ms: 7000, onAction: () => go('activity'),
      });
    }
  });
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

async function boot() {
  const bar = $('#tabbar');
  bar.innerHTML = `<span class="tab-pill"></span>${TABS.map((t) => `
    <button class="tab" data-tab="${t.id}">${icon(t.icon)}<span>${esc(t.label)}</span></button>`).join('')}
    <button class="fab" id="fab" aria-label="Add">${icon('plus')}</button>`;

  $$('.tab', bar).forEach((b) => b.addEventListener('click', () => { haptic('tap'); go(b.dataset.tab); }));
  $('#fab').addEventListener('click', () => { haptic('tap'); openActions(); });

  Native.install();
  Ai.bindStore(St);

  await St.load();
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // Gate the whole app before anything renders. `booting` already hides #app,
  // so nothing sensitive has painted at this point.
  if (S.meta.lockEnabled && Native.isNative()) await runLockShield();

  wireNativeEvents();
  Native.profileDevice().then((p) => p && console.info('[fin] device profiled', p));

  St.subscribe(() => render());
  history.replaceState({ name: 'home', param: null }, '', '');
  render();
  document.body.classList.remove('booting');

  // Home-screen shortcuts (manifest "shortcuts" or native Android shortcuts)
  const shortcut = new URLSearchParams(location.search).get('do') || new URLSearchParams(location.search).get('action');
  if (shortcut === 'upi') {
    history.replaceState({ name: 'home', param: null }, '', location.pathname);
    setTimeout(() => openUpiScanner(), 260);
  } else if (shortcut === 'ai') {
    history.replaceState({ name: 'home', param: null }, '', location.pathname);
    setTimeout(() => openAiCopilot(), 260);
  } else if (shortcut && TYPES[shortcut]) {
    history.replaceState({ name: 'home', param: null }, '', location.pathname);
    setTimeout(() => openComposer({ type: shortcut }), 260);
  } else if (!S.meta.onboarded && !S.txns.length) setTimeout(() => openOnboarding(render), 420);

  /* Register two-way bridge with Android native OS */
  window.FinApp = window.FinApp || {};
  window.FinApp.onNotificationReceived = async (txnProposal) => {
    const { addToNotificationQueue } = await import('./automation.js');
    addToNotificationQueue(txnProposal);
    render();
    toast(`⚡ Detected payment: ₹${(txnProposal.amountPaise/100).toFixed(2)} at ${txnProposal.merchant}`, {
      action: 'Review', onAction: () => openNotificationReview(), ms: 7000, tone: 'good'
    });
  };
  window.FinApp.quickAction = (action) => {
    if (action === 'upi') openUpiScanner();
    else if (action === 'ai') openAiCopilot();
    else if (action === 'expense') openComposer({ type: 'spend' });
  };
  if (S.meta.pendingRecurring) {
    toast(`${S.meta.pendingRecurring} repeating ${S.meta.pendingRecurring === 1 ? 'entry was' : 'entries were'} added.`, { action: 'See', onAction: () => go('activity') });
    S.meta.pendingRecurring = 0;
  }

  // Keep the ledger honest across midnight and app resume.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const made = await St.runRecurring();
    if (made.length) render();
  });

  $$('[data-backup]').forEach((b) => b.addEventListener('click', exportBackup));

  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.register('./sw.js').catch(() => null);
    // Offer the update rather than reloading underneath someone mid-entry.
    reg?.addEventListener('updatefound', () => {
      const fresh = reg.installing;
      fresh?.addEventListener('statechange', () => {
        if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version is ready.', {
            action: 'Reload', ms: 12000,
            onAction: () => { fresh.postMessage('skip-waiting'); location.reload(); },
          });
        }
      });
    });
  }
}

/* Install prompt — offered once, quietly, after the app has proved useful. */
let deferredPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (S.txns.length < 3 || S.meta.installDismissed) return;
  setTimeout(() => {
    toast('Add Fin to your home screen?', {
      action: 'Install', ms: 9000,
      onAction: async () => { deferredPrompt?.prompt(); await deferredPrompt?.userChoice; deferredPrompt = null; St.setMeta('installDismissed', true); },
    });
  }, 3000);
});

// Delegated backup nudge, since Home re-renders.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-backup]')) exportBackup();
});

boot();
export { render, go };
