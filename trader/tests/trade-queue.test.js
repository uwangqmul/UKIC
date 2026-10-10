// Entry-point tests (tradeUmushroom, used by MCP and the command line): parallel calls run one at a time,
// orders go through the order lock, and the journal records whether the stock is still pending.
// Uses a headless Chrome + the mock site (tests/fixtures/mock-site.js); journals go to a temp folder and the real site is never contacted.
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORIGIN, SELL_PORTFOLIO_PATH, routeMockSite } from "./fixtures/mock-site.js";

// Must be set before src/ is loaded: temporary project Chrome profile, headless, temporary journal folder, separate port
const temp = await mkdtemp(join(tmpdir(), "umushroom-queue-"));
Object.assign(process.env, {
  MCP_CHROME_MODE: "profile", MCP_HEADLESS: "true", MCP_SLOW_MO: "0", MCP_LOG_OPEN: "off",
  MCP_CHROME_FALLBACK_DIR: join(temp, "chrome"), MCP_LOG_DIR: join(temp, "logs"), MCP_LOG_PORT: "6495",
});
const { tradeUmushroom, logPortfolio, closeUmushroom } = await import("../src/umushroom.js");
const { getWorkerPage } = await import("../src/browser.js");
const { readPortfolioLog } = await import("../src/journal.js");

let orders;
before(async () => {
  const worker = await getWorkerPage(); // opens the session; the mock routes apply to every tab of the context
  orders = await routeMockSite(worker.context());
});
after(async () => {
  await closeUmushroom();
  await rm(temp, { recursive: true, force: true });
});

test("parallel trades (e.g. parallel MCP tool calls) run one after another and each sends the right order", { timeout: 180_000 }, async () => {
  const [a, b, c] = await Promise.all([
    tradeUmushroom("buy", { company: "AAPL", portfolio: "First Portfolio", shares: 1, submit: true }),
    tradeUmushroom("buy", { company: "MSFT", portfolio: "Second portfolio", shares: 2, submit: true }),
    tradeUmushroom("sell", { company: "GOOG", portfolio: ORIGIN + SELL_PORTFOLIO_PATH, shares: 1, submit: true }),
  ]);
  assert.deepEqual([a.submitted, b.submitted, c.submitted], [true, true, true]);
  assert.deepEqual(orders, [
    { side: "buy", ticker: "AAPL", portfolio: "First Portfolio", portfolioIndex: 0, shares: 1 },
    { side: "buy", ticker: "MSFT", portfolio: "Second portfolio", portfolioIndex: 1, shares: 2 },
    { side: "sell", ticker: "GOOG", shares: 1 },
  ]);
});

test("journal: a submitted buy records whether the stock is still a pending order", { timeout: 120_000 }, async () => {
  // In the mock First Portfolio, Apple is listed under Pending Orders (market closed)
  const r = await tradeUmushroom("buy", { company: "AAPL", portfolio: "First Portfolio", shares: 1, submit: true });
  assert.equal(r.log.ok, true);
  assert.equal(r.log.pendingOrdersForStock, 1);
  const { events } = await readPortfolioLog("you-wang--first-portfolio");
  assert.match(events.at(-1).fillStatus, /^pending/);
});

test("a locked stock is refused through the entry point too, and a journal snapshot can run alongside trades", { timeout: 120_000 }, async () => {
  await writeFile(join(process.env.MCP_LOG_DIR, "order-locks.json"), JSON.stringify({ "msft-microsoft": { state: "unconfirmed", side: "buy", at: "x" } }));
  const before = orders.length;
  const [locked, snapshot] = await Promise.allSettled([
    tradeUmushroom("buy", { company: "MSFT", portfolio: "First Portfolio", shares: 1, submit: true }),
    logPortfolio({ portfolio: "First Portfolio", open: false }),
  ]);
  assert.equal(locked.status, "rejected");
  assert.equal(locked.reason.code, "ORDER_LOCKED");
  assert.equal(snapshot.status, "fulfilled", String(snapshot.reason));
  assert.equal(orders.length, before);
});
