// =============================================================================
// Public entry point: the MCP server (server.js) and the command line (scripts/cli.js) only call this module
// -----------------------------------------------------------------------------
//   openUmushroom        open My Overview without logging in and report the login state
//   checkUmushroomLogin  check the login state
//   tradeUmushroom       buy / sell (preview only by default); in journal mode the portfolio is recorded automatically
//   logPortfolio         snapshot a portfolio into its journal and open the journal page beside UMushroom
//   openJournal          open the journal page
//   start/get/stopUmushroomReview  read-only review (see review.js)
//   closeUmushroom       stop the review and close the tabs / windows this project opened
// =============================================================================
import { LOG } from "./config.js";
import { HOME_URL, OVERVIEW_URL } from "./site.js";
import { closeUmushroomSession, ensureUmushroomPage, getSessionInfo, inspectLogin, openSideWindow, overlay, waitForLoginState } from "./browser.js";
import { stopDashboard } from "./dashboard.js";
import { saveSnapshot, snapshotPortfolio } from "./journal.js";
import { ensureJournalService, recordTrade, stopJournalService } from "./autolog.js";
import { getUmushroomReviewStatus, isReviewActive, stopUmushroomReview, waitForReview } from "./review.js";
import { buyStock, sellStock } from "./trade.js";

export { startUmushroomReview, getUmushroomReviewStatus, stopUmushroomReview } from "./review.js";

/** Open My Overview directly: nothing to do by hand when Chrome is already logged in. While a review is running, return its progress. */
export async function openUmushroom() {
  if (isReviewActive()) return getUmushroomReviewStatus();
  const page = await ensureUmushroomPage({ navigate: true, url: OVERVIEW_URL });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const login = await waitForLoginState(page);
  const session = await getSessionInfo();
  await overlay(page, login.message);
  return { site: HOME_URL, overview: OVERVIEW_URL, currentUrl: page.url(), title: await page.title().catch(() => ""), browser: "Google Chrome", session, login, browserKeptOpen: true };
}

/** Check the login state (without navigating); while a review is running, return its progress. */
export async function checkUmushroomLogin() {
  if (isReviewActive()) { const status = getUmushroomReviewStatus(); return { login: status.login, ...status }; }
  const page = await ensureUmushroomPage();
  return { site: HOME_URL, overview: OVERVIEW_URL, currentUrl: page.url(), browser: "Google Chrome", session: await getSessionInfo(), login: await waitForLoginState(page, 5_000) };
}

/** Stop the review and close the session: attach mode closes only this project's tabs, project-profile mode closes the Chrome window. */
export async function closeUmushroom() {
  stopUmushroomReview();
  stopJournalService();
  await closeUmushroomSession();
  await stopDashboard();
  await waitForReview();
  return { status: "closed", message: "Closed the UMushroom tabs opened by this project (in attach mode your Chrome keeps running)." };
}

/**
 * Buy / sell (paper portfolio). kind is "buy" or "sell"; preview only by default, options.submit=true really submits.
 * Shares the tab with the read-only review, so trading is refused while a review is running.
 */
export async function tradeUmushroom(kind, options) {
  if (isReviewActive()) throw new Error("A portfolio review is running; call stop_umushroom_review before trading.");
  const page = await ensureUmushroomPage({ navigate: false });
  const login = await inspectLogin(page);
  if (login.state === "login_required" || login.state === "region_required") throw new Error(login.message);
  await overlay(page, `${kind === "buy" ? "Buy" : "Sell"} ${options.company}${options.submit ? " (submit)" : " (preview only)"}`);
  const result = kind === "buy" ? await buyStock(page, options) : await sellStock(page, options);
  await overlay(page, `${kind === "buy" ? "Buy" : "Sell"} ${options.company}: ${result.submitted ? "submitted" : "preview done, not submitted"}`);
  if (LOG.enabled) result.log = await logTrade(page, kind, options, result);
  return result;
}

/** Journal mode: after a trade, record the portfolio snapshot and this action (see autolog.recordTrade), then open the journal page. */
async function logTrade(page, kind, options, result) {
  await overlay(page, "Journal mode: recording a portfolio snapshot...");
  const log = await recordTrade(page, kind, options, result);
  if (log.ok && LOG.autoOpen) log.journalUrl = await openJournal().then((r) => r.url).catch(() => undefined);
  await overlay(page, log.ok ? "Journal updated." : `Journal recording failed: ${log.error}`);
  return log;
}

/**
 * Snapshot a portfolio into its journal (holdings and their changes, pending orders, history, summary metrics); opens the journal page beside UMushroom by default.
 * Returns the key points of the snapshot and the journal page URL.
 */
export async function logPortfolio({ portfolio, portfolioIndex, open = LOG.autoOpen } = {}) {
  if (isReviewActive()) throw new Error("A portfolio review is running; call stop_umushroom_review before recording a journal.");
  const page = await ensureUmushroomPage({ navigate: false });
  const login = await inspectLogin(page);
  if (login.state === "login_required" || login.state === "region_required") throw new Error(login.message);
  await overlay(page, `Journal mode: reading portfolio ${portfolio}...`);
  const snapshot = await snapshotPortfolio(page, { portfolio, portfolioIndex });
  const logDir = await saveSnapshot(snapshot, { portfolioIndex });
  const journalUrl = open ? (await openJournal()).url : await ensureJournalService();
  await overlay(page, `Recorded a snapshot of ${snapshot.portfolio.name}.`);
  return {
    id: snapshot.id, portfolio: snapshot.portfolio, takenAt: snapshot.takenAt, summary: snapshot.summary,
    holdings: snapshot.holdings.map(({ name, price, performance, shares, value, weight }) => ({ name, price, performance, shares, value, weight })),
    pending: snapshot.pending.map(({ name, shares, price, value, status }) => ({ name, shares, price, value, status })),
    transactions: snapshot.transactions.length, logDir, journalUrl,
  };
}

/** Start the journal service (page + portfolio adjustments + hourly updates) and open the journal page in a new window beside UMushroom. */
export async function openJournal() {
  const url = await ensureJournalService();
  await openSideWindow(url);
  return { url, message: "The journal page is open in the window beside UMushroom; you can also visit this address in any browser." };
}
