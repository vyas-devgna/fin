/* ai.js — the chief of staff.
 *
 * Three rules hold this together:
 *
 *  1. The model never writes to the ledger. It returns JSON commands; store.js
 *     validates and applies them. An LLM with direct write access to a money
 *     database is a bug generator with good manners.
 *  2. Every call is rebuilt from live state. There is no static system prompt,
 *     because a prompt that does not know today's balance gives generic advice.
 *  3. Offline always works. Every path has a deterministic fallback.
 */
import { fmt, monthKey, monthBounds } from './core.js';

const MODEL_FALLBACK = 'meta-llama/llama-3.3-70b-instruct:free';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/* ── Key resolution ────────────────────────────────────────────────────────────
 * secrets.js (baked into the APK) → stored key (web) → nothing.
 * The dynamic import must be guarded: on the public web build the file is absent
 * by design, and a bare static import would break the whole module graph. */
let baked = null;
const bakedReady = import('./secrets.js')
  .then((m) => {
    const k = (m.OPENROUTER_KEY || '').trim();
    baked = k && !k.startsWith('PASTE_') && !k.endsWith('REPLACE_ME')
      ? { key: k, model: m.OPENROUTER_MODEL || MODEL_FALLBACK }
      : null;
  })
  .catch(() => { baked = null; });

let store = null;
/** store.js injects itself here; importing it directly would make a cycle. */
export function bindStore(s) { store = s; }

export async function aiConfig() {
  await bakedReady;
  const meta = store?.S?.meta || {};
  if (meta.aiDisabled) return { key: '', model: MODEL_FALLBACK, enabled: false };
  const key = (meta.openrouterKey || '').trim() || baked?.key || '';
  return { key, model: meta.openrouterModel || baked?.model || MODEL_FALLBACK, enabled: !!key, source: meta.openrouterKey ? 'stored' : baked ? 'bundled' : 'none' };
}

export const aiReady = async () => (await aiConfig()).enabled;

/* ── Transport ────────────────────────────────────────────────────────────── */

async function call(messages, { temperature = 0.3, maxTokens = 700, json = false } = {}) {
  const cfg = await aiConfig();
  if (!cfg.enabled) throw new Error('NO_KEY');

  const ctrl = new AbortController();
  // A finance assistant that hangs is worse than one that says it timed out.
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fin.vyasdevgna.online',
        'X-Title': 'Fin',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('BAD_KEY');
      if (res.status === 429) throw new Error('RATE_LIMIT');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
    }
    const j = await res.json();
    return (j?.choices?.[0]?.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Persona ──────────────────────────────────────────────────────────────────
 * Written to suppress the two failure modes of a finance chatbot: inventing
 * numbers, and dispensing horoscope advice ("consider building an emergency
 * fund") that ignores what is actually on screen.
 */
function persona(ctx) {
  return `You are the chief of staff for one person's money. You are not a chatbot and not a financial advisor; you are the person who already knows their numbers and answers in one breath.

HARD RULES
- Every figure you state must come from CONTEXT below. Never estimate, never invent, never round to a "typical" number. If the answer is not in CONTEXT, say exactly what is missing.
- Amounts are Indian rupees. Use ₹ and Indian grouping (₹1,20,000 / ₹15.2L / ₹2.5Cr).
- Be short. Two or three sentences unless asked to go deeper. No preamble, no "Great question", no bullet lists unless comparing three or more things.
- Never give generic advice. "Build an emergency fund" is banned. Say "your emergency account covers 3.2 months; one more month is ₹18,400" instead.
- You are talking to the owner of this data. No disclaimers, no "consult a professional", no privacy warnings.
- If something looks wrong in the data, say so plainly.

TODAY IS ${ctx.today}.

CONTEXT
${ctx.body}`;
}

/** Compact snapshot of the ledger. Token budget matters — this is sent on every turn. */
function buildContext() {
  const S = store?.S;
  if (!S) return { today: new Date().toDateString(), body: '(no data)' };

  const core = store.snapshot();
  const cur = S.meta.currency || '₹';
  const money = (p) => fmt(p, { symbol: cur });
  const m = monthKey(Date.now());
  const [ms] = monthBounds(m);

  const lines = [];
  lines.push(`Total ${money(core.total)} · spendable ${money(core.available)} · set aside ${money(core.savings)}`);
  if (core.owedToYou) lines.push(`Owed to you ${money(core.owedToYou)}`);
  if (core.youOwe) lines.push(`You owe ${money(core.youOwe)}`);

  lines.push(`\nACCOUNTS`);
  for (const a of store.liveAccounts()) {
    lines.push(`- ${a.name} (${a.kind === 'savings' ? 'set aside' : 'spendable'}): ${money(core.balances.get(a.id) || 0)}`);
  }

  const monthTx = S.txns.filter((t) => t.date >= ms);
  const inM = monthTx.filter((t) => t.type === 'receive').reduce((s, t) => s + t.amount, 0);
  const outM = monthTx.filter((t) => t.type === 'spend').reduce((s, t) => s + t.amount, 0);
  lines.push(`\nTHIS MONTH: in ${money(inM)}, out ${money(outM)}, net ${money(inM - outM)} over ${monthTx.length} entries`);

  if (S.budgets.length) {
    lines.push(`\nBUDGETS`);
    for (const b of S.budgets) {
      const st = store.budgetState(b, m);
      const c = store.category(b.category);
      lines.push(`- ${c ? c.name : 'Overall'}: ${money(st.spent)} of ${money(st.limit)} (${Math.round(st.pct * 100)}%${st.left < 0 ? ', OVER' : `, ${money(st.left)} left`})`);
    }
  }

  if (S.goals.length) {
    lines.push(`\nGOALS`);
    for (const g of S.goals.filter((x) => !x.archivedAt)) {
      const p = store.goalState(g);
      lines.push(`- ${g.name}: ${money(p.saved)} of ${money(p.target)}${p.perMonth ? ` (needs ${money(p.perMonth)}/mo)` : ''}`);
    }
  }

  const cats = store.topCategories(m, 6);
  if (cats.length) {
    lines.push(`\nSPENDING THIS MONTH BY CATEGORY`);
    for (const c of cats) lines.push(`- ${c.name}: ${money(c.amount)}`);
  }

  const vendors = topVendors(6);
  if (vendors.length) {
    lines.push(`\nVENDOR MEMORY (learned)`);
    for (const v of vendors) {
      lines.push(`- ${v.name}: ${v.count}x, usually ${money(v.median)}${v.category ? `, ${v.category}` : ''}${v.app ? `, pays via ${v.app}` : ''}`);
    }
  }

  const facts = S.aiFacts || [];
  if (facts.length) {
    lines.push(`\nTHINGS YOU HAVE BEEN TOLD`);
    for (const f of facts.slice(-14)) lines.push(`- ${f.text}`);
  }

  lines.push(`\nRECENT`);
  for (const t of S.txns.slice(0, 12)) {
    const c = store.category(t.category);
    lines.push(`- ${new Date(t.date).toLocaleDateString('en-IN')} ${t.type} ${money(t.amount)}${c ? ` ${c.name}` : ''}${t.note ? ` "${t.note}"` : ''}${t.person ? ` [${t.person}]` : ''}`);
  }

  return { today: new Date().toDateString(), body: lines.join('\n') };
}

/* ── Vendor memory ────────────────────────────────────────────────────────────
 * Derived from the ledger rather than stored separately, so it can never
 * disagree with it. Median, not mean: one ₹4,000 outlier should not move
 * "usually ₹80".
 */
export function vendorProfile(key) {
  const S = store?.S;
  if (!S || !key) return null;
  const k = String(key).toLowerCase().trim();
  const hits = S.txns.filter((t) =>
    (t.vpa && t.vpa.toLowerCase() === k) ||
    (t.person && t.person.toLowerCase() === k) ||
    (t.note && t.note.toLowerCase().includes(k)));
  if (!hits.length) return null;

  const amounts = hits.map((t) => t.amount).sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)];
  const catCount = new Map();
  for (const t of hits) if (t.category) catCount.set(t.category, (catCount.get(t.category) || 0) + 1);
  const topCat = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const rules = S.meta.routingRules || {};

  return {
    key: k,
    name: hits[0].person || hits[0].note || k,
    count: hits.length,
    median,
    min: amounts[0],
    max: amounts[amounts.length - 1],
    category: topCat ? store.category(topCat[0])?.name : null,
    categoryId: topCat ? topCat[0] : null,
    app: rules[k] || null,
    lastSeen: hits[0].date,
  };
}

function topVendors(n) {
  const S = store?.S;
  if (!S) return [];
  const keys = new Map();
  for (const t of S.txns) {
    const k = (t.vpa || t.person || '').toLowerCase().trim();
    if (!k) continue;
    keys.set(k, (keys.get(k) || 0) + 1);
  }
  return [...keys.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k]) => vendorProfile(k)).filter(Boolean);
}

/* ── Chat ─────────────────────────────────────────────────────────────────── */

export async function ask(question, history = []) {
  const ctx = buildContext();
  // Only the last few turns: the context block is rebuilt every call anyway, so
  // older turns add tokens without adding truth.
  const recent = history.slice(-6).map((m) => ({ role: m.role, content: m.content }));
  try {
    const answer = await call([
      { role: 'system', content: persona(ctx) },
      ...recent,
      { role: 'user', content: question },
    ], { temperature: 0.35, maxTokens: 600 });
    return { ok: true, text: answer };
  } catch (e) {
    return { ok: false, text: offlineAnswer(question, ctx), reason: e.message };
  }
}

/** Answers the handful of questions worth answering without a network. */
function offlineAnswer(q, ctx) {
  const S = store?.S;
  const cur = S?.meta?.currency || '₹';
  const lower = q.toLowerCase();
  const c = store?.snapshot?.();
  if (!c) return 'No data yet.';
  if (/afford|can i|should i (buy|spend)/.test(lower)) {
    return `Spendable right now: ${fmt(c.available, { symbol: cur })}. ${S.budgets.length ? 'Check the budget ring before committing.' : ''} (Offline — reconnect for a real answer.)`;
  }
  if (/how much|balance|total|left/.test(lower)) {
    return `Total ${fmt(c.total, { symbol: cur })} — ${fmt(c.available, { symbol: cur })} spendable, ${fmt(c.savings, { symbol: cur })} set aside. (Offline.)`;
  }
  if (/owe|debt|lent|borrow/.test(lower)) {
    return `Owed to you ${fmt(c.owedToYou, { symbol: cur })}. You owe ${fmt(c.youOwe, { symbol: cur })}. (Offline.)`;
  }
  return 'That needs the network. Your numbers are all still on the Money tab.';
}

/* ── Structured commands ──────────────────────────────────────────────────────
 * The model proposes; store.js disposes. Anything not matching the schema is
 * dropped rather than guessed at.
 */
const ALLOWED = new Set(['log_txn', 'set_category', 'remember_fact', 'suggest_budget', 'flag_anomaly', 'none']);

export async function interpret(text) {
  const ctx = buildContext();
  const cats = (store?.S?.categories || []).map((c) => `${c.id}:${c.name}`).join(', ');
  const accs = (store?.liveAccounts() || []).map((a) => `${a.id}:${a.name}`).join(', ');

  const schema = `Return ONE JSON object, nothing else:
{"command":"log_txn","type":"spend|receive|transfer|save|withdraw|lend|borrow","amountRupees":number,"accountId":"<id>","toAccountId":"<id or null>","categoryId":"<id or null>","person":"<name or null>","note":"<short>","confidence":0..1}
or {"command":"remember_fact","text":"<one durable fact about this person's money>"}
or {"command":"none","reason":"<why nothing was logged>"}

Accounts: ${accs}
Categories: ${cats}
Pick the most plausible account when unstated. Amount is rupees, not paise.`;

  try {
    const raw = await call([
      { role: 'system', content: persona(ctx) + '\n\n' + schema },
      { role: 'user', content: text },
    ], { temperature: 0.1, maxTokens: 320, json: true });
    return validate(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch (e) {
    return { command: 'none', reason: e.message === 'NO_KEY' ? 'AI not configured' : 'Could not read that' };
  }
}

/** Nothing reaches the ledger without passing through here. */
function validate(cmd) {
  if (!cmd || typeof cmd !== 'object' || !ALLOWED.has(cmd.command)) {
    return { command: 'none', reason: 'unrecognised command' };
  }
  if (cmd.command === 'log_txn') {
    const rupees = Number(cmd.amountRupees);
    if (!Number.isFinite(rupees) || rupees <= 0) return { command: 'none', reason: 'no valid amount' };
    // Cross the float boundary exactly once, here, and never again.
    cmd.amount = Math.round(rupees * 100);
    delete cmd.amountRupees;
    const valid = new Set(['spend', 'receive', 'transfer', 'save', 'withdraw', 'lend', 'borrow']);
    if (!valid.has(cmd.type)) return { command: 'none', reason: `unknown type ${cmd.type}` };
    if (!store.account(cmd.accountId)) cmd.accountId = store.liveAccounts()[0]?.id;
    if (cmd.categoryId && !store.category(cmd.categoryId)) cmd.categoryId = null;
    if (!cmd.accountId) return { command: 'none', reason: 'no account' };
  }
  if (cmd.command === 'remember_fact' && (!cmd.text || String(cmd.text).length > 240)) {
    return { command: 'none', reason: 'bad fact' };
  }
  return cmd;
}

/* ── Insight cards ────────────────────────────────────────────────────────── */

export async function briefing() {
  const ctx = buildContext();
  try {
    const text = await call([
      { role: 'system', content: persona(ctx) },
      { role: 'user', content: 'Give me exactly three short observations about my money right now. Each one must cite a number from CONTEXT. One line each, no bullets, no preamble. Lead with the one that most needs my attention.' },
    ], { temperature: 0.4, maxTokens: 260 });
    return text.split('\n').map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter((l) => l.length > 8).slice(0, 3);
  } catch (e) {
    return offlineBriefing(e.message);
  }
}

function offlineBriefing(reason) {
  const c = store?.snapshot?.();
  const S = store?.S;
  if (!c) return [];
  const cur = S.meta.currency || '₹';
  const out = [];
  const over = (S.budgets || []).map((b) => ({ b, s: store.budgetState(b, monthKey(Date.now())) })).filter((x) => x.s.pct >= 0.85);
  if (over.length) {
    const c0 = store.category(over[0].b.category);
    out.push(`${c0 ? c0.name : 'Overall'} budget is ${Math.round(over[0].s.pct * 100)}% used.`);
  }
  if (c.youOwe > 0) out.push(`You owe ${fmt(c.youOwe, { symbol: cur })} across open debts.`);
  if (c.owedToYou > 0) out.push(`${fmt(c.owedToYou, { symbol: cur })} is still owed to you.`);
  out.push(`${fmt(c.available, { symbol: cur })} spendable, ${fmt(c.savings, { symbol: cur })} set aside.`);
  if (reason === 'NO_KEY') out.push('Add an OpenRouter key in Settings for live analysis.');
  return out.slice(0, 3);
}

/* ── Compatibility surface ────────────────────────────────────────────────────
 * sheets.js was written against the first version of this module. Rather than
 * rewrite those screens twice (the navigation rebuild replaces them anyway),
 * the old names map onto the new engine.
 */

/** Synchronous mirror of aiConfig(), because the settings screen reads it during render. */
let cached = { apiKey: '', model: MODEL_FALLBACK, enabled: false };
bakedReady.then(() => { if (baked) cached = { apiKey: baked.key, model: baked.model, enabled: true, source: 'bundled' }; });

export function getAiConfig() {
  const meta = store?.S?.meta;
  if (meta?.openrouterKey) return { apiKey: meta.openrouterKey, model: meta.openrouterModel || cached.model, enabled: !meta.aiDisabled, source: 'stored' };
  return { ...cached, enabled: cached.enabled && !meta?.aiDisabled };
}

export async function setAiConfig({ apiKey, model, enabled = true }) {
  if (!store) return getAiConfig();
  await store.setMeta('openrouterKey', (apiKey || '').trim());
  if (model) await store.setMeta('openrouterModel', model.trim());
  await store.setMeta('aiDisabled', !enabled);
  return getAiConfig();
}

export const callOpenRouter = (messages, temperature = 0.2, maxTokens = 400) =>
  call(messages, { temperature, maxTokens });

/** Old shape: an array of {type, amountPaise, note, category}. */
export async function parseChatToLedger(input, categories = []) {
  if (!input?.trim()) return [];
  if (!(await aiReady())) return parseOfflineHeuristic(input, categories);
  const cmd = await interpret(input);
  if (cmd.command !== 'log_txn') return parseOfflineHeuristic(input, categories);
  return [{
    type: cmd.type,
    amountPaise: cmd.amount,
    note: cmd.note || input.slice(0, 40),
    category: store?.category(cmd.categoryId)?.name || 'General',
    categoryId: cmd.categoryId || null,
    accountId: cmd.accountId || null,
    person: cmd.person || null,
  }];
}

export const getAiFinancialAdvice = () => briefing();

/* Kept for the existing offline test in test.js. */
export function parseOfflineHeuristic(text, categories = []) {
  const m = String(text).match(/(?:₹|rs\.?|inr)?\s*(\d+(?:[.,]\d+)?)/i);
  if (!m) return [];
  const amount = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
  if (!(amount > 0)) return [];
  const lower = String(text).toLowerCase();
  const type = /receiv|got|credit|salary|income/.test(lower) ? 'receive'
    : /lent|lend|gave to/.test(lower) ? 'lend'
    : /borrow|took from/.test(lower) ? 'borrow'
    : /save|set aside/.test(lower) ? 'save' : 'spend';
  const hit = categories.find((c) => lower.includes(String(c.name || c).toLowerCase()));
  return [{ type, amountPaise: amount, note: String(text).slice(0, 40), category: hit ? (hit.name || hit) : 'General' }];
}
