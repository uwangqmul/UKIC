// Several orders in one tab (src/trade.js runOrders): same page throughout, the logo brings it home between orders,
// every order keeps its own checks, and a stop request skips the orders not started yet. Local mock site only.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ORIGIN, SELL_PORTFOLIO_PATH, routeMockSite } from "./fixtures/mock-site.js";

// Must be set before src/ is loaded: locks go to a temp folder
const logDir = await mkdtemp(join(tmpdir(), "batch-"));
process.env.MCP_LOG_DIR = logDir;
const { runOrders } = await import("../src/trade.js");
const { orderGuard, clearLocks } = await import("../src/order-lock.js");

let browser, page, orders, homeVisits;
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
  homeVisits = 0;
  await clearLocks("all");
  await page?.context().close();
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await routeMockSite(context, orders);
  page.on("framenavigated", (f) => { if (f === page.mainFrame() && new URL(f.url()).pathname === "/") homeVisits += 1; });
  await page.goto(`${ORIGIN}/en/my-overview`);
});

const SELL_URL = ORIGIN + SELL_PORTFOLIO_PATH;

test("batch: three orders in one tab, home via the logo between them, each with its own result", async () => {
  const seen = [];
  const results = await runOrders(page, [
    { action: "buy", company: "Apple", portfolio: "First Portfolio", shares: 1, submit: true },
    { action: "buy", company: "AAPL", portfolio: "First Portfolio", weight: 0.5 },
    { action: "sell", company: "Alphabet Inc Class C", portfolio: SELL_URL, shares: 1 },
  ], { guard: orderGuard, onResult: (r) => seen.push(r.index) });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(results[0].submitted, true);
  assert.equal(orders.length, 1, "only the first order was submitted");
  assert.equal(parseFloat(results[1].result.preview.expectedWeight), 0.5);
  assert.equal(results[2].ok, true, results[2].error);
  assert.equal(homeVisits, 2, "the logo took the page home between the orders");
});

test("batch: a failing order does not stop the next one", async () => {
  const results = await runOrders(page, [
    { action: "buy", company: "Nvidea", portfolio: "First Portfolio", shares: 1 },
    { action: "buy", company: "AAPL", portfolio: "First Portfolio", shares: 1 },
  ], { guard: orderGuard });
  assert.equal(results[0].ok, false);
  assert.ok(results[0].error, "the failed order reports why");
  assert.equal(results[1].ok, true);
});

test("batch: a stop request skips the orders not started yet", async () => {
  let stop = false;
  const results = await runOrders(page, [
    { action: "buy", company: "AAPL", portfolio: "First Portfolio", shares: 1 },
    { action: "buy", company: "AAPL", portfolio: "First Portfolio", shares: 2 },
  ], { guard: orderGuard, onResult: () => { stop = true; }, shouldStop: () => stop });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].skipped, true);
});
