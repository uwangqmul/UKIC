// =============================================================================
// Journal service: lets the journal page "adjust portfolios" and updates them every hour on the hour
// -----------------------------------------------------------------------------
// - Actions for the journal page: list portfolios that can be added, add/track a portfolio, update now, buy/sell (preview first, then confirm),
//   switch hourly updates on or off. They all run in the background worker tab (browser.getWorkerPage)
//   and go through a queue one at a time, so browser operations never interfere with each other.
// - Hourly schedule: at every full hour (xx:00) take one snapshot of each portfolio that has hourly updates switched on.
//   Only works while a process of this project is running (npm run open / log / journal, start-umushroom.cmd, the MCP server).
// =============================================================================
import { LOG } from "./config.js";
import { getWorkerPage } from "./browser.js";
import { setDashboardActions, startDashboard } from "./dashboard.js";
import { appendEvent, portfolioId, readSettings, saveSnapshot, snapshotPortfolio, updateSettings } from "./journal.js";
import { orderGuard } from "./order-lock.js";
import { isReviewActive } from "./review.js";
import { buyStock, equitySlug, readProfilePortfolios, sellStock } from "./trade.js";

// ---------------------------------------------------------------------------
// Task queue: only one browser operation at a time
// ---------------------------------------------------------------------------

let queue = Promise.resolve();
let busy = null; // description of the task currently running, e.g. "Hourly update First Portfolio"

/** Add a task to the queue and return its result. */
export function enqueue(label, task) {
  const run = queue.then(async () => {
    busy = { label, since: new Date().toISOString() };
    try { return await task(); } finally { busy = null; }
  });
  queue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Journal recording
// ---------------------------------------------------------------------------

/**
 * After a trade, take a snapshot of the portfolio and append an activity entry (called after a buy/sell).
 * A recording failure never affects the trade result; it is only reported in the returned error.
 * The snapshot also tells whether the stock now has pending orders (placed while the market is closed, filled at the next open
 * at a price not known yet), recorded as pendingOrdersForStock / fillStatus; more than one gives a warning (e.g. a second buy
 * placed before the first one was filled).
 * result.submitted may be "unknown" (submitted but not confirmed, see trade.js); it is recorded as such.
 */
export async function recordTrade(page, kind, options, result) {
  const target = kind === "sell"
    ? { portfolio: result.portfolioUrl }
    : { portfolio: options.portfolio ?? result.portfolio, portfolioIndex: options.portfolioIndex };
  const event = {
    action: kind, company: options.company,
    equity: kind === "buy" ? result.equity?.name : result.holding?.name,
    portfolio: result.portfolio ?? result.preview?.portfolio,
    shares: result.preview?.shares, marketPrice: result.preview?.marketPrice,
    estimatedAmount: result.preview?.estimatedAmount, submitted: result.submitted,
    source: options.source ?? "cli/mcp", // whether the action came from the command line/MCP or the journal page
  };
  try {
    const snapshot = await snapshotPortfolio(page, target);
    await saveSnapshot(snapshot, { portfolioIndex: options.portfolioIndex });
    const log = { ok: true, id: snapshot.id, holdings: snapshot.holdings.length, pending: snapshot.pending.length };
    const key = equitySlug(kind === "buy" ? result.equity?.url : result.holding?.href);
    if (key && result.submitted) {
      const pendingForStock = snapshot.pending.filter((p) => equitySlug(p.href) === key).length;
      event.pendingOrdersForStock = log.pendingOrdersForStock = pendingForStock;
      event.fillStatus = result.submitted === "unknown" ? "unknown: the order was not confirmed, check Pending Orders / History"
        : pendingForStock ? "pending: fills when the market opens, at the opening price" : "not pending (filled, or not shown yet)";
      if (pendingForStock > 1) log.warning = `${pendingForStock} pending orders for this stock; they all fill at the next market open.`;
    }
    await appendEvent(snapshot.id, event);
    return log;
  } catch (error) {
    // If the snapshot fails but the portfolio URL is known, still record the action
    if (result.portfolioUrl) await appendEvent(portfolioId(result.portfolioUrl), event).catch(() => {});
    return { ok: false, error: String(error.message).split(/\r?\n/)[0] };
  }
}

/** Take and save a snapshot of a portfolio in the background tab. */
async function snapshotInWorker(target, portfolioIndex) {
  const page = await getWorkerPage();
  const snapshot = await snapshotPortfolio(page, { portfolio: target, portfolioIndex });
  await saveSnapshot(snapshot, { portfolioIndex });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Hourly schedule
// ---------------------------------------------------------------------------

let timer;
let nextRunAt = null;

/** Milliseconds until the next full hour (xx:00:05, 5 seconds of margin). */
export function msUntilNextHour(now = new Date()) {
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 5, 0);
  return next - now;
}

/** Schedule the next hourly update (calling again restarts the timer). */
function scheduleNextHour() {
  clearTimeout(timer);
  const ms = msUntilNextHour();
  nextRunAt = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(() => { runHourly().finally(scheduleNextHour); }, ms);
  timer.unref(); // do not keep the process alive just for the timer (e.g. when npm run trade finishes)
}

/** Hourly update: take one snapshot of every portfolio with hourly updates on; the result is saved as lastRun in the settings. */
export async function runHourly({ force = false } = {}) {
  const settings = await readSettings();
  if (!settings.hourly && !force) return { skipped: "Hourly updates are switched off" };
  if (isReviewActive()) return { skipped: "The read-only review is running" };
  const targets = Object.entries(settings.tracked).filter(([, t]) => t.hourly !== false);
  const results = [];
  for (const [id, t] of targets) {
    try {
      await enqueue(`Hourly update ${t.name}`, () => snapshotInWorker(t.url));
      results.push({ id, name: t.name, ok: true });
    } catch (error) {
      results.push({ id, name: t.name, ok: false, error: String(error.message).split(/\r?\n/)[0] });
    }
  }
  const lastRun = { at: new Date().toISOString(), forced: force, results };
  await updateSettings((s) => { s.lastRun = lastRun; });
  return lastRun;
}

// ---------------------------------------------------------------------------
// Actions for the journal page
// ---------------------------------------------------------------------------

const actions = {
  /** Current status: hourly switch, next run time, last result, the task currently running. */
  async status() {
    const s = await readSettings();
    return { actions: true, hourly: s.hourly, nextRunAt: s.hourly ? nextRunAt : null, lastRun: s.lastRun, busy };
  },

  /** Switch hourly updates: without id it is the master switch, otherwise the switch of one portfolio. */
  async setHourly({ id, enabled }) {
    await updateSettings((s) => {
      if (!id) s.hourly = !!enabled;
      else if (s.tracked[id]) s.tracked[id].hourly = !!enabled;
      else throw new Error("No such portfolio");
    });
    return actions.status();
  },

  /** List all portfolios on My profile and mark the tracked ones. */
  async available() {
    const list = await enqueue("Reading the portfolio list", async () => readProfilePortfolios(await getWorkerPage()));
    const { tracked } = await readSettings();
    return list.map((p) => ({ ...p, id: portfolioId(p.url), tracked: !!tracked[portfolioId(p.url)] }));
  },

  /** Add (track) a portfolio: take a snapshot right away; from then on it takes part in hourly updates. */
  async track({ url, portfolioIndex }) {
    if (!/^https:\/\/umushroom\.com\//.test(url ?? "")) throw new Error("Invalid portfolio URL");
    const snapshot = await enqueue("Adding a portfolio", () => snapshotInWorker(url, portfolioIndex));
    await updateSettings((s) => { s.tracked[snapshot.id].hourly = true; }); // re-adding a portfolio switches its hourly updates back on
    return { id: snapshot.id, name: snapshot.portfolio.name };
  },

  /** Stop tracking: no more hourly updates and hidden from the list; recorded journal files are kept. */
  async untrack({ id }) {
    await updateSettings((s) => { if (s.tracked[id]) { s.tracked[id].hourly = false; s.tracked[id].hidden = true; } });
    return { ok: true };
  },

  /** Update now: without id, update every portfolio with hourly updates on. */
  async refresh({ id } = {}) {
    if (!id) return runHourly({ force: true });
    const { tracked } = await readSettings();
    const t = tracked[id];
    if (!t) throw new Error("No such portfolio");
    const snapshot = await enqueue(`Updating ${t.name}`, () => snapshotInWorker(t.url));
    return { id: snapshot.id, takenAt: snapshot.takenAt };
  },

  /**
   * Buy / sell: preview with submit=false first, then submit=true after confirming (both steps need your click on the page).
   * Parameters: { kind: "buy"|"sell", id: portfolio id, company, shares | amount, submit }
   */
  async trade({ kind, id, company, shares, amount, submit }) {
    if (!["buy", "sell"].includes(kind)) throw new Error("The action must be buy or sell");
    if (isReviewActive()) throw new Error("The read-only review is running; please try again later.");
    const { tracked } = await readSettings();
    const t = tracked[id];
    if (!t) throw new Error("No such portfolio; add it on the journal page first.");
    const options = {
      company, shares, amount, submit: submit === true, source: "journal page",
      ...(kind === "buy" ? { portfolio: t.name, portfolioIndex: t.portfolioIndex } : { portfolio: t.url }),
    };
    return enqueue(`${kind === "buy" ? "Buy" : "Sell"} ${company}${options.submit ? " (submit)" : " (preview)"}`, async () => {
      const page = await getWorkerPage();
      const trade = { ...options, guard: orderGuard };
      let result;
      try {
        result = kind === "buy" ? await buyStock(page, trade) : await sellStock(page, trade);
      } catch (error) {
        // Submitted but not confirmed: record it too, so the activity log shows the order may exist
        if (error.code === "ORDER_UNCONFIRMED" && LOG.enabled && error.result) await recordTrade(page, kind, options, error.result).catch(() => {});
        throw error;
      }
      // Only a real submission is snapshotted and recorded; a preview does not change the portfolio and just returns the preview data
      if (result.submitted && LOG.enabled) result.log = await recordTrade(page, kind, options, result);
      return result;
    });
  },
};

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

let started;

/**
 * Start the journal service (only once, however often it is called): journal page server + page actions + hourly schedule. Returns the journal page URL.
 */
export function ensureJournalService() {
  started ??= (async () => {
    setDashboardActions(actions);
    const url = await startDashboard();
    scheduleNextHour();
    return url;
  })().catch((error) => { started = undefined; throw error; });
  return started;
}

/** Stop the hourly schedule (called when the session is closed). */
export function stopJournalService() {
  clearTimeout(timer);
  nextRunAt = null;
  started = undefined;
}
