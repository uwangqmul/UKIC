// =============================================================================
// Portfolio journal ("journal mode")
// -----------------------------------------------------------------------------
// After a portfolio is chosen, read everything about it on the UMushroom page and save it as a "snapshot":
//   - summary: current value, cash, invested amount, performance, risk, benchmark, Sharpe and other metrics
//   - holdings: each stock's price, change since it was added, shares, value, weight
//   - pending orders: buys / sells waiting for the market to open
//   - transaction history: buys, sells, dividends and cash changes from the HISTORY popup
// Every buy / sell started by this project is recorded as well (the "activity log").
//
// Storage: logs\<portfolio id>\
//   latest.json      the latest snapshot
//   snapshots.jsonl  all snapshots (one per line, used to show changes over time)
//   events.jsonl     this project's buy / sell activity (one per line)
// plus logs\settings.json: the tracked portfolio list, whether hourly updates are on, and the last hourly run's result.
// The journal page (src\dashboard.js) reads these files.
// Page structure verified on 2026-09-27 against real portfolio pages.
// =============================================================================
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS, TIMEOUTS } from "./config.js";
import { SELECTORS as S } from "./site.js";
import { resolvePortfolioUrl } from "./trade.js";

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

/** Click a tab of the holdings area (All / Pending Orders); returns false if the tab does not exist. */
async function openWorkspaceTab(page, pattern) {
  const tab = page.locator(S.workspaceTab).filter({ hasText: pattern }).first();
  if (!await tab.isVisible().catch(() => false)) return false;
  await tab.click();
  await page.waitForTimeout(800);
  return true;
}

/** Expand every collapsed "See All" holdings list so that all holdings are read. */
async function expandAllHoldings(page) {
  const buttons = page.locator(S.expandHoldings);
  for (let i = await buttons.count() - 1; i >= 0; i -= 1) {
    const button = buttons.nth(i);
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
  }
  await page.waitForTimeout(500);
}

/** Read the portfolio name, currency, publish date, visibility and the summary metrics on the right (in one evaluate). */
function readOverview(page) {
  return page.evaluate(({ titleSel, headerSel, railSel }) => {
    const text = (el) => el?.textContent.replace(/\s+/g, " ").trim() ?? "";
    const header = document.querySelector(headerSel);
    const rail = document.querySelector(railSel);
    const chips = Object.fromEntries([...(header?.querySelectorAll(".meta-chip") ?? [])]
      .map((c) => [text(c.querySelector(".chip-label")), text(c.querySelector("strong"))]));
    // Cash and invested amount are in the allocation bar's data-tooltip, e.g. "Invested Capital: USD 199,998.09 (20.00%)"
    const allocation = Object.fromEntries([...(rail?.querySelectorAll(".summary-allocation-segment") ?? [])].map((seg) => {
      const m = /^(.*?):\s*(.*?)\s*\((.*?)\)$/.exec(seg.dataset.tooltip ?? "");
      return m ? [m[1], { amount: m[2], share: m[3] }] : [seg.className, {}];
    }));
    // Metric cards: Performance / Risk level / Benchmark / Sharpe / Sortino / Info ratio
    const metrics = Object.fromEntries([...(rail?.querySelectorAll(".summary-insight") ?? [])].map((m) => [
      text(m.querySelector(".summary-insight-heading span")),
      { value: text(m.querySelector("strong")), note: text(m.querySelector(".summary-score-scale p")) || undefined },
    ]));
    return {
      name: document.querySelector(titleSel)?.value?.trim() || text(header?.querySelector(".title-holder h5")),
      currency: chips.Currency,
      published: chips.Published,
      visibility: text(header?.querySelector(".status-pill")),
      owner: text(header?.querySelector(".type a")),
      currentValue: text(rail?.querySelector(".summary-card.primary strong")),
      cash: text(rail?.querySelector(".summary-cash-copy strong")) || allocation.Cash?.amount,
      cashShare: allocation.Cash?.share,
      invested: allocation["Invested Capital"]?.amount,
      investedShare: allocation["Invested Capital"]?.share,
      metrics,
    };
  }, { titleSel: S.portfolioTitle, headerSel: S.portfolioHeader, railSel: S.summaryRail });
}

/** Read the visible holdings (All tab, by group). */
function readHoldings(page) {
  return page.evaluate(({ groupSel, rowSel }) => {
    const text = (el) => el?.textContent.replace(/\s+/g, " ").trim() ?? "";
    // Each cell's value is in the span after .meta-label
    const cell = (row, cls) => {
      const c = row.querySelector(`.${cls}.info-cell`);
      if (!c) return undefined;
      const spans = [...c.querySelectorAll(":scope > span")].filter((s) => !s.classList.contains("meta-label"));
      return text(spans[0]);
    };
    return [...document.querySelectorAll(groupSel)].flatMap((group) => {
      const assetClass = text(group.querySelector(":scope > h2"));
      return [...group.querySelectorAll(rowSel)].map((row) => ({
        assetClass,
        name: text(row.querySelector("h5.title")),
        href: row.querySelector(".image-and-main-info a")?.getAttribute("href") ?? "",
        addedOn: cell(row, "added-on"),
        price: cell(row, "price"),
        performance: cell(row, "performance"),     // change since the stock was added to the portfolio
        rating: cell(row, "rating"),
        shares: cell(row, "shares"),
        value: cell(row, "value"),
        weight: cell(row, "weight"),
      }));
    });
  }, { groupSel: S.investmentGroup, rowSel: S.investmentRow });
}

/** Read pending orders (Pending Orders tab). Negative shares mean a sell. */
function readPending(page) {
  return page.evaluate((rowSel) => {
    const text = (el) => el?.textContent.replace(/\s+/g, " ").trim() ?? "";
    const cell = (row, cls) => {
      const c = row.querySelector(`.${cls}.info-cell`);
      if (!c) return undefined;
      const spans = [...c.querySelectorAll(":scope > span")].filter((s) => !s.classList.contains("meta-label"));
      return text(spans[0]);
    };
    return [...document.querySelectorAll(rowSel)].map((row) => ({
      name: text(row.querySelector("h5.title")),
      href: row.querySelector(".image-and-main-info a")?.getAttribute("href") ?? "",
      executionDate: cell(row, "execution"),
      status: cell(row, "estimated-execution"),
      price: cell(row, "price"),
      performance1y: cell(row, "performance"),
      rating: cell(row, "rating"),
      shares: cell(row, "shares"),
      value: cell(row, "value"),
      expectedWeight: cell(row, "weight"),
    }));
  }, S.pendingRow);
}

/** Open the HISTORY popup, read every transaction and close the popup again. */
async function readHistory(page) {
  const button = page.locator(S.history).filter({ hasText: /^History$/i }).first();
  if (!await button.isVisible().catch(() => false)) return [];
  await button.click();
  const popup = page.locator(S.historyPopup).first();
  await popup.waitFor({ state: "visible" });
  await page.locator(`${S.historyPopup} .transactions > .content, ${S.historyPopup} .transactions > .empty-state`)
    .first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const cards = await page.locator(S.historyCard).evaluateAll((els) => {
    const text = (el) => el?.textContent.replace(/\s+/g, " ").trim() ?? "";
    return els.map((card) => ({
      date: text(card.querySelector(".date-chip")),
      balance: text(card.querySelector(".panel-value")),
      rows: [...card.querySelectorAll(".action-row")].map((row) => ({
        type: text(row.querySelector(".transaction-badge")),
        description: text(row.querySelector(".description")),
        value: text(row.querySelector(".value")),
      })),
    }));
  });
  await page.locator(S.historyClose).first().click().catch(() => {});
  await popup.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  // Flatten to one entry per row and parse shares, name and price from the description, e.g.
  // "Buy - 184.7933 shares Micron Technology Inc @ 1,082.29"
  return cards.flatMap((card) => card.rows.map((row) => {
    const m = /^(Buy|Sell)\s*-\s*([\d.,]+)\s+shares?\s+(.+?)\s+@\s+([\d.,]+)$/i.exec(row.description);
    return {
      date: card.date, balanceAfterDay: card.balance, ...row,
      ...(m ? { shares: toNumber(m[2]), name: m[3], price: toNumber(m[4]) } : {}),
    };
  }));
}

/**
 * Take a snapshot of a portfolio: open its page -> read the summary -> all holdings -> pending orders -> history.
 * portfolio can be a name or a URL; portfolios with the same name are told apart by portfolioIndex.
 */
export async function snapshotPortfolio(page, { portfolio, portfolioIndex } = {}) {
  if (!portfolio) throw new Error("Please specify a portfolio (name or URL).");
  const url = await resolvePortfolioUrl(page, portfolio, portfolioIndex);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  await page.locator(S.summaryRail).first().waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".holdings-workspace").first().waitFor({ state: "visible", timeout: 20_000 });

  const overview = await readOverview(page);
  const hasPending = await openWorkspaceTab(page, /^\s*Pending Orders/i);
  const pending = hasPending ? await readPending(page) : [];
  await openWorkspaceTab(page, /^\s*All(?![a-z])/i);
  await expandAllHoldings(page);
  const holdings = await readHoldings(page);
  const transactions = await readHistory(page);

  const { name, ...summary } = overview;
  return {
    id: portfolioId(url),
    takenAt: new Date().toISOString(),
    portfolio: { name: name || portfolio, url },
    summary, holdings, pending, transactions,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Convert text like "USD 1,082.28", "-0.11%" or "- USD 1,082.28" to a number; returns null if it cannot be parsed. */
export function toNumber(textValue) {
  if (textValue == null) return null;
  const raw = String(textValue).replace(/[, ]/g, "");
  const m = /(-)?[^\d-]*?(-?\d+(?:\.\d+)?)/.exec(raw);
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] && n > 0 ? -n : n;
}

/** Folder name derived from a portfolio URL, e.g. /en/profile/you-wang/portfolio/first-portfolio -> you-wang--first-portfolio. */
export function portfolioId(url) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const owner = parts[parts.indexOf("portfolio") - 1] ?? "unknown";
  const slug = parts[parts.indexOf("portfolio") + 1] ?? "portfolio";
  return `${owner}--${slug}`.replace(/[^a-z0-9_-]/gi, "_");
}

const dirOf = (id) => join(PATHS.logs, id.replace(/[^a-z0-9_-]/gi, "_"));

/**
 * Save a snapshot: write latest.json, append to snapshots.jsonl and add the portfolio to the tracked list
 * (a portfolio already in the list keeps its "hourly update" switch). portfolioIndex tells same-named portfolios apart.
 */
export async function saveSnapshot(snapshot, { portfolioIndex } = {}) {
  const dir = dirOf(snapshot.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), JSON.stringify(snapshot, null, 2), "utf8");
  await appendFile(join(dir, "snapshots.jsonl"), JSON.stringify(snapshot) + "\n", "utf8");
  await updateSettings((settings) => {
    const old = settings.tracked[snapshot.id] ?? {};
    settings.tracked[snapshot.id] = {
      name: snapshot.portfolio.name, url: snapshot.portfolio.url,
      portfolioIndex: portfolioIndex ?? old.portfolioIndex,
      hourly: old.hourly ?? true, addedAt: old.addedAt ?? snapshot.takenAt, updatedAt: snapshot.takenAt,
      // hidden (removed from the list) is cleared automatically when the portfolio is recorded again
    };
  });
  return dir;
}

// ---------------------------------------------------------------------------
// Settings: logs\settings.json
//   { hourly: hourly auto-update on/off, tracked: { <portfolio id>: { name, url, portfolioIndex, hourly, ... } },
//     lastRun: last hourly run { at, results: [{ id, name, ok, error }] } }
// ---------------------------------------------------------------------------

const settingsFile = () => join(PATHS.logs, "settings.json");
let settingsQueue = Promise.resolve(); // serialise writes so concurrent changes do not overwrite each other

/**
 * Read the settings (defaults if the file does not exist).
 * Portfolios that have journals but are not tracked yet (e.g. recorded before this feature existed) are added automatically, with hourly updates on.
 */
export async function readSettings() {
  const saved = await readFile(settingsFile(), "utf8").then(JSON.parse).catch(() => ({}));
  const settings = { hourly: true, lastRun: null, ...saved, tracked: saved.tracked ?? {} };
  for (const id of await readdir(PATHS.logs).catch(() => [])) {
    if (settings.tracked[id]) continue;
    const latest = await readFile(join(dirOf(id), "latest.json"), "utf8").then(JSON.parse).catch(() => null);
    if (latest) settings.tracked[id] = { name: latest.portfolio.name, url: latest.portfolio.url, hourly: true, addedAt: latest.takenAt, updatedAt: latest.takenAt };
  }
  return settings;
}

/** Change the settings: mutate(settings) edits the object in place; it is then written back and the new settings are returned. */
export function updateSettings(mutate) {
  const run = settingsQueue.then(async () => {
    const settings = await readSettings();
    await mutate(settings);
    await mkdir(PATHS.logs, { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
    return settings;
  });
  settingsQueue = run.catch(() => {});
  return run;
}

/** Append one activity entry of this project (a buy / sell preview or submission). */
export async function appendEvent(id, event) {
  const dir = dirOf(id);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
}

/** Read a jsonl file (empty array if the file does not exist; bad lines are skipped). */
async function readJsonl(file) {
  const content = await readFile(file, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/** List every portfolio that has a journal, with its latest summary. */
export async function listPortfolioLogs() {
  const ids = await readdir(PATHS.logs).catch(() => []);
  const items = [];
  for (const id of ids) {
    const latest = await readFile(join(dirOf(id), "latest.json"), "utf8").then(JSON.parse).catch(() => null);
    if (latest) items.push({ id, name: latest.portfolio.name, url: latest.portfolio.url, takenAt: latest.takenAt, summary: latest.summary });
  }
  const { tracked } = await readSettings();
  for (const item of items) item.hourly = tracked[item.id]?.hourly ?? true; // whether this portfolio takes part in hourly updates
  return items
    .filter((item) => !tracked[item.id]?.hidden)                              // portfolios removed from the list are not shown
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

/** Read a portfolio's full journal: latest snapshot, all snapshots (for changes over time) and activity. */
export async function readPortfolioLog(id) {
  const dir = dirOf(id);
  const latest = await readFile(join(dir, "latest.json"), "utf8").then(JSON.parse).catch(() => null);
  if (!latest) return null;
  const snapshots = await readJsonl(join(dir, "snapshots.jsonl"));
  const events = await readJsonl(join(dir, "events.jsonl"));
  return { latest, snapshots, events };
}

/** Last modification time of the journals; the page uses it to decide whether to refresh. */
export async function logsVersion() {
  let newest = (await stat(settingsFile()).catch(() => null))?.mtimeMs ?? 0;
  for (const id of await readdir(PATHS.logs).catch(() => [])) {
    for (const f of ["latest.json", "events.jsonl"]) {
      const s = await stat(join(dirOf(id), f)).catch(() => null);
      if (s && s.mtimeMs > newest) newest = s.mtimeMs;
    }
  }
  return newest;
}
