// =============================================================================
// Read-only review (start_umushroom_review / npm run umushroom)
// -----------------------------------------------------------------------------
// Opens each personal and team portfolio on My profile in turn and clicks the section navigation, chart periods, holding tabs,
// expand/sort controls and history filters, confirming that every click takes effect. It never clicks buy, sell, create, edit, delete,
// share, publish or change the benchmark. Every step is recorded in run.steps and a report is written at the end.
// =============================================================================
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_PORTFOLIOS, PATHS, TIMEOUTS, sleep } from "./config.js";
import { HOME_URL, OVERVIEW_URL, PROFILE_URL, SELECTORS as S, uniquePortfolios } from "./site.js";
import { ensureUmushroomPage, getSessionInfo, inspectLogin, overlay, visible } from "./browser.js";

let currentRun; // state object of the current (or most recent) review
let worker;     // Promise of the background task that is running

/** Whether a review is still in progress. */
export const isReviewActive = () => currentRun && ["starting", "waiting_login", "running"].includes(currentRun.status);
const active = isReviewActive;

/** Wait for the background task to finish (call before closing the browser). */
export const waitForReview = () => worker;

/** Throw once the user has asked to stop, interrupting the remaining steps. */
function ensureNotStopped(run) {
  if (run.cancelRequested) throw new Error("Review stopped");
}

/**
 * Run and record one review step: update the progress box -> run action -> pause so it can be watched.
 * Returns true on success; on failure records the reason and returns false (the review continues); throws if the user stopped it.
 */
async function step(run, page, label, action) {
  ensureNotStopped(run);
  run.currentStep = label;
  await overlay(page, label);
  const entry = { label, portfolio: run.currentPortfolio ?? null, startedAt: new Date().toISOString(), status: "running" };
  run.steps.push(entry);
  try {
    const evidence = await action();
    ensureNotStopped(run);
    await sleep(run.pauseMs ?? TIMEOUTS.reviewPause);
    entry.status = "passed";
    entry.evidence = evidence ?? "Done";
    return true;
  } catch (error) {
    entry.status = run.cancelRequested ? "stopped" : "failed";
    entry.error = String(error.message).split(/\r?\n/)[0];
    ensureNotStopped(run);
    return false;
  } finally { entry.finishedAt = new Date().toISOString(); }
}

/** Make sure we are on My Overview (the starting point of the review). */
async function openOverview(page, run) {
  const current = new URL(page.url());
  const expected = new URL(OVERVIEW_URL);
  if (current.origin === expected.origin && current.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "")) return true;
  const opened = await step(run, page, "Open My Overview to start the portfolio review", async () => {
    await page.goto(OVERVIEW_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
    return "My Overview opened";
  });
  if (!opened) throw new Error("Could not open UMushroom My Overview after logging in.");
  return true;
}

/**
 * Open the personal portfolio list on My profile, switch to list view and expand Show more,
 * so that every portfolio link is on the page and none is missed.
 */
async function preparePortfolioList(page, run) {
  const opened = await step(run, page, "Open the My portfolios list", async () => {
    const link = await visible(page.getByRole("link", { name: /^My portfolios$/i }));
    if (link) await link.click();
    else await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
    await page.locator(S.portfolios).waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(S.portfolios + ' .items[aria-busy="false"]').waitFor({ timeout: 20_000 });
    return link ? "Clicked My portfolios; the personal list has loaded" : "Opened /en/my-profile; the personal list has loaded (navigated directly)";
  });
  if (!opened) throw new Error("The personal portfolio list was not found. The site may have changed or the login is not complete. Public Trending portfolios were not scanned.");
  const listSwitch = page.locator(S.listView).nth(1);
  if (await listSwitch.isVisible()) {
    const switched = await step(run, page, "Switch the personal portfolios to list view", async () => {
      await listSwitch.click();
      await page.locator(S.portfolios + ' .items[aria-busy="false"]').waitFor();
      return "List view is on";
    });
    if (!switched) throw new Error("Could not switch to list view, so it cannot be confirmed that all portfolios were found.");
  }
  const expand = await visible(page.locator(S.portfolios).locator(S.showMore).filter({ hasText: /^Show more$/i }));
  if (expand) {
    const expanded = await step(run, page, "Expand all personal portfolios (Show more)", async () => {
      await expand.click();
      await page.locator(S.portfolios).locator(S.showMore).filter({ hasText: /^Show less$/i }).waitFor();
      return "The hidden portfolios are expanded";
    });
    if (!expanded) throw new Error("The personal list could not be fully expanded; stopping rather than reporting success with portfolios missed.");
  }
  return page.locator(S.portfolios);
}

/** Section navigation buttons of a portfolio page -> the section that should scroll into view after clicking. */
const sectionTargets = [
  [/^overview$/i, ".portfolio-dashboard"],
  [/^asset allocation$/i, ".dashboard-side"],
  [/^investments$/i, ".holdings-workspace"],
  [/^strategy$/i, ".portfolio-story-grid"],
  [/^ratings$/i, ".reviews-section"],
  [/^comparable etfs$/i, ".portfolio-carousel-section"],
];

/**
 * Confirm that a control really took effect after clicking:
 *   section      the target section is in view
 *   aria-pressed the button has aria-pressed=true (chart periods)
 *   otherwise    the button has the active class (holding tabs, history filters)
 */
async function selectedAfterClick(locator, attribute, name = "") {
  if (attribute === "section") {
    const targetSelector = sectionTargets.find(([pattern]) => pattern.test(name))?.[1];
    if (!targetSelector) throw new Error(`No verified read-only section locator for "${name}"`);
    const target = locator.page().locator(targetSelector).first();
    await target.waitFor({ state: "visible", timeout: 5000 });
    await target.scrollIntoViewIfNeeded();
    const inViewport = await target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top < window.innerHeight && box.bottom > 0;
    });
    if (!inViewport) throw new Error(`The "${name}" section did not scroll into view`);
    return;
  }
  if (attribute === "aria-pressed") {
    await locator.page().waitForFunction((el) => el?.getAttribute("aria-pressed") === "true", await locator.elementHandle(), { timeout: 5000 });
  } else {
    await locator.page().waitForFunction((el) => el?.classList.contains("active"), await locator.elementHandle(), { timeout: 5000 });
  }
}

/** Click each control of a group in turn (de-duplicated by name), recording each as a review step; returns how many were clicked. */
async function exerciseGroup(run, page, selector, label, attribute) {
  const controls = page.locator(selector);
  const seen = new Set();
  for (let i = 0; i < await controls.count(); i += 1) {
    ensureNotStopped(run);
    const control = controls.nth(i);
    if (!await control.isVisible() || !await control.isEnabled()) continue;
    const name = (await control.getAttribute("aria-label") || await control.innerText()).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    await step(run, page, `${label}: ${name}`, async () => {
      await control.scrollIntoViewIfNeeded();
      await control.click();
      await selectedAfterClick(control, attribute, name);
      return attribute === "aria-pressed" ? "Confirmed aria-pressed=true" : attribute === "section" ? "Confirmed the target section is in view" : "Confirmed the selected control has the active class";
    });
  }
  return seen.size;
}

/** Open the HISTORY popup, click its filter buttons (Buy/Sell there are only filters, not trades) and close the popup. */
async function exerciseHistory(run, page) {
  const history = await visible(page.locator(S.history).filter({ hasText: /^History$/ }));
  if (!history) return;
  const opened = await step(run, page, "Open the portfolio history", async () => {
    await history.click();
    await page.locator(S.historyPopup).waitFor({ state: "visible" });
    await page.locator(".transactions-popup .transactions > .empty-state, .transactions-popup .transactions > .content, .transactions-popup .transactions-filters").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".transactions-popup .transactions > .loading-state").waitFor({ state: "hidden" });
    return "History popup is visible";
  });
  if (!opened) return;
  try {
    // Buy/Sell here are history filters, strictly scoped inside the read-only popup.
    await exerciseGroup(run, page, S.historyFilters, "History filter", "class");
  } finally {
    const close = await visible(page.locator(S.historyClose));
    if (close && !run.cancelRequested) {
      await step(run, page, "Close the history popup", async () => {
        await close.click();
        await page.locator(S.historyPopup).waitFor({ state: "hidden" });
        return "History popup closed";
      });
    }
  }
}

/** Holdings list: switch back to All, expand See All, sort by each column, then collapse again. */
async function exerciseInvestments(run, page) {
  const all = await visible(page.locator(S.holdings).filter({ hasText: /^All\b/i }));
  if (all) await step(run, page, "Back to the All holdings tab", async () => {
    await all.click();
    await selectedAfterClick(all, "class");
    return "All holdings tab selected";
  });
  const groups = page.locator(S.investments);
  for (let i = 0; i < await groups.count(); i += 1) {
    const group = groups.nth(i);
    if (!await group.isVisible()) continue;
    const label = `Holdings list ${i + 1}`;
    const expand = await visible(group.locator(S.expandHoldings));
    if (expand) await step(run, page, `${label}: expand See All`, async () => {
      await expand.click();
      await group.locator(S.collapseHoldings).waitFor({ state: "visible" });
      return "Show Less appeared; all holdings are expanded";
    });
    const headers = group.locator(S.sortHoldings);
    for (let j = 0; j < await headers.count(); j += 1) {
      const header = headers.nth(j);
      if (!await header.isVisible()) continue;
      const title = (await header.innerText()).trim();
      await step(run, page, `${label}: sort by ${title}`, async () => {
        const arrow = header.locator('[data-icon="sort-up"], [data-icon="sort-down"]');
        const before = await arrow.count() ? await arrow.first().getAttribute("data-icon") : null;
        await header.click();
        await page.waitForFunction(({ el, previous }) => {
          const icon = el?.querySelector('[data-icon="sort-up"], [data-icon="sort-down"]')?.getAttribute("data-icon");
          return icon && icon !== previous;
        }, { el: await header.elementHandle(), previous: before }, { timeout: 5000 });
        return "Confirmed the sort direction indicator changed";
      });
    }
    const collapse = await visible(group.locator(S.collapseHoldings));
    if (collapse) await step(run, page, `${label}: collapse with Show Less`, async () => {
      await collapse.click();
      await group.locator(S.expandHoldings).waitFor({ state: "visible" });
      return "Collapsed again";
    });
  }
}

/** Find all personal portfolios and open each one for review; results go into run. */
export async function reviewPortfolios(page, run) {
  const list = await preparePortfolioList(page, run);
  const links = await list.locator(S.portfolioLinks).evaluateAll((elements) => elements.map((e) => ({
    name: e.getAttribute("aria-label") || e.querySelector("h5")?.textContent || e.textContent || "",
    href: e.getAttribute("href"),
  })));
  const portfolios = uniquePortfolios(links);
  run.discoveredPortfolios = portfolios.length;
  run.coverage = {
    scope: "Personal and team portfolio lists on My profile, excluding Trending/recommended portfolios",
    discovery: "Only recognises portfolio card links verified on the current site; may need adapting if the site structure changes",
    truncated: portfolios.length > MAX_PORTFOLIOS,
    limit: MAX_PORTFOLIOS,
  };
  if (!portfolios.length) {
    run.status = "needs_attention";
    run.currentStep = "No recognisable portfolio was found in the personal list; there may be none yet, or the page structure has changed.";
    return;
  }
  for (const portfolio of portfolios.slice(0, MAX_PORTFOLIOS)) {
    ensureNotStopped(run);
    run.currentPortfolio = portfolio.name;
    const record = { name: portfolio.name, url: portfolio.url, status: "running" };
    run.portfolios.push(record);
    if (new URL(page.url()).pathname.replace(/\/$/, "") !== new URL(PROFILE_URL).pathname) await preparePortfolioList(page, run);
    const candidates = page.locator(S.portfolios).locator(S.portfolioLinks);
    let target;
    for (let i = 0; i < await candidates.count(); i += 1) {
      const candidate = candidates.nth(i);
      if (await candidate.getAttribute("href") === portfolio.href && await candidate.isVisible()) { target = candidate; break; }
    }
    const firstStep = run.steps.length;
    const entered = await step(run, page, `Open portfolio: ${portfolio.name}`, async () => {
      if (!target) throw new Error("The portfolio link is not in the visible list; not clicking a guessed position.");
      await target.scrollIntoViewIfNeeded();
      await target.click();
      await page.waitForURL((url) => url.origin + url.pathname.replace(/\/$/, "") === portfolio.url.replace(/\/$/, ""), { timeout: 15000 });
      await page.locator(".portfolio-page .portfolio-header").waitFor({ state: "visible", timeout: 15000 });
      await page.locator(".portfolio-page .portfolio-chart-skeleton").waitFor({ state: "hidden", timeout: 20000 });
      return "Clicked the real portfolio link; the page URL matches the target";
    });
    if (!entered) { record.status = "failed"; continue; }
    const nameInput = page.locator('.portfolio-header .title-holder form.editable-title input[type="text"][readonly]');
    record.heading = await nameInput.count() ? await nameInput.first().inputValue() : (await page.locator(".portfolio-header .title-holder h5").allTextContents()).join(" ").trim();
    record.summary = (await page.locator(".portfolio-summary-rail").allTextContents()).join(" ").replace(/\s+/g, " ").trim().slice(0, 2500);
    record.sectionControls = await exerciseGroup(run, page, S.sections, "View portfolio section", "section");
    record.periodControls = await exerciseGroup(run, page, S.periods, "Switch chart period", "aria-pressed");
    record.holdingControls = await exerciseGroup(run, page, S.holdings, "Holding tab", "class");
    await exerciseInvestments(run, page);
    await exerciseHistory(run, page);
    record.status = run.steps.slice(firstStep).some((s) => s.status === "failed") ? "partial" : "passed";
    record.finishedAt = new Date().toISOString();
  }
  run.currentPortfolio = null;
  run.status = run.coverage.truncated || run.steps.some((s) => s.status === "failed") ? "partial" : "completed";
  run.currentStep = `Review finished: found ${run.discoveredPortfolios} portfolios, reviewed ${run.portfolios.length}.`;
  await overlay(page, run.currentStep + "\nResults are saved in reports/umushroom in the project. The window stays open." );
}

/** Background task: open the page -> wait for login -> go to Overview -> review all portfolios -> save the report. */
async function execute(run) {
  let page;
  try {
    page = await ensureUmushroomPage({ navigate: true, url: OVERVIEW_URL });
    run.session = await getSessionInfo();
    const deadline = Date.now() + TIMEOUTS.loginWait;
    while (true) {
      ensureNotStopped(run);
      run.login = await inspectLogin(page);
      if (run.login.state === "logged_in") break;
      if (run.login.state === "closed") throw new Error(run.login.message);
      run.status = "waiting_login";
      run.currentStep = run.login.message;
      await overlay(page, run.currentStep + "\nContinues automatically after you log in; waits up to 10 minutes.");
      if (Date.now() >= deadline) {
        run.status = "needs_login";
        run.currentStep = "Timed out waiting for login. The window stays open; run start_umushroom_review again after logging in.";
        return;
      }
      await sleep(1500);
    }
    run.status = "running";
    await openOverview(page, run);
    await reviewPortfolios(page, run);
  } catch (error) {
    run.status = run.cancelRequested ? "stopped" : "failed";
    run.currentStep = String(error.message).split(/\r?\n/)[0];
  } finally {
    run.finishedAt = new Date().toISOString();
    if (page && !page.isClosed()) await overlay(page, run.currentStep + "\nThe Google Chrome window stays open.");
    await saveReport(run).catch((error) => { run.reportError = error.message; });
  }
}

/** Save this review as reports/umushroom/<run-id>/report.json and report.md. */
async function saveReport(run) {
  const folder = join(PATHS.reports, run.id);
  await mkdir(folder, { recursive: true });
  run.reportPath = join(folder, "report.json");
  run.summaryPath = join(folder, "report.md");
  await writeFile(run.reportPath, JSON.stringify(run, null, 2), "utf8");
  const clean = (text) => String(text ?? "").replace(/[|\r\n]/g, " ");
  const md = ["# UMushroom click review", "", `Status: ${run.status}`, "", run.currentStep, "",
    "Scope: personal and team portfolio lists; nothing that changes the benchmark, trades, creates, edits, deletes, shares or publishes was clicked.", "",
    "| Portfolio | Step | Status | Evidence / reason |", "|---|---|---|---|",
    ...run.steps.map((s) => `| ${clean(s.portfolio)} | ${clean(s.label)} | ${s.status} | ${clean(s.error || s.evidence)} |`),
    "", "Not being logged in or finding no portfolios does not mean the portfolio review was completed.", ""];
  await writeFile(run.summaryPath, md.join("\n"), "utf8");
}

/** Start a background review and return the status right away; if one is already running, return its progress. */
export function startUmushroomReview() {
  if (active()) return getUmushroomReviewStatus();
  currentRun = { id: new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8), site: HOME_URL, overview: OVERVIEW_URL,
    status: "starting", startedAt: new Date().toISOString(), currentStep: "Opening the UMushroom home page in Google Chrome",
    login: { state: "unknown" }, discoveredPortfolios: 0, portfolios: [], steps: [], cancelRequested: false };
  worker = execute(currentRun);
  return getUmushroomReviewStatus();
}

/** Current progress: status, passed/failed counts, the last 10 steps, etc. */
export function getUmushroomReviewStatus() {
  if (!currentRun) return { status: "idle", site: HOME_URL, overview: OVERVIEW_URL, message: "Call open_umushroom or start_umushroom_review first." };
  const { steps, ...rest } = currentRun;
  return { ...rest, clicksAndChecks: { passed: steps.filter((s) => s.status === "passed").length, failed: steps.filter((s) => s.status === "failed").length }, recentSteps: steps.slice(-10) };
}

/** Ask to stop: no more clicks after the current action; completed results are kept. */
export function stopUmushroomReview() {
  if (active()) { currentRun.cancelRequested = true; currentRun.currentStep = "Stopping; no more clicks after the current action."; }
  return getUmushroomReviewStatus();
}
