// Order-safety tests: strict stock matching, order locks against duplicate orders, and selling.
// Uses the mock site in tests/fixtures/mock-site.js: no login, never contacts the real site, never places a real order.
// Locks go to a temporary journal folder. Run: npm test
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ORIGIN, SELL_PORTFOLIO_PATH, routeMockSite } from "./fixtures/mock-site.js";

// Must be set before src/ is loaded: locks go to a temp folder
const logDir = await mkdtemp(join(tmpdir(), "umushroom-orders-"));
process.env.MCP_LOG_DIR = logDir;
const { buyStock, sellStock, equitySlug } = await import("../src/trade.js");
const { orderGuard, readLocks, clearLocks } = await import("../src/order-lock.js");

// ---------- Test setup ----------
let browser, page, orders;

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MCP_CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.MCP_CHROME_EXECUTABLE_PATH }
      : { channel: process.env.MCP_CHROME_CHANNEL || "chrome" }),
  });
});
after(async () => {
  await browser?.close();
  await rm(logDir, { recursive: true, force: true });
});

beforeEach(async () => {
  orders = [];
  await clearLocks("all");
  await page?.context().close();
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await routeMockSite(context, orders);
  await page.goto(`${ORIGIN}/en/my-overview`);
});

const SELL_URL = ORIGIN + SELL_PORTFOLIO_PATH;
const buy = (options) => buyStock(page, { portfolio: "First Portfolio", guard: orderGuard, ...options });
const sell = (options) => sellStock(page, { portfolio: SELL_URL, guard: orderGuard, ...options });

// ---------- Stock matching (buy) ----------
test("equitySlug: stable key from an equity address", () => {
  assert.equal(equitySlug("/en/equity/aapl-apple"), "aapl-apple");
  assert.equal(equitySlug("https://umushroom.com/en/equity/AAPL-Apple?x=1"), "aapl-apple");
  assert.equal(equitySlug("/en/profile/x/portfolio/y"), null);
});

test("buy: a single search result that does not match the name is refused (typo / alias), nothing is ordered", async () => {
  // "Micro" only finds Microsoft Corp, which is neither the ticker nor the name: it used to be bought anyway
  await assert.rejects(buy({ company: "Micro", shares: 1, submit: true }), /does not match any equity.*MSFT/);
  assert.equal(orders.length, 0);
});

test("buy: several equities matching equally well are refused instead of picking one", async () => {
  await assert.rejects(buy({ company: "Alphabet", shares: 1, submit: true }), /matches several equities equally well.*GOOGL.*GOOG/);
  assert.equal(orders.length, 0);
});

test("buy and sell: the exact full name including the share class still works", async () => {
  const r = await buy({ company: "Alphabet Inc Class A", shares: 1, submit: true });
  assert.equal(r.equity.ticker, "GOOGL");
  await page.goto(`${ORIGIN}/en/my-overview`);
  const s = await sell({ company: "Alphabet Inc Class C", shares: 1, submit: true });
  assert.equal(s.holding.name, "Alphabet Inc Class C");
  assert.deepEqual(orders.map((o) => [o.side, o.ticker]), [["buy", "GOOGL"], ["sell", "GOOG"]]);
});

test("buy: the exact ticker still picks the right share class", async () => {
  const r = await buy({ company: "GOOG", shares: 1, submit: true });
  assert.equal(r.equity.name, "Alphabet Inc Class C");
  assert.deepEqual(orders.map((o) => o.ticker), ["GOOG"]);
});

test("buy: an equity page address skips the search and takes the name from the order form", async () => {
  const r = await buy({ company: `${ORIGIN}/en/equity/aapl-apple`, shares: 1, submit: true });
  assert.equal(r.submitted, true);
  assert.equal(r.equity.name, "Apple Inc");
  assert.equal(r.confirmation, "order_placed");
  assert.deepEqual(orders.map((o) => o.ticker), ["AAPL"]);
});

test("buy: addresses that could leave /en/equity/ or respell a locked stock are not used as addresses", async () => {
  // These are not plain equity addresses, so they go to the site search, find nothing and order nothing
  for (const company of ["/en/equity/x\\..\\aapl-apple", "/en/equity/AAPL%2DApple", "/en/equity/../my-profile", "https://evil.example/en/equity/aapl-apple"]) {
    await page.goto(`${ORIGIN}/en/my-overview`);
    await assert.rejects(buy({ company, shares: 1, submit: true }), /found no Equity|does not match|Timeout/, company);
  }
  assert.equal(orders.length, 0);
});

test("buy: an order form showing another instrument is refused and nothing is ordered", async () => {
  await page.addInitScript(() => { window.__instrumentOverride = "Apple Hospitality REIT Inc"; });
  await assert.rejects(buy({ company: "AAPL", shares: 1, submit: true }), /order form shows "Apple Hospitality REIT Inc"/);
  assert.equal(orders.length, 0);
});

// ---------- ETFs / ETCs (/en/etf/ pages) ----------
const GOLD_URL = `${ORIGIN}/en/etf/amundi-physical-gold-etc-c-2`;

test("equitySlug: an ETF address gets its own key that can never equal a stock's", () => {
  assert.equal(equitySlug("/en/etf/Amundi-Physical-Gold-ETC-C-2"), "etf:amundi-physical-gold-etc-c-2");
  assert.equal(equitySlug("/en/fund/gold-sicherheit-euro-i"), null);
});

test("buy ETF: by ISIN picks the one product even when two share the ticker", async () => {
  const r = await buy({ company: "FR0013416716", shares: 2, submit: true });
  assert.equal(r.equity.name, "Amundi Physical Gold ETC C");
  assert.equal(r.equity.url, GOLD_URL);
  assert.equal(r.submitted, true);
  assert.deepEqual(orders.map((o) => [o.ticker, o.shares]), [["GOLD", 2]]);
  assert.deepEqual(await readLocks(), {});
});

test("buy ETF: a ticker shared by two ETFs is refused and both are listed", async () => {
  await assert.rejects(buy({ company: "GOLD", shares: 1, submit: true }), /matches several equities equally well.*Amundi Physical Gold.*EUWAX Gold|matches several equities equally well.*EUWAX Gold.*Amundi Physical Gold/);
  assert.equal(orders.length, 0);
});

test("buy ETF: by page address (skips the search); Fund results and /en/fund/ addresses are never bought", async () => {
  const r = await buy({ company: GOLD_URL, shares: 1, submit: true });
  assert.equal(r.equity.name, "Amundi Physical Gold ETC C");
  assert.equal(orders.length, 1);
  await page.goto(`${ORIGIN}/en/my-overview`);
  await assert.rejects(buy({ company: "Gold & Sicherheit (Euro) I", shares: 1, submit: true }), /found no Equity or ETF results/);
  await page.goto(`${ORIGIN}/en/my-overview`);
  await assert.rejects(buy({ company: "/en/fund/gold-sicherheit-euro-i", shares: 1, submit: true }), /found no Equity or ETF results|Timeout/);
  assert.equal(orders.length, 1);
});

test("buy ETF: no confirmation locks the ETF under its own key and leaves stocks unaffected", { timeout: 60_000 }, async () => {
  await page.addInitScript(() => { window.__noConfirm = true; });
  const error = await buy({ company: GOLD_URL, shares: 1, submit: true }).catch((e) => e);
  assert.equal(error.code, "ORDER_UNCONFIRMED");
  assert.deepEqual(Object.keys(await readLocks()), ["etf:amundi-physical-gold-etc-c-2"]);
  await page.goto(`${ORIGIN}/en/my-overview`);
  await assert.rejects(buy({ company: "FR0013416716", shares: 1, submit: true }), (e) => e.code === "ORDER_LOCKED");
  assert.equal(orders.length, 1);
});

test("sell ETF: found by its page address, the available units are read and checked", async () => {
  await assert.rejects(sell({ company: GOLD_URL, shares: 5, submit: true }), /at most 4 shares/);
  await page.goto(`${ORIGIN}/en/my-overview`);
  const r = await sell({ company: GOLD_URL, shares: "all", submit: true });
  assert.equal(r.submitted, true);
  assert.equal(r.holding.name, "Amundi Physical Gold ETC C");
  assert.deepEqual(orders, [{ side: "sell", ticker: "GOLD", shares: 4 }]);
});

// ---------- Order locks (duplicate orders) ----------
test("buy: no confirmation after submitting -> submitted 'unknown', stock locked, a retry is refused, previews still work", { timeout: 60_000 }, async () => {
  await page.addInitScript(() => { window.__noConfirm = true; });
  const error = await buy({ company: "AAPL", shares: 2, submit: true }).catch((e) => e);
  assert.equal(error.code, "ORDER_UNCONFIRMED");
  assert.match(error.message, /MAY have been placed: do not retry/);
  assert.equal(error.result.submitted, "unknown");
  assert.equal(orders.length, 1, "the site did receive the order");
  assert.equal((await readLocks())["aapl-apple"].state, "unconfirmed");

  // Retrying is refused before anything is filled in, so the order cannot be doubled
  await page.goto(`${ORIGIN}/en/my-overview`);
  await assert.rejects(buy({ company: "AAPL", shares: 2, submit: true }), (e) => e.code === "ORDER_LOCKED" && /npm run unlock -- aapl-apple/.test(e.message));
  assert.equal(orders.length, 1);
  // A preview places no order, so it is allowed; another stock is not affected
  await page.goto(`${ORIGIN}/en/my-overview`);
  assert.equal((await buy({ company: "AAPL", shares: 1 })).submitted, false);

  // After checking the portfolio, clearing the lock allows orders again
  assert.deepEqual(await clearLocks("aapl-apple"), ["aapl-apple"]);
  await page.evaluate(() => { window.__noConfirm = false; });
  await page.goto(`${ORIGIN}/en/my-overview`);
  await page.addInitScript(() => { window.__noConfirm = false; });
  assert.equal((await buy({ company: "AAPL", shares: 2, submit: true })).submitted, true);
  assert.deepEqual(await readLocks(), {}, "a confirmed order leaves no lock");
});

test("buy: a lock left by a process that stopped mid-order ('submitting') blocks the stock", async () => {
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, "order-locks.json"), JSON.stringify({ "msft-microsoft": { state: "submitting", side: "buy", stock: "Microsoft Corp (MSFT)", at: "2026-10-12T14:31:00Z" } }));
  await assert.rejects(buy({ company: "MSFT", shares: 1, submit: true }), /ORDER|never confirmed/);
  assert.equal(orders.length, 0);
  assert.equal((await buy({ company: "AAPL", shares: 1, submit: true })).submitted, true, "other stocks are not blocked");
});

test("a damaged lock file blocks submits (fails closed) until reset with unlock all", async () => {
  await writeFile(join(logDir, "order-locks.json"), "{ not json");
  await assert.rejects(buy({ company: "AAPL", shares: 1, submit: true }), /lock file .* is damaged/);
  assert.equal(orders.length, 0);
  assert.deepEqual(await clearLocks("all"), ["(damaged lock file)"]);
  assert.deepEqual(await readLocks(), {});
  await page.goto(`${ORIGIN}/en/my-overview`);
  assert.equal((await buy({ company: "AAPL", shares: 1, submit: true })).submitted, true);
});

test("buy: without a guard (direct low-level use) the behaviour is unchanged", async () => {
  await writeFile(join(logDir, "order-locks.json"), JSON.stringify({ "aapl-apple": { state: "unconfirmed", at: "x" } }));
  const r = await buyStock(page, { company: "AAPL", portfolio: "First Portfolio", shares: 1, submit: true });
  assert.equal(r.submitted, true);
});

// ---------- Selling ----------
test("sell: preview by ticker picks the right share class", async () => {
  const r = await sell({ company: "GOOG", shares: 2 });
  assert.equal(r.holding.name, "Alphabet Inc Class C");
  assert.equal(r.preview.shares, 2);
  assert.equal(orders.length, 0);
});

test("sell: a name matching two holdings is refused instead of selling the first row", async () => {
  await assert.rejects(sell({ company: "Alphabet", shares: 1, submit: true }), /matches several holdings.*Class A.*Class C/);
  assert.equal(orders.length, 0);
});

test("sell: a holding hidden behind 'See All' is found", async () => {
  const r = await sell({ company: "Micron", shares: 5, submit: true });
  assert.equal(r.submitted, true);
  assert.deepEqual(orders, [{ side: "sell", ticker: "MU", shares: 5 }]);
  assert.deepEqual(await readLocks(), {});
});

test("sell all: sells exactly the available shares", async () => {
  const r = await sell({ company: "GOOGL", shares: "all", submit: true });
  assert.equal(r.submitted, true);
  assert.deepEqual(orders, [{ side: "sell", ticker: "GOOGL", shares: 10 }]);
});

test("sell all with 0 shares available is refused (it used to try to sell 0)", async () => {
  await assert.rejects(sell({ company: "Tesla", shares: "all", submit: true }), /No shares of Tesla Inc are available/);
  assert.equal(orders.length, 0);
});

test("sell: more shares than available, by shares or by amount, is refused", async () => {
  await assert.rejects(sell({ company: "GOOG", shares: 6, submit: true }), /at most 5 shares/);
  await page.goto(`${ORIGIN}/en/my-overview`);
  await assert.rejects(sell({ company: "GOOG", amount: 5000, submit: true }), /at most 5 shares/); // 5000 / 251 = 19.9 shares
  assert.equal(orders.length, 0);
});

test("sell: no confirmation after submitting -> submitted 'unknown' and the stock is locked", { timeout: 60_000 }, async () => {
  await page.addInitScript(() => { window.__noConfirm = true; });
  const error = await sell({ company: "GOOGL", shares: 1, submit: true }).catch((e) => e);
  assert.equal(error.code, "ORDER_UNCONFIRMED");
  assert.equal(error.result.submitted, "unknown");
  assert.equal(orders.length, 1);
  assert.equal((await readLocks())["googl-alphabet-class-a"].state, "unconfirmed");
  await assert.rejects(sell({ company: "GOOGL", shares: 1, submit: true }), (e) => e.code === "ORDER_LOCKED");
  assert.equal(orders.length, 1);
});

test("sell: a locked stock cannot be sold until the lock is cleared", async () => {
  await writeFile(join(logDir, "order-locks.json"), JSON.stringify({ "goog-alphabet-class-c": { state: "unconfirmed", side: "buy", at: "x" } }));
  await assert.rejects(sell({ company: "GOOG", shares: 1, submit: true }), (e) => e.code === "ORDER_LOCKED");
  assert.equal(orders.length, 0);
});
