// Journal mode tests: snapshot reading, journal storage and the journal page API, using the mock site (tests/fixtures/mock-site.js).
// Never contacts the real site; journals go to a temp folder. Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ORIGIN, PORTFOLIO_PATH, routeMockSite } from "./fixtures/mock-site.js";

// Must be set before src/ is loaded: journals go to a temp folder and the journal page uses a separate port
const logDir = await mkdtemp(join(tmpdir(), "umushroom-journal-"));
process.env.MCP_LOG_DIR = logDir;
process.env.MCP_LOG_PORT = "6499";
const { snapshotPortfolio, saveSnapshot, appendEvent, listPortfolioLogs, readPortfolioLog, toNumber, portfolioId } = await import("../src/journal.js");
const { startDashboard, stopDashboard } = await import("../src/dashboard.js");

// ---------- Test setup ----------
let browser, page;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MCP_CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.MCP_CHROME_EXECUTABLE_PATH }
      : { channel: process.env.MCP_CHROME_CHANNEL || "chrome" }),
  });
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await routeMockSite(context);
});
after(async () => {
  await browser?.close();
  await stopDashboard();
  await rm(logDir, { recursive: true, force: true });
});

// ---------- Tests ----------
test("toNumber: parses amounts, percentages and negative values from the site", () => {
  assert.equal(toNumber("USD 1,082.28"), 1082.28);
  assert.equal(toNumber("- USD 1,082.28"), -1082.28);
  assert.equal(toNumber("-0.11%"), -0.11);
  assert.equal(toNumber("+590.10%"), 590.1);
  assert.equal(toNumber("3/10"), 3);
  assert.equal(toNumber(""), null);
});

test("portfolioId: derives the folder name from the portfolio URL", () => {
  assert.equal(portfolioId(`${ORIGIN}${PORTFOLIO_PATH}`), "you-wang--first-portfolio");
});

let snapshot;
test("snapshot: finds the portfolio by name and reads the summary, all holdings (including expanded ones), pending orders and history", async () => {
  snapshot = await snapshotPortfolio(page, { portfolio: "First Portfolio" });
  assert.equal(snapshot.id, "you-wang--first-portfolio");
  assert.equal(snapshot.portfolio.name, "First Portfolio");
  assert.equal(snapshot.summary.currentValue, "USD 999,998.11");
  assert.equal(snapshot.summary.invested, "USD 199,998.09");
  assert.equal(snapshot.summary.investedShare, "20.00%");
  assert.equal(snapshot.summary.currency, "USD");
  assert.equal(snapshot.summary.metrics["Risk level"].value, "3/10");
  assert.equal(snapshot.summary.metrics.Sharpe.note, "Below risk-free return");

  assert.equal(snapshot.holdings.length, 2, "See All should be expanded so every holding is read");
  assert.deepEqual(snapshot.holdings[0], {
    assetClass: "Equities", name: "Micron Technology Inc", href: "/en/equity/mu-micron-technology",
    addedOn: "22 Sep 2026", price: "USD 1,082.28", performance: "-0.00%", rating: "4.42",
    shares: "184.7933", value: "USD 199,998.09", weight: "20.00%",
  });
  assert.equal(snapshot.holdings[1].performance, "+1.15%");

  assert.equal(snapshot.pending.length, 1);
  assert.equal(snapshot.pending[0].name, "Apple Inc");
  assert.equal(snapshot.pending[0].status, "Pending");
  assert.equal(snapshot.pending[0].shares, "1");

  assert.equal(snapshot.transactions.length, 2);
  assert.equal(snapshot.transactions[1].type, "Buy");
  assert.equal(snapshot.transactions[1].shares, 184.7933);
  assert.equal(snapshot.transactions[1].name, "Micron Technology Inc");
  assert.equal(snapshot.transactions[1].price, 1082.29);
  assert.ok(await page.locator(".transactions-popup").isHidden(), "the History popup should be closed afterwards");
});

test("storage: saves snapshots and activity and reads them back", async () => {
  await saveSnapshot(snapshot);
  await saveSnapshot({ ...snapshot, takenAt: new Date(Date.now() + 1000).toISOString() });
  await appendEvent(snapshot.id, { action: "buy", company: "Apple", shares: 1, submitted: true });
  const list = await listPortfolioLogs();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "First Portfolio");
  const log = await readPortfolioLog(snapshot.id);
  assert.equal(log.snapshots.length, 2);
  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].company, "Apple");
  assert.ok(log.events[0].at);
});

test("settings: portfolios that already have journals appear in the tracked list with hourly updates on", async () => {
  const { readSettings } = await import("../src/journal.js");
  const settings = await readSettings();
  assert.equal(settings.hourly, true);
  assert.equal(settings.tracked["you-wang--first-portfolio"].name, "First Portfolio");
  assert.equal(settings.tracked["you-wang--first-portfolio"].hourly, true);
});

test("journal page: serves the page and the data API; starting twice returns the same address", async () => {
  const url = await startDashboard();
  assert.equal(url, "http://127.0.0.1:6499/");
  assert.equal(await startDashboard(), url);
  const html = await (await fetch(url)).text();
  assert.match(html, /Portfolio Journal/);
  const version = await (await fetch(url + "api/version")).json();
  assert.equal(version.app, "umushroom-journal");
  assert.ok(version.version > 0);
  const list = await (await fetch(url + "api/portfolios")).json();
  assert.equal(list[0].id, "you-wang--first-portfolio");
  const one = await (await fetch(url + "api/portfolio?id=you-wang--first-portfolio")).json();
  assert.equal(one.latest.holdings.length, 2);
  assert.equal((await fetch(url + "api/portfolio?id=nope")).status, 404);
});

test("journal page: shows holdings, pending orders, history and activity in the browser", async () => {
  const url = await startDashboard();
  const view = await browser.newPage();
  await view.goto(url);
  await view.getByText("Micron Technology Inc").first().waitFor();
  const text = await view.locator("main").innerText();
  for (const expected of ["First Portfolio", "999,998.11", "Holdings", "Pending orders", "Buy", "Transaction history", "Cash Increase", "Activity", "Submitted"]) {
    assert.ok(text.includes(expected), `the page should contain: ${expected}`);
  }
  assert.equal(await view.locator(".chg.up").first().innerText(), "▲ +1.15%");
  await view.close();
});
