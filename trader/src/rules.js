// =============================================================================
// Competition rules (docs/AGENT_GUIDE.md section 3), checked before an order is submitted
// -----------------------------------------------------------------------------
// Applies only to the portfolios listed in competition.json. Uses the order form (expected weight, "Cash available to buy")
// and the portfolio's latest journal snapshot (holdings and pending orders with their weights), so it needs a fresh journal:
// run log_umushroom_portfolio (npm run journal) for the competition portfolio first.
//   1. only the 40 competition assets (docs/news-sources.json)
//   2. one asset at most maxAssetPct (6%) after the order, pending orders included
//   3. one group at most maxGroupPct (20%) after the order
//   4. hedges at least minHedgePct (15%) after a sale
//   5. never borrow: a buy must fit in "Cash available to buy" (the 10% credit margin is never used)
// A preview reports the check; a submit that breaks a rule is refused before the final button is clicked.
// =============================================================================
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS, PROJECT_DIR } from "./config.js";

const RULES_FILE = process.env.MCP_RULES_FILE || join(PROJECT_DIR, "competition.json");
const ASSETS_FILE = join(PROJECT_DIR, "docs", "news-sources.json");

/** "6.25%" / "USD 1,234.50" -> number (null if none). */
export const pct = (s) => { const m = /-?[\d,]*\.?\d+/.exec(String(s ?? "")); return m ? Number(m[0].replace(/,/g, "")) : null; };
/** "USD 1,234.50" -> { currency: "USD", value: 1234.5 } */
export const money = (s) => ({ currency: (/[A-Z]{3}/.exec(String(s ?? "")) ?? [""])[0], value: pct(s) });
const lower = (s) => String(s ?? "").trim().toLowerCase();
const round = (x) => Math.round(x * 100) / 100;
/** Is this group the hedges? ("Hedge" in the config matches the asset list's "Hedges") */
const isHedge = (rules, group) => lower(group).startsWith(lower(rules.hedgeGroup || "hedge"));
const hedgeWeight = (rules, byGroup) => [...byGroup].filter(([g]) => isHedge(rules, g)).reduce((s, [, w]) => s + w, 0);

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

/** The rules for this portfolio (name or URL), or null when it is not a competition portfolio. */
export function rulesFor(portfolio) {
  const rules = readJson(RULES_FILE, null);
  if (!rules || !portfolio) return null;
  const p = lower(portfolio);
  const listed = (rules.portfolios ?? []).map(lower);
  if (listed.includes(p) || listed.some((name) => p.startsWith("https://") && p.includes("/portfolio/") && p.endsWith("/" + name.replace(/\s+/g, "-")))) {
    return rules;
  }
  return null;
}

/** The 40 assets with their group and the keys that identify them on UMushroom. */
export function competitionAssets(rules) {
  const data = readJson(ASSETS_FILE, { assets: [] });
  return data.assets.map((a) => ({
    group: a.group, name: a.name, ticker: a.ticker,
    keys: [a.ticker, a.umushroom].filter(Boolean).map((k) => lower(String(k).split(" ")[0])),
    names: [a.name, ...((rules?.aliases ?? {})[a.umushroom] ?? [])].map(lower),
  }));
}

/** Which competition asset a holding / security is: by ticker, the slug's ticker prefix, ISIN, or name. */
export function classify(assets, { href, name, ticker }) {
  const slug = (/\/(?:equity|etf)\/([^/?#]+)/i.exec(String(href ?? "")) ?? [])[1] ?? "";
  const prefix = lower(slug.split("-")[0]);
  const t = lower(ticker), n = lower(name);
  return assets.find((a) => (t && a.keys.includes(t)) || (prefix && a.keys.includes(prefix))) ??
    // whole words only: "Intel" must not match "Intelligent ..."; "Amazon" matches "Amazon.com Inc"
    assets.find((a) => n && a.names.some((an) => an && new RegExp("^" + an.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9])").test(n))) ?? null;
}

/** The latest journal snapshot of a portfolio (by name or URL), or null. */
export function latestSnapshot(portfolio) {
  if (!existsSync(PATHS.logs)) return null;
  const p = lower(portfolio);
  for (const dir of readdirSync(PATHS.logs)) {
    const snap = readJson(join(PATHS.logs, dir, "latest.json"), null);
    if (snap && (lower(snap.portfolio?.name) === p || lower(snap.portfolio?.url) === p)) return snap;
  }
  return null;
}

/** Current weight per asset key and per group, pending orders included. */
export function weights(assets, snapshot) {
  const byAsset = new Map(), byGroup = new Map(), unknown = [];
  const add = (row, w) => {
    const a = classify(assets, row);
    if (!a) { unknown.push(row.name); return; }
    byAsset.set(a.ticker, (byAsset.get(a.ticker) ?? 0) + w);
    byGroup.set(a.group, (byGroup.get(a.group) ?? 0) + w);
  };
  for (const h of snapshot.holdings ?? []) add(h, pct(h.weight) ?? 0);
  for (const o of snapshot.pending ?? []) add(o, pct(o.expectedWeight ?? o.weight) ?? 0);
  return { byAsset, byGroup, unknown };
}

/**
 * Check an order against the rules. side "buy" | "sell"; security { href, name, ticker }; preview = readPopup() values;
 * for a sale, soldShares / heldShares give the share of the holding being sold.
 * Returns { checked, ok, violations[], notes[] } (checked false when the portfolio has no rules).
 */
export function checkOrder({ portfolio, side, security, preview, soldShares, heldShares, now = Date.now() }) {
  const rules = rulesFor(portfolio);
  if (!rules) return { checked: false, ok: true, violations: [], notes: [] };
  const violations = [], notes = [];
  const assets = competitionAssets(rules);
  const asset = classify(assets, security);
  if (!asset) violations.push(`${security.name || security.ticker || security.href} is not one of the ${assets.length} competition assets.`);

  const snapshot = latestSnapshot(portfolio);
  const ageH = snapshot ? (now - Date.parse(snapshot.takenAt)) / 3_600_000 : Infinity;
  if (!snapshot || !(ageH <= (rules.journalMaxAgeHours ?? 24))) {
    violations.push(`No journal of "${portfolio}" from the last ${rules.journalMaxAgeHours ?? 24} hours: run log_umushroom_portfolio ` +
      `(npm run journal -- "${portfolio}") first, so the group and hedge limits can be checked.`);
    return { checked: true, ok: false, violations, notes };
  }
  const { byAsset, byGroup } = weights(assets, snapshot);
  const hedge = hedgeWeight(rules, byGroup);

  if (side === "buy") {
    const w = pct(preview?.expectedWeight);
    if (w == null) violations.push("Could not read the order's expected weight from the form.");
    else if (asset) {
      const assetAfter = (byAsset.get(asset.ticker) ?? 0) + w, groupAfter = (byGroup.get(asset.group) ?? 0) + w;
      notes.push(`${asset.ticker}: ${round(byAsset.get(asset.ticker) ?? 0)}% -> ${round(assetAfter)}%; ${asset.group}: ` +
        `${round(byGroup.get(asset.group) ?? 0)}% -> ${round(groupAfter)}%`);
      if (assetAfter > rules.maxAssetPct + 0.005) violations.push(`${asset.ticker} would be ${round(assetAfter)}% of the portfolio (max ${rules.maxAssetPct}%).`);
      if (groupAfter > rules.maxGroupPct + 0.005) violations.push(`${asset.group} would be ${round(groupAfter)}% (max ${rules.maxGroupPct}% per group).`);
    }
    if (rules.noBorrow) {
      const cash = money(preview?.metrics?.["Cash available to buy"]);
      const amount = pct(preview?.estimatedAmount);
      const value = money(snapshot.summary?.currentValue);
      if (cash.value == null) violations.push('Could not read "Cash available to buy" from the form, so borrowing cannot be ruled out.');
      else if (cash.value <= 0) violations.push(`No cash available to buy (${cash.currency} ${cash.value}): sell or trim something first (never borrow).`);
      else if (w != null && value.value > 0 && cash.currency === value.currency) {
        const cashPct = (cash.value / value.value) * 100;
        notes.push(`cash available ${round(cashPct)}% of the portfolio, order ${round(w)}%`);
        if (w > cashPct + 0.005) violations.push(`The order (${round(w)}%) is more than the cash available to buy (${round(cashPct)}%): it would use the credit margin (never borrow).`);
      } else if (amount != null && preview?.amountCurrency && preview.amountCurrency === cash.currency) {
        if (amount > cash.value) violations.push(`The order (${cash.currency} ${amount}) is more than the cash available to buy (${cash.currency} ${cash.value}): never borrow.`);
      } else {
        violations.push("Could not compare the order with the cash available to buy (different currencies), so borrowing cannot be ruled out.");
      }
    }
  } else if (side === "sell" && asset && isHedge(rules, asset.group)) {
    const held = byAsset.get(asset.ticker) ?? 0;
    const sold = heldShares > 0 ? held * Math.min(1, soldShares / heldShares) : held;
    const after = hedge - sold;
    notes.push(`hedges ${round(hedge)}% -> ${round(after)}%`);
    if (after < rules.minHedgePct - 0.005) violations.push(`Hedges would fall to ${round(after)}% (at least ${rules.minHedgePct}%).`);
  }
  return { checked: true, ok: violations.length === 0, violations, notes };
}

/**
 * Where a competition portfolio stands against the rules, from its latest journal (read-only, no browser):
 * weight per group and per asset, hedges, cash share, and any rule already broken.
 */
export function competitionStatus(portfolio, now = Date.now()) {
  const rules = rulesFor(portfolio);
  if (!rules) {
    const listed = readJson(RULES_FILE, {}).portfolios ?? [];
    return { portfolio, competition: false, note: `Not listed in competition.json (listed: ${listed.join(", ") || "none"}).` };
  }
  const snapshot = latestSnapshot(portfolio);
  if (!snapshot) return { portfolio, competition: true, note: `No journal yet: run log_umushroom_portfolio for "${portfolio}".` };
  const assets = competitionAssets(rules);
  const { byAsset, byGroup, unknown } = weights(assets, snapshot);
  const broken = [];
  for (const [t, w] of byAsset) if (w > rules.maxAssetPct + 0.005) broken.push(`${t} ${round(w)}% (max ${rules.maxAssetPct}%)`);
  for (const [g, w] of byGroup) if (!isHedge(rules, g) && w > rules.maxGroupPct + 0.005) broken.push(`${g} ${round(w)}% (max ${rules.maxGroupPct}%)`);
  const hedge = hedgeWeight(rules, byGroup);
  if (hedge < rules.minHedgePct - 0.005) broken.push(`hedges ${round(hedge)}% (at least ${rules.minHedgePct}%)`);
  if (unknown.length) broken.push(`not competition assets: ${unknown.join(", ")}`);
  return {
    portfolio, competition: true, journalTakenAt: snapshot.takenAt,
    journalAgeHours: round((now - Date.parse(snapshot.takenAt)) / 3_600_000),
    currentValue: snapshot.summary?.currentValue, cash: snapshot.summary?.cash, cashShare: snapshot.summary?.cashShare,
    limits: { maxAssetPct: rules.maxAssetPct, maxGroupPct: rules.maxGroupPct, minHedgePct: rules.minHedgePct, noBorrow: rules.noBorrow },
    hedgePct: round(hedge),
    groups: Object.fromEntries([...byGroup].sort((a, b) => b[1] - a[1]).map(([g, w]) => [g, round(w)])),
    assets: Object.fromEntries([...byAsset].sort((a, b) => b[1] - a[1]).map(([t, w]) => [t, round(w)])),
    broken,
  };
}
