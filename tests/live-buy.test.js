// Real-site buy test (skipped by default). Opens UMushroom with the logged-in project Chrome
// and runs the buy flow for Apple. Preview only by default; set UMUSHROOM_LIVE_SUBMIT=1 to really buy in the paper portfolio.
// Run (PowerShell):
//   $env:UMUSHROOM_LIVE='1'; npm run test:live
//   $env:UMUSHROOM_LIVE='1'; $env:UMUSHROOM_LIVE_SUBMIT='1'; npm run test:live
// Optional: $env:UMUSHROOM_TEST_PORTFOLIO='First Portfolio'; close the Chrome window opened by the project before running.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const LIVE = process.env.UMUSHROOM_LIVE === "1";
const SUBMIT = process.env.UMUSHROOM_LIVE_SUBMIT === "1";
const PORTFOLIO = process.env.UMUSHROOM_TEST_PORTFOLIO || "First Portfolio";
process.env.MCP_CHROME_MODE ||= "profile";

let closeUmushroom;
after(async () => { await closeUmushroom?.().catch(() => {}); });

test(`real site: buy 1 share of Apple in ${PORTFOLIO} (${SUBMIT ? "submit" : "preview only"})`, { skip: !LIVE && "set UMUSHROOM_LIVE=1 to run", timeout: 180_000 }, async () => {
  const mod = await import("../src/umushroom.js");
  closeUmushroom = mod.closeUmushroom;
  const r = await mod.tradeUmushroom("buy", { company: "Apple", portfolio: PORTFOLIO, shares: 1, submit: SUBMIT });
  console.log(JSON.stringify(r, null, 2));
  assert.equal(r.equity.ticker, "AAPL");
  assert.equal(r.portfolio, PORTFOLIO);
  assert.equal(r.preview.shares, 1);
  const price = Number(r.preview.marketPrice.replace(/[^0-9.]/g, ""));
  const amount = Number(r.preview.estimatedAmount.replace(/[^0-9.]/g, ""));
  assert.ok(price > 0, "the market price should be read");
  assert.ok(Math.abs(amount - price) < 0.02, `the estimated amount for 1 share (${amount}) should equal the market price (${price})`);
  assert.deepEqual(r.preview.errors, []);
  assert.equal(r.submitted, SUBMIT);
  if (SUBMIT) assert.ok(r.messages.some((m) => /order placed/i.test(m)), "Order placed should be shown after submitting");
});
