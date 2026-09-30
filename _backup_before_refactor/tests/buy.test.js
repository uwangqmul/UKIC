// Buy (buyStock) test cases.
// Uses Playwright to intercept requests to https://umushroom.com and return local pages modeled on the real page structure
// (verified 2026-09-27), so no sign-in is needed, the real site is never contacted and no real order is placed.
// Run: npm test
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { buyStock } from "../src/umushroom-trade.js";

const ORIGIN = "https://umushroom.com";
const EQUITIES = [
  { name: "Apple Hospitality REIT Inc", ticker: "APLE", slug: "aple-apple-hospitality-reit", price: 11.52 },
  { name: "Apple Inc", ticker: "AAPL", slug: "aapl-apple", price: 341.07 },
  { name: "Microsoft Corp", ticker: "MSFT", slug: "msft-microsoft", price: 512.3 },
];
const PORTFOLIOS = ["First Portfolio", "Second portfolio", "My portfolio", "My portfolio"];

// ---------- Mock pages ----------
const shell = (body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>UMushroom</title></head>
<body><header><button class="search-modal-trigger">Search</button></header>${body}
<div id="search-modal" hidden><input placeholder="Search"><div class="results"></div></div>
<script>
const EQUITIES = ${JSON.stringify(EQUITIES)};
const modal = document.getElementById("search-modal");
document.querySelector(".search-modal-trigger").onclick = () => { modal.hidden = false; modal.querySelector("input").focus(); };
modal.querySelector("input").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  // The real site returns a mix of portfolios, users and equities; mix in a Portfolio result here too
  const items = [{ name: "Apple", type: "Portfolio", href: "/en/profile/x/portfolio/apple" },
    ...EQUITIES.map((x) => ({ name: x.name, ticker: x.ticker, type: "Equity", href: "/en/equity/" + x.slug }))]
    .filter((x) => x.name.toLowerCase().includes(q) || (x.ticker || "").toLowerCase() === q);
  modal.querySelector(".results").innerHTML = items.map((x) =>
    '<a class="suggestion" role="option" href="' + x.href + '"><span class="name">' + x.name +
    (x.ticker ? ' <small>| ' + x.ticker + '</small>' : '') + '</span><span class="type">' + x.type + '</span></a>').join("");
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.hidden = true; });
${script}
</script></body></html>`;

function equityPage(eq) {
  const options = PORTFOLIOS.map((p, i) => `<a role="option" data-i="${i}"><span>${p}</span></a>`).join("");
  const popup = `<div class="popup-box white-box relative security-trade-popup security-buy-popup equity" hidden>
    <div class="head"><h4 class="title">Add to portfolio</h4><a class="close" role="button" aria-label="Close popup">x</a></div>
    <div class="security-trade fields">
      <div class="trade-overview"><h5>${eq.name}</h5><div class="trade-summary"><span>Market price</span><strong>USD ${eq.price}</strong></div></div>
      <div class="tabs-nav" role="tablist"><button role="tab" class="tab-btn active">Add to existing portfolio</button><button role="tab" class="tab-btn">Create New Portfolio</button></div>
      <div class="custom-select" role="combobox" tabindex="0"><span class="portfolio-select-value">First Portfolio</span>
        <div class="select-dropdown" role="listbox" hidden>${options}</div></div>
      <div class="cash-info trade-metrics">
        <div class="trade-metric"><span class="metric-label">Cash available to buy <button type="button">i</button></span><strong>USD 800,000.02</strong></div>
        <div class="trade-metric"><span class="metric-label">Credit margin (10%) <button type="button">i</button></span><strong>USD 99,999.81</strong></div>
      </div>
      <div class="share-stepper"><button type="button">-</button><input type="text" inputmode="decimal" value="1"><button type="button">+</button></div>
      <div class="amount-control"><span class="currency-text">USD</span><input type="text" value="${eq.price}"></div>
      <div class="weight-input-row"><input type="text" value="0.03%"></div>
      <div class="market-price-info"><p>The market is currently closed. This order is pending and will be executed when the market is open.</p></div>
      <div class="field-errors"></div>
      <button class="trade-primary-action transition"><span>Add</span></button>
    </div>
    <div class="success" hidden><span>BUY</span><h3>Order placed</h3><button type="button">Done</button></div>
  </div>`;
  const script = `
const PRICE = ${eq.price}, TOTAL = 1000000;
const popup = document.querySelector(".security-buy-popup");
const shares = popup.querySelector(".share-stepper input"), amount = popup.querySelector(".amount-control input"), weight = popup.querySelector(".weight-input-row input");
const select = popup.querySelector(".custom-select"), dropdown = popup.querySelector(".select-dropdown");
const fmt = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const errors = popup.querySelector(".field-errors");
function update(from) {
  errors.innerHTML = "";
  if (from === "shares") amount.value = fmt(Number(shares.value) * PRICE);
  else shares.value = String(+(Number(amount.value.replace(/,/g, "")) / PRICE).toFixed(4));
  const value = Number(shares.value) * PRICE;
  weight.value = (value / TOTAL * 100).toFixed(2) + "%";
  if (value > 800000.02 + 99999.81) errors.innerHTML = '<p class="error">Insufficient cash</p>';
}
// Same as the real site: recalculates only on keyboard input (keyup); a programmatic fill() does not trigger it
shares.addEventListener("keyup", () => update("shares"));
amount.addEventListener("keyup", () => update("amount"));
document.querySelector(".add-to-portfolio").onclick = () => { popup.hidden = false; };
popup.querySelector(".close").onclick = () => { popup.hidden = true; };
select.onclick = (e) => {
  const opt = e.target.closest('[role="option"]');
  if (opt) { select.querySelector(".portfolio-select-value").textContent = opt.textContent; select.dataset.index = opt.dataset.i; dropdown.hidden = true; }
  else dropdown.hidden = !dropdown.hidden;
};
popup.querySelector(".trade-primary-action").onclick = async () => {
  await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    side: "buy", ticker: "${eq.ticker}", portfolio: select.querySelector(".portfolio-select-value").textContent,
    portfolioIndex: Number(select.dataset.index ?? 0), shares: Number(shares.value) }) });
  popup.querySelector(".security-trade").hidden = true;
  popup.querySelector(".success").hidden = false;
};
popup.querySelector(".success button").onclick = () => { popup.hidden = true; };`;
  return shell(`<main><h1>${eq.name}</h1><button class="add-to-portfolio primary-add">Add to portfolio</button>${popup}</main>`, script);
}

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
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/orders") {
      orders.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    const eq = EQUITIES.find((x) => url.pathname === `/en/equity/${x.slug}`);
    return route.fulfill({ status: 200, contentType: "text/html", body: eq ? equityPage(eq) : shell("<main>Overview</main>") });
  });
  await page.goto(`${ORIGIN}/en/my-overview`);
});

const popupHidden = () => page.locator(".security-buy-popup").isHidden();

// ---------- Test cases ----------
test("buy preview: the company name Apple finds Apple Inc, 1 share, preview only without submitting", async () => {
  const r = await buyStock(page, { company: "Apple", portfolio: "First Portfolio", shares: 1 });
  assert.equal(r.submitted, false);
  assert.equal(r.equity.ticker, "AAPL");
  assert.equal(r.equity.name, "Apple Inc");
  assert.ok(r.equity.alternatives.some((x) => x.includes("APLE")), "the excluded same-name candidates should be listed");
  assert.equal(r.portfolio, "First Portfolio");
  assert.equal(r.preview.shares, 1);
  assert.equal(r.preview.estimatedAmount, "341.07");
  assert.equal(r.preview.marketPrice, "USD 341.07");
  assert.equal(r.preview.metrics["Cash available to buy"], "USD 800,000.02");
  assert.equal(orders.length, 0, "a preview must not place an order");
  assert.ok(await popupHidden(), "the popup should be closed after previewing");
});

test("buy: search by the ticker AAPL", async () => {
  const r = await buyStock(page, { company: "AAPL", portfolio: "First Portfolio", shares: 3 });
  assert.equal(r.equity.ticker, "AAPL");
  assert.equal(r.preview.shares, 3);
  assert.equal(r.preview.estimatedAmount, "1,023.21");
});

test("buy: ordering by amount is converted into shares (checks that keyboard input triggered the page recalculation)", async () => {
  const r = await buyStock(page, { company: "Apple", portfolio: "First Portfolio", amount: 1000 });
  assert.equal(r.preview.shares, 2.9319);
  assert.equal(r.preview.expectedWeight, "0.10%");
});

test("buy submit: confirms Order placed, clicks Done and sends the right order", async () => {
  const r = await buyStock(page, { company: "Apple", portfolio: "First Portfolio", shares: 2, submit: true });
  assert.equal(r.submitted, true);
  assert.ok(r.messages.some((m) => /Order placed/i.test(m)), "the success message should be read");
  assert.deepEqual(orders, [{ side: "buy", ticker: "AAPL", portfolio: "First Portfolio", portfolioIndex: 0, shares: 2 }]);
  assert.ok(await popupHidden(), "the popup should be closed after clicking Done");
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
  assert.equal(orders[0].portfolioIndex, 3, "the second My portfolio (4th dropdown option) should be selected");
});

test("buy: a missing portfolio raises an error listing the available portfolios and places no order", async () => {
  await assert.rejects(buyStock(page, { company: "Apple", portfolio: "Nope", shares: 1, submit: true }), /First Portfolio/);
  assert.equal(orders.length, 0);
});

test("buy: insufficient cash is read as a form error and nothing is submitted", async () => {
  await assert.rejects(buyStock(page, { company: "Apple", portfolio: "First Portfolio", shares: 5000, submit: true }), /Insufficient cash/);
  assert.equal(orders.length, 0);
});

test("buy: argument validation", async () => {
  await assert.rejects(buyStock(page, { company: "Apple", shares: 1, amount: 100 }), /exactly one of/);
  await assert.rejects(buyStock(page, { company: "Apple" }), /exactly one of/);
  await assert.rejects(buyStock(page, { company: "Apple", shares: 0 }), /greater than 0/);
  await assert.rejects(buyStock(page, { company: "Apple", shares: "all" }), /does not support/);
  assert.equal(orders.length, 0);
});

test("buy: an ambiguous name matching several equities requires the ticker", async () => {
  await assert.rejects(buyStock(page, { company: "App", shares: 1 }), /please use the ticker.*AAPL/);
});

test("buy: an equity that cannot be found raises an error", async () => {
  await assert.rejects(buyStock(page, { company: "Zzzz", shares: 1 }), /found no Equity|Timeout/);
});
