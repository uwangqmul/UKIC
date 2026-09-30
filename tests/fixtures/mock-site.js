// =============================================================================
// Mock UMushroom site for tests (modelled on the real page structure verified on 2026-09-27)
// -----------------------------------------------------------------------------
// routeMockSite(context) intercepts requests to https://umushroom.com and serves these pages:
//   /en/equity/<slug>                       security page (with the Add to portfolio buy popup)
//   /en/my-profile                          portfolio list
//   /en/profile/you-wang/portfolio/first-portfolio   portfolio page (summary, holdings, pending orders, History)
//   /api/orders                             mock order endpoint (recorded in the orders array)
//   anything else                           Overview with the search box
// Every page has the top search box (Ctrl+K opens it too) and search results with the same structure as the real site.
// =============================================================================

export const ORIGIN = "https://umushroom.com";
export const PORTFOLIO_PATH = "/en/profile/you-wang/portfolio/first-portfolio";
export const EQUITIES = [
  { name: "Apple Hospitality REIT Inc", ticker: "APLE", slug: "aple-apple-hospitality-reit", price: 11.52 },
  { name: "Apple Inc", ticker: "AAPL", slug: "aapl-apple", price: 341.07 },
  { name: "Microsoft Corp", ticker: "MSFT", slug: "msft-microsoft", price: 512.3 },
];
export const PORTFOLIOS = ["First Portfolio", "Second portfolio", "My portfolio", "My portfolio"];


// ---------- Top search (shared by all pages) ----------
const SEARCH_HTML = `<header><button class="search-modal-trigger">Search</button></header>`;
const SEARCH_MODAL = `<div id="search-modal" hidden><input placeholder="Search"><div class="results"></div></div>`;
const SEARCH_SCRIPT = `
const EQUITIES = ${JSON.stringify(EQUITIES)};
const modal = document.getElementById("search-modal");
document.querySelector(".search-modal-trigger").onclick = () => { modal.hidden = false; modal.querySelector("input").focus(); };
modal.querySelector("input").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  // The real site mixes portfolios, users and securities in the results; one Portfolio result is mixed in here too
  const items = [{ name: "Apple", type: "Portfolio", href: "/en/profile/x/portfolio/apple" },
    ...EQUITIES.map((x) => ({ name: x.name, ticker: x.ticker, type: "Equity", href: "/en/equity/" + x.slug }))]
    .filter((x) => x.name.toLowerCase().includes(q) || (x.ticker || "").toLowerCase() === q);
  modal.querySelector(".results").innerHTML = items.map((x) =>
    '<a class="suggestion" role="option" href="' + x.href + '"><span class="name">' + x.name +
    (x.ticker ? ' <small>| ' + x.ticker + '</small>' : '') + '</span><span class="type">' + x.type + '</span></a>').join("");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") modal.hidden = true;
  if (e.ctrlKey && e.key.toLowerCase() === "k") { modal.hidden = false; modal.querySelector("input").focus(); } // site shortcut
});
`;

/** Build a page with the top search; script is the page's own script. */
export const shell = (body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>UMushroom</title></head>
<body>${SEARCH_HTML}${body}
${SEARCH_MODAL}
<script>${SEARCH_SCRIPT}
${script}
</script></body></html>`;

/** Add the top search to a complete page. */
function withSearch(html) {
  return html.replace("<body>", `<body>${SEARCH_HTML}`).replace("</body>", `${SEARCH_MODAL}<script>${SEARCH_SCRIPT}</script></body>`);
}

/** Security page: Add to portfolio popup that recalculates the amount only on key presses and shows Order placed after submitting. */
export function equityPage(eq) {
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
// Like the real site: recalculate only on keyboard input (keyup); fill() from a script does not trigger it
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

// ---------- Portfolio list and portfolio page ----------
export const profilePage = withSearch(`<!doctype html><html><body><div class="profile-page">
  <section class="profile-primary-portfolios profile-portfolios"><div class="items" aria-busy="false">
    <a class="title-link" href="${PORTFOLIO_PATH}" aria-label="First Portfolio">First Portfolio</a>
    <a class="title-link" href="/en/profile/you-wang/portfolio/second-portfolio" aria-label="Second portfolio">Second portfolio</a>
  </div></section></div></body></html>`);

const row = (cells) => `<div class="investment relative">
  <div class="image-and-main-info"><a href="${cells.href}"><div class="main-info"><h5 class="title">${cells.name}</h5></div></a></div>
  ${cells.body}</div>`;
const cell = (cls, label, value, extra = "") => `<div class="${cls} info-cell"><span class="meta-label">${label}</span><span>${value}</span>${extra}</div>`;

export const portfolioPage = withSearch(`<!doctype html><html><body><div class="portfolio-page">
<div class="portfolio-header private"><div class="title-holder"><form class="editable-title"><input type="text" readonly value="First Portfolio"></form></div>
  <span class="meta-chip"><span class="chip-label">Currency</span><strong>USD</strong></span>
  <span class="meta-chip"><span class="chip-label">Published</span><strong>22 Sep 2026</strong></span>
  <span class="type">By <a href="/en/profile/you-wang">You Wang</a></span><span class="status-pill is-public">Public</span></div>
<div class="portfolio-summary-rail">
  <div class="summary-card primary"><span>Current value</span><strong>USD 999,998.11</strong></div>
  <div class="summary-cash-copy"><span>Cash</span><strong>USD 800,000.02</strong></div>
  <div class="summary-allocation-segment cash" data-tooltip="Cash: USD 800,000.02 (80.00%)"></div>
  <div class="summary-allocation-segment invested" data-tooltip="Invested Capital: USD 199,998.09 (20.00%)"></div>
  <div class="summary-insight performance"><div class="summary-insight-heading"><span>Performance</span></div><strong class="red">-0.00%</strong></div>
  <div class="summary-insight risk"><div class="summary-insight-heading"><span>Risk level</span></div><strong>3/10</strong></div>
  <div class="summary-insight"><div class="summary-insight-heading"><span>Sharpe</span></div><strong>-0.82</strong><div class="summary-score-scale"><p>Below risk-free return</p></div></div>
  <button class="summary-action transition"><span>History</span></button>
</div>
<section class="holdings-workspace">
  <div class="workspace-tabs">
    <button class="workspace-tab"><span>All</span><strong>2</strong></button>
    <button class="workspace-tab active"><span>Pending Orders</span><strong>1</strong></button>
  </div>
  <div id="all" hidden><div class="investments-items"><div class="investments equity"><h2>Equities</h2><div class="investments-table">
    <div class="investments-list">
      ${row({ name: "Micron Technology Inc", href: "/en/equity/mu-micron-technology", body:
        cell("added-on", "Added On", "22 Sep 2026") + cell("price", "Price", "USD 1,082.28") +
        cell("performance", "Performance since added", "-0.00%") + cell("rating", "Rating", "4.42") +
        '<div class="shares info-cell"><span>184.7933</span></div>' + cell("value", "Value", "USD 199,998.09") +
        cell("weight", "Weight", "20.00%") })}
      <div class="investment relative extra" hidden>${""}</div>
    </div>
    <button class="more-instruments-button">See All</button>
  </div></div></div></div>
  <div id="pending"><div class="pending-orders-list">
    ${row({ name: "Apple Inc", href: "/en/equity/aapl-apple", body:
      cell("execution", "Execution price on", "27 September 2026") +
      '<div class="estimated-execution info-cell"><span class="meta-label">Estimated execution</span><span class="execution-text">Pending</span><div class="execution-tooltip">waiting</div></div>' +
      cell("price", "Price", "USD 341.07") + cell("performance", "1 Year Performance", "+32.78%") +
      cell("rating", "Rating", "4.33") + cell("shares", "Shares", "1") + cell("value", "Value", "USD 341.07") +
      cell("weight", "Expected Weight", "0.03%") })}
  </div></div>
</section>
<div class="popup-box transactions-popup" hidden>
  <div class="head"><h4>History</h4><a role="button" aria-label="Close popup">x</a></div>
  <div class="transactions"><div class="content">
    <article class="transaction-card"><span class="date-chip">22 Sep 2026</span><strong class="panel-value">USD 800,000.02</strong>
      <div class="action-row"><span class="transaction-badge cash">Cash</span><span class="description">Cash Increase</span><span class="value positive">+1,000,000.00</span></div>
      <div class="action-row"><span class="transaction-badge buy">Buy</span><span class="description">Buy - 184.7933 shares Micron Technology Inc @ 1,082.29</span><span class="value negative">-199,999.98</span></div>
    </article>
  </div></div>
</div>
<script>
  const tabs = document.querySelectorAll(".workspace-tab");
  tabs[0].onclick = () => { all.hidden = false; pending.hidden = true; };
  tabs[1].onclick = () => { all.hidden = true; pending.hidden = false; };
  // The second holding only appears after "See All" is expanded (proves collapsed lists are expanded)
  document.querySelector(".more-instruments-button").onclick = (e) => {
    const extra = document.querySelector(".investment.extra");
    extra.outerHTML = ${JSON.stringify(row({ name: "Apple Inc", href: "/en/equity/aapl-apple", body:
      cell("added-on", "Added On", "28 Sep 2026") + cell("price", "Price", "USD 345.00") +
      cell("performance", "Performance since added", "+1.15%") + cell("rating", "Rating", "4.33") +
      '<div class="shares info-cell"><span>1</span></div>' + cell("value", "Value", "USD 345.00") +
      cell("weight", "Weight", "0.03%") }))};
    e.target.className = "more-instruments-button collapse"; e.target.textContent = "Show Less";
  };
  const popup = document.querySelector(".transactions-popup");
  document.querySelector(".summary-action").onclick = () => { popup.hidden = false; };
  popup.querySelector('[aria-label="Close popup"]').onclick = () => { popup.hidden = true; };
</script></div></body></html>`);

/** Intercept umushroom.com requests and serve the mock pages; orders are recorded in orders. */
export async function routeMockSite(context, orders = []) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/orders") {
      orders.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    const eq = EQUITIES.find((x) => url.pathname === `/en/equity/${x.slug}`);
    const body = eq ? equityPage(eq)
      : url.pathname === PORTFOLIO_PATH ? portfolioPage
      : url.pathname === "/en/my-profile" ? profilePage
      : shell("<main>Overview</main>");
    return route.fulfill({ status: 200, contentType: "text/html", body });
  });
  return orders;
}
