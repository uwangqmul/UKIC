// Buy (buyStock) tests.
// Uses the mock site in tests/fixtures/mock-site.js: no login, never contacts the real site, never places a real order.
// Run: npm test
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { buyStock } from "../src/trade.js";
import { ORIGIN, routeMockSite } from "./fixtures/mock-site.js";


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
after(async () => { await browser?.close(); });

beforeEach(async () => {
  orders = [];
  await page?.context().close();
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await routeMockSite(context, orders);
  await page.goto(`${ORIGIN}/en/my-overview`);
});

const popupHidden = () => page.locator(".security-buy-popup").isHidden();

// ---------- Tests ----------
test("buy preview: the name Apple finds Apple Inc, 1 share, preview only", async () => {
  const r = await buyStock(page, { company: "Apple", portfolio: "First Portfolio", shares: 1 });
  assert.equal(r.submitted, false);
  assert.equal(r.equity.ticker, "AAPL");
  assert.equal(r.equity.name, "Apple Inc");
  assert.ok(r.equity.alternatives.some((x) => x.includes("APLE")), "the excluded same-name candidate should be listed");
  assert.equal(r.portfolio, "First Portfolio");
  assert.equal(r.preview.shares, 1);
  assert.equal(r.preview.estimatedAmount, "341.07");
  assert.equal(r.preview.marketPrice, "USD 341.07");
  assert.equal(r.preview.metrics["Cash available to buy"], "USD 800,000.02");
  assert.equal(orders.length, 0, "a preview must not place an order");
  assert.ok(await popupHidden(), "the popup should be closed after a preview");
});

test("buy: with a narrow window and the top search box hidden, Ctrl+K opens the search", async () => {
  await page.addStyleTag({ content: ".search-modal-trigger { display: none !important; }" });
  const r = await buyStock(page, { company: "Apple", portfolio: "First Portfolio", shares: 1 });
  assert.equal(r.equity.ticker, "AAPL");
});

test("buy: search by the ticker AAPL", async () => {
  const r = await buyStock(page, { company: "AAPL", portfolio: "First Portfolio", shares: 3 });
  assert.equal(r.equity.ticker, "AAPL");
  assert.equal(r.preview.shares, 3);
  assert.equal(r.preview.estimatedAmount, "1,023.21");
});

test("buy: ordering by amount converts to shares (proves key presses trigger the page's recalculation)", async () => {
  const r = await buyStock(page, { company: "Apple", portfolio: "First Portfolio", amount: 1000 });
  assert.equal(r.preview.shares, 2.9319);
  assert.equal(r.preview.expectedWeight, "0.10%");
});

test("buy submit: confirms Order placed, clicks Done and sends the right order", async () => {
  const r = await buyStock(page, { company: "Apple", portfolio: "First Portfolio", shares: 2, submit: true });
  assert.equal(r.submitted, true);
  assert.ok(r.messages.some((m) => /Order placed/i.test(m)), "the success message should be read");
  assert.deepEqual(orders, [{ side: "buy", ticker: "AAPL", portfolio: "First Portfolio", portfolioIndex: 0, shares: 2 }]);
  assert.ok(await popupHidden(), "the popup should close after Done");
});

test("buy: switch to another portfolio", async () => {
  const r = await buyStock(page, { company: "Apple", portfolio: "Second portfolio", shares: 1, submit: true });
  assert.equal(r.portfolio, "Second portfolio");
  assert.equal(orders[0].portfolioIndex, 1);
});

test("buy: portfolios with the same name require portfolioIndex", async () => {
  await assert.rejects(buyStock(page, { company: "Apple", portfolio: "My portfolio", shares: 1 }), /portfolioIndex/);
  await page.goto(`${ORIGIN}/en/my-overview`);
  await buyStock(page, { company: "Apple", portfolio: "My portfolio", portfolioIndex: 2, shares: 1, submit: true });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].portfolioIndex, 3, "the second My portfolio (4th drop-down entry) should be selected");
});

test("buy: an unknown portfolio throws, lists the available ones and places no order", async () => {
  await assert.rejects(buyStock(page, { company: "Apple", portfolio: "Nope", shares: 1, submit: true }), /First Portfolio/);
  assert.equal(orders.length, 0);
});

test("buy: insufficient cash is read from the form and nothing is submitted", async () => {
  await assert.rejects(buyStock(page, { company: "Apple", portfolio: "First Portfolio", shares: 5000, submit: true }), /Insufficient cash/);
  assert.equal(orders.length, 0);
});

test("buy: parameter validation", async () => {
  await assert.rejects(buyStock(page, { company: "Apple", shares: 1, amount: 100 }), /exactly one of/);
  await assert.rejects(buyStock(page, { company: "Apple" }), /exactly one of/);
  await assert.rejects(buyStock(page, { company: "Apple", shares: 0 }), /greater than 0/);
  await assert.rejects(buyStock(page, { company: "Apple", shares: "all" }), /does not support/);
  assert.equal(orders.length, 0);
});

test("buy: an ambiguous name matching several equities asks for the ticker", async () => {
  await assert.rejects(buyStock(page, { company: "App", shares: 1 }), /please use the ticker.*AAPL/);
});

test("buy: a company with no search results throws", async () => {
  await assert.rejects(buyStock(page, { company: "Zzzz", shares: 1 }), /found no Equity|Timeout/);
});
