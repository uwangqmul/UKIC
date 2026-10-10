// =============================================================================
// Buy / sell (UMushroom paper portfolios)
// -----------------------------------------------------------------------------
// The page flows were verified on 2026-09-27 on the real logged-in site, including real (paper) orders:
//   Buy:  search the company -> /en/equity/<slug> (or /en/etf/<slug>) -> "Add to portfolio" -> choose portfolio -> shares/amount -> Add
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
/** Lower case with single spaces: for comparing a typed name with a displayed one exactly (share class kept). */
const exact = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
/** Extract the number from text such as "USD 1,082.28"; returns null if there is none. */
const num = (s) => { const n = Number(String(s ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };

/** Escape text for use inside a RegExp. */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Stable key of a security page address: the slug after /equity/ (e.g. aapl-apple) or "etf:" + the slug after /etf/
 * (e.g. etf:amundi-physical-gold-etc-c-2, so an ETF can never share a key with a stock); null if there is none.
 */
export function equitySlug(href) {
  const m = /\/(equity|etf)\/([^/?#]+)/i.exec(String(href ?? ""));
  if (!m) return null;
  return (m[1].toLowerCase() === "etf" ? "etf:" : "") + m[2].toLowerCase();
}

/** Security pages that can be bought: stocks (/en/equity/) and ETFs/ETCs (/en/etf/). */
const SECURITY_PATH = /^\/en\/(equity|etf)\//i;
const SECURITY_TYPE = /^(equity|etf)$/i;
/** An ISIN (e.g. FR0013416716): identifies one security exactly, so it is matched like a ticker. */
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/i;

/**
 * A company given directly as a security page address (https://umushroom.com/en/equity/<slug>, /en/etf/<slug>, or the same
 * without the domain): the full URL, else null.
 * The slug must be plain (letters, digits, "-", "_", "." and not starting with "."), so an address can neither leave /en/equity/
 * or /en/etf/ (".." / "\" / %-escapes) nor spell the same stock differently to get around its order lock.
 */
function directEquityUrl(company) {
  const m = /^(?:https:\/\/umushroom\.com)?\/en\/(equity|etf)\/([a-z0-9][a-z0-9._-]*)\/?$/i.exec(String(company ?? "").trim());
  return m ? `${ORIGIN}/en/${m[1].toLowerCase()}/${m[2]}` : null;
}

/** "Name (TICKER)" list of search candidates for error messages. */
const describe = (list) => list.map((e) => `${e.name} (${e.ticker})`).join(", ");

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
 * Find the security page of a company with the site search. company can be a name (Apple), a ticker (AAPL), an ISIN
 * (FR0013416716) or the security page address itself (https://umushroom.com/en/equity/aapl-apple, /en/etf/...), which skips the search.
 * Only Equity and ETF results count (not Funds, portfolios or users); match priority: exact ticker or ISIN > same name > name starts with it.
 * Throws instead of guessing when no result matches (e.g. a typo or an alias such as "Google") or when
 * several different equities match equally well (e.g. "Alphabet": Class A and Class C); use the ticker or address then.
 */
export async function findEquity(page, company) {
  const direct = directEquityUrl(company);
  if (direct) return { name: "", ticker: "", href: new URL(direct).pathname, url: direct, alternatives: [] };
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
    text: a.textContent, // includes the ISIN line shown under ETF names
  })));
  await page.keyboard.press("Escape").catch(() => {});
  const equities = candidates.filter((c) => SECURITY_TYPE.test(c.type ?? "") && SECURITY_PATH.test(c.href ?? ""));
  if (!equities.length) throw new Error(`Searching "${company}" found no Equity or ETF results.`);
  const q = norm(company);
  const isin = ISIN.test(company.trim()) ? company.trim().toUpperCase() : null;
  const scored = equities.map((c) => ({
    ...c,
    // 4: exact displayed name, share class included ("Alphabet Inc Class A"), so it is never mistaken for another class
    score: c.ticker.toLowerCase() === company.toLowerCase() || (isin && (c.text ?? "").toUpperCase().includes(isin)) ? 3
      : exact(c.name) === exact(company) ? 4 : norm(c.name) === q ? 2 : norm(c.name).startsWith(q + " ") ? 1 : 0,
  })).sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  const best = scored[0];
  // No ticker or name match: never take a search result that merely resembles the text (a single fuzzy hit used to be accepted)
  if (best.score === 0) {
    throw new Error(`"${company}" does not match any equity by ticker or name, please use the ticker. Search results: ` + describe(equities));
  }
  // Several different equities match equally well: refuse rather than silently pick the one with the shortest name
  // (an exact ticker (3) and an exact full name (4) count as equally good)
  const level = (score) => Math.min(score, 3);
  const tied = scored.filter((c) => level(c.score) === level(best.score) && c.href !== best.href);
  if (tied.length) {
    throw new Error(`"${company}" matches several equities equally well, please use the ticker, ISIN or page address: ` +
      [best, ...tied].map((e) => `${e.name} (${e.ticker}) ${ORIGIN}${e.href}`).join(", "));
  }
  const { text, ...chosen } = best; // the raw result text was only needed for the ISIN match
  return { ...chosen, url: ORIGIN + best.href, alternatives: scored.slice(1).map(({ name, ticker }) => `${name} (${ticker})`) };
}

/**
 * Check that the buy popup is for the equity that was chosen, so a page that shows another security is never ordered.
 * Passes when the names are the same (ignoring punctuation and Inc/Corp-style suffixes) or the popup shows the ticker.
 * Deliberately strict: a name that merely contains the chosen one ("Apple Hospitality REIT Inc" vs "Apple Inc") is refused.
 * Skipped when either name is unknown.
 */
function checkInstrument(preview, equity) {
  const plain = (s) => norm(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const shown = plain(preview.instrument);
  const expected = plain(equity.name);
  if (!shown || !expected || shown === expected) return;
  if (equity.ticker && new RegExp(`\\b${escapeRe(equity.ticker)}\\b`, "i").test(preview.instrument)) return;
  throw new Error(`The order form shows "${preview.instrument}" but "${equity.name}${equity.ticker ? ` (${equity.ticker})` : ""}" was chosen; nothing was submitted.`);
}

/** Read the current values of a trade popup (price, shares, amount, weight, available cash, notices and errors). */
async function readPopup(popup) {
  // Fields missing from a form (e.g. the portfolio drop-down in the sell popup) read as "" after at most 1 s instead of
  // waiting the full action timeout (8 s) for each one; the sell flow reads the popup several times, so this used to add 8 s+ per read.
  // Fields that render a moment late are still waited for (up to 1 s).
  const present = (sel) => popup.locator(sel).first().waitFor({ state: "attached", timeout: 1_000 }).then(() => true, () => false);
  const text = async (sel) => (await present(sel)) ? ((await popup.locator(sel).first().textContent().catch(() => ""))?.trim() ?? "") : "";
  const val = async (sel) => (await present(sel)) ? popup.locator(sel).first().inputValue().catch(() => "") : "";
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
  await target.press("ControlOrMeta+A");
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

/**
 * Click the final Add / Sell button and wait for the site to confirm success.
 * Returns { messages, confirmation }: confirmation is "order_placed" (the "Order placed" + Done screen appeared)
 * or "popup_closed" (the popup closed by itself).
 * order = { key, side, stock, portfolio, shares, amount } is used by guard (see order-lock.js): the stock is locked right
 * before the click and unlocked once the site confirms. If there is no confirmation after the click, the order MAY have been
 * placed: the lock is kept and an error with code ORDER_UNCONFIRMED is thrown, so the caller must not simply retry.
 */
async function submitAndConfirm(page, popup, order, guard) {
  const button = popup.locator(S.submit).first();
  if (await button.isDisabled()) throw new Error("The submit button is disabled: check the shares, amount or available cash.");
  await guard?.beginOrder(order);
  let outcome;
  try {
    // A click that throws is treated as unconfirmed too: Playwright can fail after dispatching the click
    // (e.g. while waiting for a navigation it started), so the order may exist. A lock too many is safe; one too few is not.
    await button.click();
    // After a successful submit the popup either closes or switches to an "Order placed" + Done confirmation.
    const done = popup.getByRole("button", { name: /^done$/i });
    outcome = await Promise.race([
      popup.waitFor({ state: "hidden", timeout: 20_000 }).then(() => "closed"),
      done.waitFor({ state: "visible", timeout: 20_000 }).then(() => "confirmed"),
    ]).catch(() => "timeout");
    if (outcome === "timeout") {
      const text = (await popup.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw new Error("No success confirmation within 20 seconds of submitting. Popup text: " + text);
    }
  } catch (error) {
    // The click happened but success could not be confirmed: the order may or may not exist on UMushroom
    const reason = String(error.message).split(/\r?\n/)[0];
    await guard?.markUnconfirmed(order.key, reason).catch(() => {});
    throw Object.assign(new Error(
      `The ${order.side} of ${order.stock} was submitted but UMushroom did not confirm it (${reason}). ` +
      "The order MAY have been placed: do not retry. Check Pending Orders / History of the portfolio on UMushroom." +
      (guard ? ` New orders for this stock stay blocked until then; clear with: npm run unlock -- ${order.key}` : "")),
    { code: "ORDER_UNCONFIRMED" });
  }
  // The site confirmed the order: unlock first, so a hiccup while reading the message or clicking Done
  // can never turn a confirmed order into an "unconfirmed" one.
  // (If removing the lock fails, the stock just stays locked: never report a confirmed order as an error that invites a retry.)
  await guard?.finishOrder(order.key).catch(() => {});
  const messages = [];
  if (outcome === "confirmed") {
    const done = popup.getByRole("button", { name: /^done$/i });
    messages.push((await popup.innerText().catch(() => "")).replace(/\s+/g, " ").trim());
    await done.click().catch(() => {});
    await popup.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  }
  const toast = await page.locator('.toast, .notification, [role="status"], [role="alert"]').allTextContents().catch(() => []);
  return { messages: messages.concat(toast.map((t) => t.trim()).filter(Boolean).slice(0, 3)), confirmation: outcome === "confirmed" ? "order_placed" : "popup_closed" };
}

/** Submit through submitAndConfirm and store the outcome in result; an unconfirmed order is marked submitted: "unknown". */
async function submitInto(result, page, popup, order, guard) {
  try {
    const { messages, confirmation } = await submitAndConfirm(page, popup, order, guard);
    Object.assign(result, { messages, confirmation, submitted: true });
    return result;
  } catch (error) {
    if (error.code === "ORDER_UNCONFIRMED") { result.submitted = "unknown"; error.result = result; }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Buy: add shares of a company to the given portfolio.
 * Flow: search the company -> security page "Add to portfolio" -> choose portfolio -> shares or amount -> (when submit) Add.
 * Returns { action, company, equity, portfolio, preview, submitted, messages?, confirmation? }.
 * guard (optional, see order-lock.js) blocks a submit while an earlier order for the same stock is unconfirmed.
 */
export async function buyStock(page, { company, portfolio, portfolioIndex, shares, amount, submit = false, guard }) {
  checkOrder({ shares, amount });
  if (shares === "all") throw new Error("Buying does not support shares=all.");
  const equity = await findEquity(page, company);
  let key = equitySlug(equity.url);
  if (submit && guard) await guard.assertUnlocked(key); // fail fast, before filling in the form
  await page.goto(equity.url, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  // The lock key is the page actually opened: if the site redirected (e.g. an old or alias address), use and check the final one
  const opened = equitySlug(page.url());
  if (opened && opened !== key) {
    key = opened;
    if (submit && guard) await guard.assertUnlocked(key);
  }
  await page.locator(S.addToPortfolio).first().click({ timeout: 20_000 });
  const popup = page.locator(S.buyPopup).first();
  await popup.waitFor({ state: "visible" });
  await popup.locator(S.existingTab).filter({ hasText: /existing/i }).first().click().catch(() => {});
  const chosen = await choosePortfolio(popup, portfolio, portfolioIndex);
  await fillOrder(popup, { shares, amount });
  const preview = await readPopup(popup);
  if (!equity.name) equity.name = preview.instrument; // opened by address: take the name from the order form
  const result = { action: "buy", company, equity: { name: equity.name, ticker: equity.ticker, url: equity.url, alternatives: equity.alternatives }, portfolio: chosen, preview, submitted: false };
  if (preview.errors.length) throw Object.assign(new Error("The form reports: " + preview.errors.join("; ")), { result });
  try { checkInstrument(preview, equity); } catch (error) {
    await popup.locator(S.popupClose).first().click().catch(() => {});
    throw Object.assign(error, { result });
  }
  if (!submit) { await popup.locator(S.popupClose).first().click().catch(() => {}); return result; }
  const order = { key, side: "buy", stock: equity.ticker ? `${equity.name} (${equity.ticker})` : equity.name, portfolio: chosen, shares: preview.shares, amount: preview.estimatedAmount };
  return submitInto(result, page, popup, order, guard);
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
  const match = matches[(portfolioIndex ?? 1) - 1];
  // An index larger than the number of same-named portfolios used to crash with a TypeError
  if (!match) throw new Error(`portfolioIndex is out of range (there are ${matches.length} portfolios named "${portfolio}").`);
  return ORIGIN + match.href;
}

/**
 * Pick the holding to sell. Priority: exact displayed name (share class included) > same name ignoring Inc/Corp/Class >
 * ticker at the start of the equity address (aapl-...) > name starts with it; an equity page address matches that holding directly.
 * Throws when nothing matches, or when several different holdings match equally well (e.g. "Alphabet" with both
 * Class A and Class C held) instead of selling whichever row comes first.
 */
function matchHolding(holdings, company) {
  const q = norm(company);
  const slug = equitySlug(directEquityUrl(company));
  const lower = String(company).trim().toLowerCase();
  const tiers = slug
    ? [(h) => equitySlug(h.href) === slug]
    : [(h) => exact(h.name) === exact(company),
      (h) => norm(h.name) === q,
      (h) => equitySlug(h.href)?.startsWith(`${lower}-`),
      (h) => norm(h.name).startsWith(q + " ")];
  for (const test of tiers) {
    const found = holdings.map((h, index) => ({ ...h, index })).filter((h) => h.name && test(h));
    const distinct = new Set(found.map((h) => h.href || h.name));
    if (distinct.size > 1) {
      throw new Error(`"${company}" matches several holdings, please use the ticker or the equity page address: ` +
        found.map((h) => `${h.name} ${h.shares} ${h.href ? ORIGIN + h.href : ""}`.trim()).join(", "));
    }
    if (found.length) return found[0].index;
  }
  return -1;
}

/**
 * Sell: sell a company's holding in the given portfolio. shares may be "all" (sell everything).
 * Flow: open the portfolio -> All tab under Investments -> holding row Sell -> shares -> (when submit) Sell.
 * Shares bought while the market is closed stay in Pending Orders and cannot be sold yet.
 * guard (optional, see order-lock.js) blocks a submit while an earlier order for the same stock is unconfirmed.
 */
export async function sellStock(page, { company, portfolio, portfolioIndex, shares, amount, submit = false, guard }) {
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
  const readHoldings = () => rows.evaluateAll((els) => els.map((r) => ({
    name: r.querySelector("h5.title")?.textContent.trim(),
    // Prefer the stock's own link (a comma selector would return whichever link comes first in the row)
    href: (r.querySelector('a[href*="/equity/"]') ?? r.querySelector('a[href*="/etf/"]') ?? r.querySelector("a[href]"))?.getAttribute("href"),
    shares: r.querySelector(".shares span")?.textContent.trim(),
  })));
  // Long holding lists are collapsed behind "See All": expand them (as the journal snapshot does), otherwise holdings further
  // down cannot be found, and an ambiguous name (e.g. Class A visible, Class C hidden) could not be noticed
  const expand = page.locator(S.expandHoldings);
  let expanded = false;
  for (let i = await expand.count() - 1; i >= 0; i -= 1) {
    if (await expand.nth(i).isVisible().catch(() => false)) { await expand.nth(i).click().catch(() => {}); expanded = true; }
  }
  if (expanded) await page.waitForTimeout(800);
  const holdings = await readHoldings();
  const index = matchHolding(holdings, company);
  if (index < 0) {
    throw new Error(`The portfolio has no "${company}" holding (if the order was just placed while the market is closed it may still be pending). Current holdings: ` +
      (holdings.filter((h) => h.name).map((h) => `${h.name} ${h.shares}`).join(", ") || "none"));
  }
  const key = equitySlug(holdings[index].href) ?? `name-${norm(holdings[index].name).replace(/\s+/g, "-")}`;
  if (submit && guard) await guard.assertUnlocked(key); // fail fast, before opening the sell form
  // Click Sell on the row that holds this stock's link, not on "row number index", in case the list changed since it was read
  const href = holdings[index].href;
  const row = href && !/["\\]/.test(href) ? rows.filter({ has: page.locator(`a[href="${href}"]`) }).first() : rows.nth(index);
  await row.locator(S.holdingSell).click();
  const popup = page.locator(S.sellPopup).first();
  await popup.waitFor({ state: "visible" });
  // The available shares load a moment after the popup opens; poll until a non-zero value appears (up to about 6 seconds).
  let available = 0;
  for (let i = 0; i < 12 && !(available > 0); i += 1) {
    const { metrics } = await readPopup(popup);
    available = num(metrics["Available shares"] ?? metrics["Available units"]) ?? 0; // ETFs are counted in units
    if (!(available > 0)) await page.waitForTimeout(500);
  }
  const closePopup = () => popup.locator(S.popupClose).first().click().catch(() => {});
  if (!(available > 0)) {
    // "all" used to become 0 shares here; a holding with nothing available cannot be sold at all
    await closePopup();
    throw new Error(`No shares of ${holdings[index].name} are available to sell (the available amount did not load, or the shares are still pending).`);
  }
  if (shares === "all") shares = available;
  if (shares != null && Number(shares) > available) {
    await closePopup();
    throw new Error(`You can sell at most ${available} shares.`);
  }
  await fillOrder(popup, { shares, amount });
  const preview = await readPopup(popup);
  const result = { action: "sell", company, holding: holdings[index], portfolioUrl: url, preview, submitted: false };
  if (preview.errors.length) throw Object.assign(new Error("The form reports: " + preview.errors.join("; ")), { result });
  // An amount is converted to shares by the site; check that against the holding too (only shares were checked before).
  // A tiny excess from the site's rounding (e.g. 10.0003 of 10) is left to the site's own validation.
  if (amount != null && preview.shares != null && preview.shares - available > 0.001) {
    await closePopup();
    throw Object.assign(new Error(`The amount ${amount} is ${preview.shares} shares, but you can sell at most ${available} shares.`), { result });
  }
  if (!submit) { await closePopup(); return result; }
  const order = { key, side: "sell", stock: holdings[index].name, portfolio: url, shares: preview.shares, amount: preview.estimatedAmount };
  return submitInto(result, page, popup, order, guard);
}
