// Competition rules (src/rules.js): asset/group limits, hedges, never borrowing, journal freshness. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rules-"));
process.env.MCP_LOG_DIR = join(dir, "logs");
process.env.MCP_RULES_FILE = join(dir, "competition.json");
writeFileSync(process.env.MCP_RULES_FILE, JSON.stringify({
  portfolios: ["Fintech competition"], maxAssetPct: 6, maxGroupPct: 20, minHedgePct: 15, hedgeGroup: "Hedge",
  noBorrow: true, journalMaxAgeHours: 24, aliases: { IE00BFM6TC58: ["ishares $ treasury"], FR0013416716: ["amundi physical gold"] },
}));
const NOW = Date.parse("2026-10-13T12:00:00Z");
const h = (name, href, weight) => ({ name, href, weight: `${weight}%` });
function journal(holdings, pending = [], takenAt = "2026-10-13T09:00:00Z") {
  mkdirSync(join(process.env.MCP_LOG_DIR, "fintech"), { recursive: true });
  writeFileSync(join(process.env.MCP_LOG_DIR, "fintech", "latest.json"), JSON.stringify({
    takenAt, portfolio: { name: "Fintech competition", url: "https://umushroom.com/en/profile/you/portfolio/fintech-competition" },
    summary: { currency: "GBP", currentValue: "GBP 100,000.00", cash: "GBP 2,000.00", cashShare: "2.00%" }, holdings, pending,
  }));
}
const { checkOrder, competitionStatus, classify, competitionAssets, rulesFor } = await import("../src/rules.js");
const buy = (security, weight, cash = "GBP 2,000.00") => checkOrder({ portfolio: "Fintech competition", side: "buy", now: NOW, security,
  preview: { expectedWeight: `${weight}%`, estimatedAmount: "1000", metrics: { "Cash available to buy": cash } } });

const BASE = [
  h("NVIDIA Corp", "/en/equity/nvda-nvidia", 5.5), h("Broadcom Inc", "/en/equity/avgo-broadcom", 4), h("Taiwan Semiconductor Manufacturing Co Ltd", "/en/equity/tsm-taiwan", 4),
  h("Advanced Micro Devices Inc", "/en/equity/amd-amd", 3), h("Intel Corp", "/en/equity/intc-intel", 3),
  h("Walmart Inc", "/en/equity/wmt-walmart", 2), h("Amundi Physical Gold ETC C", "/en/etf/amundi-physical-gold-etc-c-2", 4),
  h("iShares $ Treasury Bd 20+y ETF USD Acc", "/en/etf/ishares-usd-treasury-bond-20yr", 3), h("Exxon Mobil Corp", "/en/equity/xom-exxon", 2),
  h("Johnson & Johnson", "/en/equity/jnj-jnj", 2), h("Eli Lilly & Co", "/en/equity/lly-lilly", 2), h("JPMorgan Chase & Co", "/en/equity/jpm-jpmorgan", 2),
];

test("only listed portfolios have rules", () => {
  assert.equal(rulesFor("First Portfolio"), null);
  assert.ok(rulesFor("fintech competition"));
  assert.equal(checkOrder({ portfolio: "First Portfolio", side: "buy", security: { ticker: "NVDA" }, preview: {} }).checked, false);
});

test("names match whole words only, funds by alias", () => {
  const assets = competitionAssets(JSON.parse('{"aliases":{"IE00BFM6TC58":["ishares $ treasury"]}}'));
  assert.equal(classify(assets, { name: "Intelligent Bio Solutions Inc" }), null);
  assert.equal(classify(assets, { name: "Intel Corp" }).ticker, "INTC");
  assert.equal(classify(assets, { name: "Amazon.com Inc" }).ticker, "AMZN");
  assert.match(classify(assets, { name: "iShares $ Treasury Bd 20+y ETF USD Acc" }).group, /^Hedge/);
  assert.equal(classify(assets, { href: "https://umushroom.com/en/equity/googl-alphabet-class-a" }).ticker, "GOOGL");
});

test("a stale or missing journal blocks the check", () => {
  journal(BASE, [], "2026-10-11T09:00:00Z");
  const r = buy({ ticker: "WMT", name: "Walmart Inc" }, 1);
  assert.equal(r.ok, false);
  assert.match(r.violations[0], /No journal/);
});

test("asset and group limits count holdings and pending orders", () => {
  journal(BASE, [{ name: "Micron Technology Inc", href: "/en/equity/mu-micron", expectedWeight: "1.00%" }]);
  const nv = buy({ ticker: "NVDA", name: "NVIDIA Corp" }, 1);
  assert.equal(nv.ok, false);
  assert.ok(nv.violations.some((v) => /NVDA would be 6.5%/.test(v)), nv.violations.join(" | "));
  assert.ok(nv.violations.some((v) => /Chips would be 20.5%/.test(v)), nv.violations.join(" | "));
  assert.equal(buy({ ticker: "WMT", name: "Walmart Inc" }, 1).ok, true);
});

test("never borrow: the order must fit in the cash available to buy", () => {
  journal(BASE);
  const r = buy({ ticker: "PG", name: "Procter & Gamble Co" }, 3);
  assert.ok(r.violations.some((v) => /credit margin/.test(v)), r.violations.join(" | "));
  assert.ok(buy({ ticker: "PG", name: "Procter & Gamble Co" }, 1, "GBP 0.00").violations.some((v) => /No cash available/.test(v)));
});

test("only the 40 assets", () => {
  journal(BASE);
  assert.ok(buy({ ticker: "COHR", name: "Coherent Corp" }, 1).violations.some((v) => /not one of the 40/.test(v)));
});

test("hedges stay at or above 15% after a sale", () => {
  journal(BASE); // hedges 17%
  const sell = (soldShares) => checkOrder({ portfolio: "Fintech competition", side: "sell", now: NOW, preview: {},
    security: { name: "Amundi Physical Gold ETC C", href: "/en/etf/amundi-physical-gold-etc-c-2" }, soldShares, heldShares: 10 });
  assert.equal(sell(10).ok, false); // 17 - 4 = 13
  assert.equal(sell(5).ok, true);   // 17 - 2 = 15
  const nvda = checkOrder({ portfolio: "Fintech competition", side: "sell", now: NOW, preview: {},
    security: { name: "NVIDIA Corp", href: "/en/equity/nvda-nvidia" }, soldShares: 1, heldShares: 1 });
  assert.equal(nvda.ok, true);
});

test("status shows groups, hedges and broken rules", () => {
  journal([...BASE, h("Coherent Corp", "/en/equity/cohr-coherent", 1)]);
  const s = competitionStatus("Fintech competition", NOW);
  assert.equal(s.hedgePct, 17);
  assert.equal(s.groups.Chips, 19.5);
  assert.ok(s.broken.some((b) => /Coherent/.test(b)));
  assert.equal(competitionStatus("First Portfolio").competition, false);
});
