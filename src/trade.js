// =============================================================================
// Buy / sell (UMushroom paper portfolios)
// -----------------------------------------------------------------------------
// The page flows were verified on 2026-09-27 on the real logged-in site, including real (paper) orders:
//   Buy:  search the company -> /en/equity/<slug> -> "Add to portfolio" -> choose portfolio -> shares/amount -> Add
//   Sell: open the portfolio -> the holding row under Investments -> Sell -> shares -> Sell
//   After submitting, the popup shows "Order placed" + Done; while the market is closed the order goes to Pending Orders and fills at the open.
// Preview only by default (fill the form, read the values back, close the popup, do not submit); submit=true clicks the final button.
// All functions take a Playwright page, so they can be tested against a local mock site (tests/buy.test.js).
// =============================================================================
import { TIMEOUTS } from "./config.js";
import { ORIGIN, PROFILE_URL, SELECTORS as S } from "./site.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Company-name suffixes to ignore, so "Apple Inc." and "Apple" count as the same company. */
const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|ag|sa|se|nv|holdings?|group|class [a-z])\b\.?/gi;
/** Normalise a company name: lower case, no punctuation, no Inc/Corp-style suffixes. */
const norm = (s) => String(s ?? "").toLowerCase().replace(/[.,]/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
/** Extract the number from text such as "USD 1,082.28"; returns null if there is none. */
const num = (s) => { const n = Number(String(s ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };

/** Validate order parameters: exactly one of shares or amount, and it must be greater than 0 (sell also accepts "all"). */
function checkOrder({ shares, amount }) {
  if ((shares == null) === (amount == null)) throw new Error("Provide exactly one of shares or amount.");
  const v = shares ?? amount;
  if (v !== "all" && !(Number(v) > 0)) throw new Error("Shares/amount must be a number greater than 0.");
}

// ---------------------------------------------------------------------------
// Page actions
// ---------------------------------------------------------------------------

/**
 * Find the security page of a company with the site search. company can be a name (Apple) or a ticker (AAPL).
 * Only Equity results count; match priority: exact ticker > same name > name starts with it > shortest name.
 * If the name is ambiguous (e.g. "App") and matches several equities, throw and ask for the ticker.
 */
export async function findEquity(page, company) {
  // Below roughly 1280px window width (e.g. side by side with the journal) the top search box is hidden, so use the site's Ctrl+K shortcut.
  const trigger = page.locator(S.searchTrigger).first();
  if (await trigger.isVisible().catch(() => false)) await trigger.click();
  else await page.keyboard.press("Control+k");
  const input = page.getByPlaceholder("Search").last();
  await input.waitFor({ state: "visible" });
  await input.fill(company);
  const results = page.locator(S.searchResult);
  await results.first().waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(800); // let the search results settle
  const candidates = await results.evaluateAll((els) => els.map((a) => ({
    href: a.getAttribute("href"),
    type: a.querySelector(".type")?.textContent.trim(),
    ticker: a.querySelector(".name small")?.textContent.replace("|", "").trim() ?? "",
    name: (a.querySelector(".name")?.childNodes[0]?.textContent ?? a.textContent).trim(),
  })));
  await page.keyboard.press("Escape").catch(() => {});
  const equities = candidates.filter((c) => /^equity$/i.test(c.type) && c.href?.startsWith("/en/equity/"));
  if (!equities.length) throw new Error(`Searching "${company}" found no Equity results.`);
  const q = norm(company);
  const scored = equities.map((c) => ({
    ...c,
    score: c.ticker.toLowerCase() === company.toLowerCase() ? 3 : norm(c.name) === q ? 2 : norm(c.name).startsWith(q + " ") ? 1 : 0,
  })).sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  const best = scored[0];
  if (best.score === 0 && equities.length > 1) {
    throw new Error(`"${company}" matches several equities, please use the ticker: ` + equities.map((e) => `${e.name} (${e.ticker})`).join(", "));
  }
  return { ...best, url: ORIGIN + best.href, alternatives: scored.slice(1).map(({ name, ticker }) => `${name} (${ticker})`) };
}

/** Read the current values of a trade popup (price, shares, amount, weight, available cash, notices and errors). */
async function readPopup(popup) {
  const text = async (sel) => (await popup.locator(sel).first().textContent().catch(() => ""))?.trim() ?? "";
  const val = async (sel) => popup.locator(sel).first().inputValue().catch(() => "");
  const metrics = await popup.locator(".trade-metric").evaluateAll((els) =>
    Object.fromEntries(els.map((e) => [e.querySelector("span")?.childNodes[0]?.textContent.trim(), e.querySelector("strong")?.textContent.trim()])));
  return {
    instrument: await text(".trade-overview h5"),
    marketPrice: await text(".trade-summary strong"),
    portfolio: (await text(".portfolio-select-value")) || (await text(".readonly p")),
    shares: num(await val(S.sharesInput)),
    estimatedAmount: await val(S.amountInput),
    expectedWeight: await val(S.weightInput),
    metrics,
    notice: await text(".market-price-info p"),
    errors: (await popup.locator(".error, .field-error, .error-message").allTextContents()).map((t) => t.trim()).filter(Boolean),
  };
}

/** Type the number of shares or the amount into the popup. */
async function fillOrder(popup, { shares, amount }) {
  const target = popup.locator(shares != null ? S.sharesInput : S.amountInput).first();
  // The site only recalculates amount/weight on real key presses (fill() does not trigger it), so type character by character.
  await target.click();
  await target.press("Control+A");
  await target.press("Backspace");
  await target.pressSequentially(String(shares ?? amount), { delay: 60 });
  await target.press("Tab");
  await popup.page().waitForTimeout(800);
}

/**
 * Choose the portfolio in the buy popup's drop-down. Portfolios with the same name are told apart by portfolioIndex (1-based).
 * Without a portfolio the popup's default selection is kept.
 */
async function choosePortfolio(popup, portfolio, portfolioIndex) {
  const select = popup.locator(S.portfolioSelect).first();
  const current = (await select.locator(".portfolio-select-value").textContent()).trim();
  if (!portfolio || (current === portfolio && portfolioIndex == null)) return current;
  await select.click();
  const options = popup.locator(S.portfolioOption);
  await options.first().waitFor({ state: "visible" });
  const names = (await options.evaluateAll((els) => els.map((e) => e.querySelector("span")?.textContent.trim())));
  const matches = names.map((n, i) => [n, i]).filter(([n]) => n?.toLowerCase() === portfolio.toLowerCase());
  if (!matches.length) throw new Error(`No portfolio named "${portfolio}". Available: ${names.join(", ")}`);
  if (matches.length > 1 && portfolioIndex == null) {
    throw new Error(`${matches.length} portfolios are named "${portfolio}"; use portfolioIndex (1-based) to pick one.`);
  }
  const [, index] = matches[(portfolioIndex ?? 1) - 1] ?? [];
  if (index == null) throw new Error(`portfolioIndex is out of range (there are ${matches.length} portfolios with that name).`);
  await options.nth(index).click();
  await popup.page().waitForTimeout(600);
  return (await select.locator(".portfolio-select-value").textContent()).trim();
}

/** Click the final Add / Sell button and wait for the site to confirm success (returns the confirmation text). */
async function submitAndConfirm(page, popup) {
  const button = popup.locator(S.submit).first();
  if (await button.isDisabled()) throw new Error("The submit button is disabled: check the shares, amount or available cash.");
  await button.click();
  // After a successful submit the popup either closes or switches to an "Order placed" + Done confirmation.
  const done = popup.getByRole("button", { name: /^done$/i });
  const outcome = await Promise.race([
    popup.waitFor({ state: "hidden", timeout: 20_000 }).then(() => "closed"),
    done.waitFor({ state: "visible", timeout: 20_000 }).then(() => "confirmed"),
  ]).catch(() => "timeout");
  if (outcome === "timeout") {
    const text = (await popup.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error("No success confirmation within 20 seconds of submitting; please check the order status on the page. Popup text: " + text);
  }
  const messages = [];
  if (outcome === "confirmed") {
    messages.push((await popup.innerText()).replace(/\s+/g, " ").trim());
    await done.click();
    await popup.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  }
  const toast = await page.locator('.toast, .notification, [role="status"], [role="alert"]').allTextContents().catch(() => []);
  return messages.concat(toast.map((t) => t.trim()).filter(Boolean).slice(0, 3));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Buy: add shares of a company to the given portfolio.
 * Flow: search the company -> security page "Add to portfolio" -> choose portfolio -> shares or amount -> (when submit) Add.
 * Returns { action, company, equity, portfolio, preview, submitted, messages? }.
 */
export async function buyStock(page, { company, portfolio, portfolioIndex, shares, amount, submit = false }) {
  checkOrder({ shares, amount });
  if (shares === "all") throw new Error("Buying does not support shares=all.");
  const equity = await findEquity(page, company);
  await page.goto(equity.url, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  await page.locator(S.addToPortfolio).first().click({ timeout: 20_000 });
  const popup = page.locator(S.buyPopup).first();
  await popup.waitFor({ state: "visible" });
  await popup.locator(S.existingTab).filter({ hasText: /existing/i }).first().click().catch(() => {});
  const chosen = await choosePortfolio(popup, portfolio, portfolioIndex);
  await fillOrder(popup, { shares, amount });
  const preview = await readPopup(popup);
  const result = { action: "buy", company, equity: { name: equity.name, ticker: equity.ticker, url: equity.url, alternatives: equity.alternatives }, portfolio: chosen, preview, submitted: false };
  if (preview.errors.length) throw Object.assign(new Error("The form reports: " + preview.errors.join("; ")), { result });
  if (!submit) { await popup.locator(S.popupClose).first().click().catch(() => {}); return result; }
  result.messages = await submitAndConfirm(page, popup);
  result.submitted = true;
  return result;
}

/**
 * Read all portfolios (personal and team) listed on My profile, de-duplicated by URL.
 * Returns [{ name, href, url, index }]; index is the 1-based position among portfolios with the same name.
 */
export async function readProfilePortfolios(page) {
  await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  const list = page.locator(S.portfolios);
  await list.waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(S.portfolios + ' .items[aria-busy="false"]').waitFor({ timeout: 20_000 }).catch(() => {});
  const cards = await list.locator(S.portfolioLinks).evaluateAll((els) =>
    els.map((e) => ({ name: (e.getAttribute("aria-label") || e.querySelector("h5")?.textContent || e.textContent || "").trim(), href: e.getAttribute("href") })));
  const seen = new Map();
  for (const c of cards) if (c.href && !seen.has(c.href)) seen.set(c.href, c);
  const count = new Map();
  return [...seen.values()].map((c) => {
    const key = c.name.toLowerCase();
    count.set(key, (count.get(key) ?? 0) + 1);
    return { ...c, url: ORIGIN + c.href, index: count.get(key) };
  });
}

/** Resolve a portfolio name to its URL (looked up in the My profile list); a URL is returned as is. */
export async function resolvePortfolioUrl(page, portfolio, portfolioIndex) {
  if (/^https:\/\/umushroom\.com\//.test(portfolio)) return portfolio;
  const all = await readProfilePortfolios(page);
  const matches = all.filter((c) => c.name.toLowerCase() === portfolio.toLowerCase());
  if (!matches.length) throw new Error(`Portfolio "${portfolio}" was not found on My profile. Found: ${all.map((c) => c.name).join(", ")}`);
  if (matches.length > 1 && portfolioIndex == null) throw new Error(`${matches.length} portfolios are named "${portfolio}"; use portfolioIndex to pick one.`);
  return ORIGIN + matches[(portfolioIndex ?? 1) - 1].href;
}

/**
 * Sell: sell a company's holding in the given portfolio. shares may be "all" (sell everything).
 * Flow: open the portfolio -> All tab under Investments -> holding row Sell -> shares -> (when submit) Sell.
 * Shares bought while the market is closed stay in Pending Orders and cannot be sold yet.
 */
export async function sellStock(page, { company, portfolio, portfolioIndex, shares, amount, submit = false }) {
  checkOrder({ shares, amount });
  if (!portfolio) throw new Error("Selling requires a portfolio (name or URL).");
  const url = await resolvePortfolioUrl(page, portfolio, portfolioIndex);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  await page.locator(".holdings-workspace").first().waitFor({ state: "visible", timeout: 20_000 });
  // When there are pending orders the page opens on the "Pending Orders" tab and hides the holdings; switch back to "All".
  const allTab = page.locator(S.holdings).filter({ hasText: /^\s*All(?![a-z])/i }).first();
  if (await allTab.isVisible().catch(() => false)) {
    await allTab.click();
    await page.waitForTimeout(800);
  }
  const rows = page.locator(S.holdingRow);
  await rows.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const holdings = await rows.evaluateAll((els) => els.map((r) => ({
    name: r.querySelector("h5.title")?.textContent.trim(),
    href: r.querySelector('a[href*="/equity/"], a[href]')?.getAttribute("href"),
    shares: r.querySelector(".shares span")?.textContent.trim(),
  })));
  const q = norm(company);
  const index = holdings.findIndex((h) => norm(h.name) === q || norm(h.name).startsWith(q + " ") ||
    h.href?.toLowerCase().includes(`/${company.toLowerCase()}-`));
  if (index < 0) {
    throw new Error(`The portfolio has no "${company}" holding (if the order was just placed while the market is closed it may still be pending). Current holdings: ` +
      (holdings.map((h) => `${h.name} ${h.shares}`).join(", ") || "none"));
  }
  await rows.nth(index).locator(S.holdingSell).click();
  const popup = page.locator(S.sellPopup).first();
  await popup.waitFor({ state: "visible" });
  // The available shares load a moment after the popup opens; poll until a non-zero value appears (up to about 6 seconds).
  let available = 0;
  for (let i = 0; i < 12 && !(available > 0); i += 1) {
    available = num((await readPopup(popup)).metrics["Available shares"]) ?? 0;
    if (!(available > 0)) await page.waitForTimeout(500);
  }
  if (shares === "all") shares = available;
  if (shares != null && available != null && Number(shares) > available) {
    await popup.locator(S.popupClose).first().click().catch(() => {});
    throw new Error(`You can sell at most ${available} shares.`);
  }
  await fillOrder(popup, { shares, amount });
  const preview = await readPopup(popup);
  const result = { action: "sell", company, holding: holdings[index], portfolioUrl: url, preview, submitted: false };
  if (preview.errors.length) throw Object.assign(new Error("The form reports: " + preview.errors.join("; ")), { result });
  if (!submit) { await popup.locator(S.popupClose).first().click().catch(() => {}); return result; }
  result.messages = await submitAndConfirm(page, popup);
  result.submitted = true;
  return result;
}
