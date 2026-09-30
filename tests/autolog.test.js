// Journal service tests: adjusting portfolios on the journal page (adding portfolios, previewing/submitting a buy), hourly updates, API security.
// Uses a headless Chrome + the mock site (tests/fixtures/mock-site.js); journals go to a temp folder and the real site is never contacted.
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORIGIN, PORTFOLIO_PATH, routeMockSite } from "./fixtures/mock-site.js";

// Must be set before src/ is loaded: temporary project Chrome profile, headless, temporary journal folder, separate port
const temp = await mkdtemp(join(tmpdir(), "umushroom-autolog-"));
Object.assign(process.env, {
  MCP_CHROME_MODE: "profile", MCP_HEADLESS: "true", MCP_SLOW_MO: "0", MCP_LOG_OPEN: "off",
  MCP_CHROME_FALLBACK_DIR: join(temp, "chrome"), MCP_LOG_DIR: join(temp, "logs"), MCP_LOG_PORT: "6497",
});
const { ensureJournalService, stopJournalService, msUntilNextHour, runHourly } = await import("../src/autolog.js");
const { getWorkerPage, closeUmushroomSession } = await import("../src/browser.js");
const { stopDashboard } = await import("../src/dashboard.js");
const { listPortfolioLogs, readPortfolioLog, readSettings } = await import("../src/journal.js");

const ID = "you-wang--first-portfolio";
let url, orders;

/** Call an action as the journal page would (with the custom header). */
async function post(action, body = {}, headers = { "x-umushroom-journal": "1" }) {
  const res = await fetch(`${url}api/${action}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  const worker = await getWorkerPage();
  orders = await routeMockSite(worker.context());
  url = await ensureJournalService();
});
after(async () => {
  stopJournalService();
  await closeUmushroomSession();
  await stopDashboard();
  await rm(temp, { recursive: true, force: true });
});

test("hourly timer: always waits for the next full hour (xx:00:05)", () => {
  assert.equal(msUntilNextHour(new Date(2026, 8, 27, 10, 59, 50)), 15_000);
  assert.equal(msUntilNextHour(new Date(2026, 8, 27, 11, 0, 0)), 3_605_000);
  assert.equal(msUntilNextHour(new Date(2026, 8, 27, 23, 30, 0)), 30 * 60_000 + 5_000); // across midnight
});

test("security: requests without the custom header or from another website are refused", async () => {
  assert.equal((await post("trade", {}, {})).status, 403);
  assert.equal((await post("trade", {}, { "x-umushroom-journal": "1", origin: "https://evil.example" })).status, 403);
  assert.equal((await post("nope")).status, 404);
});

test("status: the journal service is available, hourly updates are on by default and the next run is scheduled", async () => {
  const status = await (await fetch(url + "api/status")).json();
  assert.equal(status.actions, true);
  assert.equal(status.hourly, true);
  const wait = new Date(status.nextRunAt) - Date.now();
  assert.ok(wait > 0 && wait <= 3_605_000, "the next update should be within an hour");
});

test("add portfolio: lists the My profile portfolios and records one snapshot right after adding", async () => {
  const available = await post("available");
  assert.equal(available.status, 200);
  assert.deepEqual(available.body.map((p) => [p.name, p.index, p.tracked]), [["First Portfolio", 1, false], ["Second portfolio", 1, false]]);

  const track = await post("track", { url: ORIGIN + PORTFOLIO_PATH, portfolioIndex: 1 });
  assert.equal(track.status, 200);
  assert.equal(track.body.id, ID);
  const list = await listPortfolioLogs();
  assert.equal(list[0].name, "First Portfolio");
  assert.equal(list[0].hourly, true);
  assert.equal((await post("available")).body[0].tracked, true);
});

test("buy preview: returns only preview data, places no order and writes no activity", async () => {
  const r = await post("trade", { kind: "buy", id: ID, company: "Apple", shares: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.submitted, false);
  assert.equal(r.body.equity.ticker, "AAPL");
  assert.equal(r.body.preview.estimatedAmount, "341.07");
  assert.equal(orders.length, 0);
  assert.equal((await readPortfolioLog(ID)).events.length, 0);
});

test("buy submit: orders into the right portfolio and records a snapshot and activity (source: journal page)", async () => {
  const r = await post("trade", { kind: "buy", id: ID, company: "AAPL", shares: 2, submit: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.submitted, true);
  assert.equal(r.body.log.ok, true);
  assert.deepEqual(orders, [{ side: "buy", ticker: "AAPL", portfolio: "First Portfolio", portfolioIndex: 0, shares: 2 }]);
  const log = await readPortfolioLog(ID);
  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].source, "journal page");
  assert.equal(log.snapshots.length, 2);
});

test("errors come back as readable messages", async () => {
  const r = await post("trade", { kind: "buy", id: ID, company: "Apple", shares: 5000, submit: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Insufficient cash/);
  assert.equal((await post("trade", { kind: "buy", id: "nope", company: "Apple", shares: 1 })).status, 400);
});

test("hourly update: only updates portfolios that are switched on; can be switched off per portfolio or globally", async () => {
  await post("setHourly", { id: ID, enabled: false });
  assert.deepEqual((await runHourly()).results, [], "a switched-off portfolio should not be updated");
  await post("setHourly", { id: ID, enabled: true });
  const before = (await readPortfolioLog(ID)).snapshots.length;
  const run = await runHourly();
  assert.deepEqual(run.results.map((r) => [r.id, r.ok]), [[ID, true]]);
  assert.equal((await readPortfolioLog(ID)).snapshots.length, before + 1);
  assert.equal((await readSettings()).lastRun.results.length, 1, "the result should be saved in the settings");

  await post("setHourly", { enabled: false });
  assert.equal((await runHourly()).skipped, "Hourly updates are switched off");
  assert.equal((await post("refresh")).body.results.length, 1, "\"Update all now\" ignores the master switch");
  await post("setHourly", { enabled: true });
});

test("journal page: fill in the form -> preview -> confirm", async () => {
  const worker = await getWorkerPage();
  const view = await worker.context().newPage();
  await view.goto(url);
  await view.locator("#company").waitFor();
  await view.locator('#kindSeg button[data-kind="buy"]').click();
  await view.locator("#company").fill("Apple");
  await view.locator("#qty").fill("3");
  await view.locator("#previewBtn").click();
  await view.locator("#confirmBtn").waitFor({ timeout: 30_000 });
  assert.match(await view.locator("#previewBox").innerText(), /Apple Inc \(AAPL\)[\s\S]*1,023\.21/);
  assert.equal(orders.length, 1, "a preview must not place an order");
  await view.locator("#confirmBtn").click();
  await view.locator("#tradeMsg .notice.ok").waitFor({ timeout: 30_000 });
  assert.equal(orders.length, 2);
  assert.equal(orders[1].shares, 3);
  await view.close();
});

test("remove from list: no longer shown or updated hourly; journal files are kept", async () => {
  await post("untrack", { id: ID });
  assert.equal((await listPortfolioLogs()).length, 0);
  assert.equal((await readSettings()).tracked[ID].hourly, false);
  assert.ok(await readPortfolioLog(ID), "journal files should be kept");
});
