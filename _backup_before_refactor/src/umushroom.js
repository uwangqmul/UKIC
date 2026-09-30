import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureUmushroomPage, closeUmushroomSession, getSessionInfo, HOME_URL, OVERVIEW_URL, PROJECT_DIR } from "./umushroom-session.js";
import { SELECTORS as S, PROFILE_URL, uniquePortfolios } from "./umushroom-policy.js";
import { buyStock, sellStock } from "./umushroom-trade.js";

const PAUSE_MS = 1000;
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const MAX_PORTFOLIOS = 100;
let currentRun;
let worker;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const active = () => currentRun && ["starting", "waiting_login", "running"].includes(currentRun.status);

async function visible(locator) {
  for (let i = 0; i < await locator.count(); i += 1) {
    if (await locator.nth(i).isVisible()) return locator.nth(i);
  }
  return null;
}

export async function inspectLogin(page) {
  if (page.isClosed()) return { state: "closed", message: "The project Google Chrome window has been closed." };
  const url = new URL(page.url());
  if (!/^(www\.)?umushroom\.com$/.test(url.hostname)) return { state: "unknown", message: `The current page is not on UMushroom (${url.hostname}); it may have been redirected to a sign-in page.` };
  if (/\/(login|sign-?in|sign-?up|auth)(\/|$)/i.test(url.pathname)) {
    return { state: "login_required", message: "UMushroom redirected to the sign-in page: the current Chrome profile has no valid sign-in." };
  }
  if (await visible(page.getByRole("heading", { name: "Confirm your region and language", exact: true }))) {
    return { state: "region_required", message: "Please confirm your region and language in this Google Chrome window, then sign in." };
  }
  if (await visible(page.locator('input[type="password"]')) ||
      await visible(page.getByRole("button", { name: /^(Login|Login \/ Sign up|Log in|Sign in)$/i }))) {
    return { state: "login_required", message: "Please sign in by hand in this Google Chrome window; it uses Chrome's sign-in state." };
  }
  const ownList = await visible(page.locator(S.portfolios));
  const accountButton = await visible(page.locator(".header .profile-holder button.profile-trigger"));
  const welcome = await visible(page.locator(".my-overview .welcome-row h1"));
  if ((url.pathname === "/en/my-profile" && ownList) || accountButton || (url.pathname === "/en/my-overview" && welcome)) {
    return { state: "logged_in", message: "Detected the signed-in account button, welcome heading or personal portfolio list." };
  }
  return { state: "unknown", message: "No clear login state detected yet; please finish signing in and return to the UMushroom home page." };
}

async function overlay(page, text) {
  await page.evaluate((message) => {
    let box = document.getElementById("mcp-umushroom-progress");
    if (!box) {
      box = document.createElement("div");
      box.id = "mcp-umushroom-progress";
      box.style.cssText = "position:fixed;right:16px;bottom:18px;z-index:2147483647;max-width:440px;padding:14px 18px;border-radius:12px;background:#17332f;color:white;font:14px/1.6 sans-serif;box-shadow:0 4px 24px #0005;pointer-events:none;white-space:pre-wrap";
      document.body.appendChild(box);
    }
    box.textContent = "MCP · UMushroom automation\n" + message;
  }, text).catch(() => {});
}

function ensureNotStopped(run) {
  if (run.cancelRequested) throw new Error("The review was stopped");
}

async function step(run, page, label, action) {
  ensureNotStopped(run);
  run.currentStep = label;
  await overlay(page, label);
  const entry = { label, portfolio: run.currentPortfolio ?? null, startedAt: new Date().toISOString(), status: "running" };
  run.steps.push(entry);
  try {
    const evidence = await action();
    ensureNotStopped(run);
    await sleep(run.pauseMs ?? PAUSE_MS);
    entry.status = "passed";
    entry.evidence = evidence ?? "Action completed";
    return true;
  } catch (error) {
    entry.status = run.cancelRequested ? "stopped" : "failed";
    entry.error = String(error.message).split(/\r?\n/)[0];
    ensureNotStopped(run);
    return false;
  } finally { entry.finishedAt = new Date().toISOString(); }
}

async function waitForLoginState(page, ms = 15_000) {
  // After the SPA loads it takes a moment to render the account button / welcome heading; poll until the state is clear.
  const deadline = Date.now() + ms;
  let login = await inspectLogin(page);
  while (login.state === "unknown" && Date.now() < deadline) {
    await sleep(1000);
    login = await inspectLogin(page);
  }
  return login;
}

export async function openUmushroom() {
  if (active()) return getUmushroomReviewStatus();
  // Open My Overview directly: nothing to do by hand when Chrome is already signed in.
  const page = await ensureUmushroomPage({ navigate: true, url: OVERVIEW_URL });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const login = await waitForLoginState(page);
  const session = await getSessionInfo();
  await overlay(page, login.message);
  return { site: HOME_URL, overview: OVERVIEW_URL, currentUrl: page.url(), title: await page.title().catch(() => ""), browser: "Google Chrome", session, login, browserKeptOpen: true };
}

export async function checkUmushroomLogin() {
  if (active()) return { login: currentRun.login, ...getUmushroomReviewStatus() };
  const page = await ensureUmushroomPage();
  return { site: HOME_URL, overview: OVERVIEW_URL, currentUrl: page.url(), browser: "Google Chrome", session: await getSessionInfo(), login: await waitForLoginState(page, 5_000) };
}

async function openOverview(page, run) {
  const current = new URL(page.url());
  const expected = new URL(OVERVIEW_URL);
  if (current.origin === expected.origin && current.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "")) return true;
  const opened = await step(run, page, "Go to My Overview to start the portfolio review", async () => {
    await page.goto(OVERVIEW_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return "Entered My Overview";
  });
  if (!opened) throw new Error("Could not open UMushroom My Overview after signing in.");
  return true;
}

async function preparePortfolioList(page, run) {
  const opened = await step(run, page, "Go to the My portfolios personal list", async () => {
    const link = await visible(page.getByRole("link", { name: /^My portfolios$/i }));
    if (link) await link.click();
    else await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator(S.portfolios).waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(S.portfolios + ' .items[aria-busy="false"]').waitFor({ timeout: 20_000 });
    return link ? "Clicked My portfolios; the personal list has loaded" : "Opened /en/my-profile; the personal list has loaded (navigated directly in this step)";
  });
  if (!opened) throw new Error("Personal portfolio list not found. The site structure may have changed or sign-in is not finished. Public Trending portfolios were not scanned.");
  const listSwitch = page.locator(S.listView).nth(1);
  if (await listSwitch.isVisible()) {
    const switched = await step(run, page, "Switch personal portfolios to list view", async () => {
      await listSwitch.click();
      await page.locator(S.portfolios + ' .items[aria-busy="false"]').waitFor();
      return "List view is on";
    });
    if (!switched) throw new Error("Could not switch to list view, so it cannot be confirmed that every portfolio was found.");
  }
  const expand = await visible(page.locator(S.portfolios).locator(S.showMore).filter({ hasText: /^Show more$/i }));
  if (expand) {
    const expanded = await step(run, page, "Expand all personal portfolios (Show more)", async () => {
      await expand.click();
      await page.locator(S.portfolios).locator(S.showMore).filter({ hasText: /^Show less$/i }).waitFor();
      return "Expanded the portfolios hidden by default";
    });
    if (!expanded) throw new Error("The personal list could not be fully expanded; stopping to avoid reporting completion after missing some.");
  }
  return page.locator(S.portfolios);
}

const sectionTargets = [
  [/^overview$/i, ".portfolio-dashboard"],
  [/^asset allocation$/i, ".dashboard-side"],
  [/^investments$/i, ".holdings-workspace"],
  [/^strategy$/i, ".portfolio-story-grid"],
  [/^ratings$/i, ".reviews-section"],
  [/^comparable etfs$/i, ".portfolio-carousel-section"],
];

async function selectedAfterClick(locator, attribute, name = "") {
  if (attribute === "section") {
    const targetSelector = sectionTargets.find(([pattern]) => pattern.test(name))?.[1];
    if (!targetSelector) throw new Error(`No confirmed read-only section locator found for "${name}"`);
    const target = locator.page().locator(targetSelector).first();
    await target.waitFor({ state: "visible", timeout: 5000 });
    await target.scrollIntoViewIfNeeded();
    const inViewport = await target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top < window.innerHeight && box.bottom > 0;
    });
    if (!inViewport) throw new Error(`Section "${name}" did not scroll into view`);
    return;
  }
  if (attribute === "aria-pressed") {
    await locator.page().waitForFunction((el) => el?.getAttribute("aria-pressed") === "true", await locator.elementHandle(), { timeout: 5000 });
  } else {
    await locator.page().waitForFunction((el) => el?.classList.contains("active"), await locator.elementHandle(), { timeout: 5000 });
  }
}

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
      return attribute === "aria-pressed" ? "Confirmed aria-pressed=true" : attribute === "section" ? "Confirmed the target section scrolled into view" : "Confirmed the selected control has the active state";
    });
  }
  return seen.size;
}

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

async function exerciseInvestments(run, page) {
  const all = await visible(page.locator(S.holdings).filter({ hasText: /^All\b/i }));
  if (all) await step(run, page, "Back to the All holdings category", async () => {
    await all.click();
    await selectedAfterClick(all, "class");
    return "All holdings category is selected";
  });
  const groups = page.locator(S.investments);
  for (let i = 0; i < await groups.count(); i += 1) {
    const group = groups.nth(i);
    if (!await group.isVisible()) continue;
    const label = `Holdings list ${i + 1}`;
    const expand = await visible(group.locator(S.expandHoldings));
    if (expand) await step(run, page, `${label}: expand with See All`, async () => {
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
      return "Collapsed state restored";
    });
  }
}

export async function reviewPortfolios(page, run) {
  const list = await preparePortfolioList(page, run);
  const links = await list.locator(S.portfolioLinks).evaluateAll((elements) => elements.map((e) => ({
    name: e.getAttribute("aria-label") || e.querySelector("h5")?.textContent || e.textContent || "",
    href: e.getAttribute("href"),
  })));
  const portfolios = uniquePortfolios(links);
  run.discoveredPortfolios = portfolios.length;
  run.coverage = {
    scope: "Personal and team portfolio lists in My profile, excluding Trending/recommended portfolios",
    discovery: "Only recognizes portfolio card links confirmed on the current site; may need adapting if the site structure changes",
    truncated: portfolios.length > MAX_PORTFOLIOS,
    limit: MAX_PORTFOLIOS,
  };
  if (!portfolios.length) {
    run.status = "needs_attention";
    run.currentStep = "No recognizable portfolio found in the personal list; there may be none yet or the page structure has changed.";
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
      if (!target) throw new Error("The portfolio link is not in the visible list; no guessed position was clicked.");
      await target.scrollIntoViewIfNeeded();
      await target.click();
      await page.waitForURL((url) => url.origin + url.pathname.replace(/\/$/, "") === portfolio.url.replace(/\/$/, ""), { timeout: 15000 });
      await page.locator(".portfolio-page .portfolio-header").waitFor({ state: "visible", timeout: 15000 });
      await page.locator(".portfolio-page .portfolio-chart-skeleton").waitFor({ state: "hidden", timeout: 20000 });
      return "Clicked the real portfolio link; the detail URL matches the target";
    });
    if (!entered) { record.status = "failed"; continue; }
    const nameInput = page.locator('.portfolio-header .title-holder form.editable-title input[type="text"][readonly]');
    record.heading = await nameInput.count() ? await nameInput.first().inputValue() : (await page.locator(".portfolio-header .title-holder h5").allTextContents()).join(" ").trim();
    record.summary = (await page.locator(".portfolio-summary-rail").allTextContents()).join(" ").replace(/\s+/g, " ").trim().slice(0, 2500);
    record.sectionControls = await exerciseGroup(run, page, S.sections, "View portfolio section", "section");
    record.periodControls = await exerciseGroup(run, page, S.periods, "Switch chart period", "aria-pressed");
    record.holdingControls = await exerciseGroup(run, page, S.holdings, "Holdings category", "class");
    await exerciseInvestments(run, page);
    await exerciseHistory(run, page);
    record.status = run.steps.slice(firstStep).some((s) => s.status === "failed") ? "partial" : "passed";
    record.finishedAt = new Date().toISOString();
  }
  run.currentPortfolio = null;
  run.status = run.coverage.truncated || run.steps.some((s) => s.status === "failed") ? "partial" : "completed";
  run.currentStep = `Review finished: found ${run.discoveredPortfolios} portfolios, reviewed ${run.portfolios.length}.`;
  await overlay(page, run.currentStep + "\nResults are saved in the project's reports/umushroom. The window stays open." );
}

async function execute(run) {
  let page;
  try {
    page = await ensureUmushroomPage({ navigate: true, url: OVERVIEW_URL });
    run.session = await getSessionInfo();
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (true) {
      ensureNotStopped(run);
      run.login = await inspectLogin(page);
      if (run.login.state === "logged_in") break;
      if (run.login.state === "closed") throw new Error(run.login.message);
      run.status = "waiting_login";
      run.currentStep = run.login.message;
      await overlay(page, run.currentStep + "\nIt continues automatically after you sign in, waiting up to 10 minutes.");
      if (Date.now() >= deadline) {
        run.status = "needs_login";
        run.currentStep = "Timed out waiting for sign-in. The window stays open; run start_umushroom_review again after signing in.";
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

async function saveReport(run) {
  const folder = join(PROJECT_DIR, "reports", "umushroom", run.id);
  await mkdir(folder, { recursive: true });
  run.reportPath = join(folder, "report.json");
  run.summaryPath = join(folder, "report.md");
  await writeFile(run.reportPath, JSON.stringify(run, null, 2), "utf8");
  const clean = (text) => String(text ?? "").replace(/[|\r\n]/g, " ");
  const md = ["# UMushroom click review", "", `Status: ${run.status}`, "", run.currentStep, "",
    "Scope: personal and team portfolio lists; nothing that changes the benchmark, trades, creates, edits, deletes, shares or publishes was clicked.", "",
    "| Portfolio | Step | Status | Verification / reason |", "|---|---|---|---|",
    ...run.steps.map((s) => `| ${clean(s.portfolio)} | ${clean(s.label)} | ${s.status} | ${clean(s.error || s.evidence)} |`),
    "", "If not signed in or no portfolio was found, this does not mean the portfolio review is complete.", ""];
  await writeFile(run.summaryPath, md.join("\n"), "utf8");
}

export function startUmushroomReview() {
  if (active()) return getUmushroomReviewStatus();
  currentRun = { id: new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8), site: HOME_URL, overview: OVERVIEW_URL,
    status: "starting", startedAt: new Date().toISOString(), currentStep: "Open the UMushroom home page in Google Chrome",
    login: { state: "unknown" }, discoveredPortfolios: 0, portfolios: [], steps: [], cancelRequested: false };
  worker = execute(currentRun);
  return getUmushroomReviewStatus();
}

export function getUmushroomReviewStatus() {
  if (!currentRun) return { status: "idle", site: HOME_URL, overview: OVERVIEW_URL, message: "Call open_umushroom or start_umushroom_review first." };
  const { steps, ...rest } = currentRun;
  return { ...rest, clicksAndChecks: { passed: steps.filter((s) => s.status === "passed").length, failed: steps.filter((s) => s.status === "failed").length }, recentSteps: steps.slice(-10) };
}

export function stopUmushroomReview() {
  if (active()) { currentRun.cancelRequested = true; currentRun.currentStep = "Stopping; no more clicks after the current action finishes."; }
  return getUmushroomReviewStatus();
}

export async function closeUmushroom() {
  stopUmushroomReview();
  await closeUmushroomSession();
  await worker;
  return { status: "closed", message: "Closed the UMushroom tab this project opened (in attach mode your Chrome keeps running)." };
}

/** Buy / sell (paper portfolios). Preview only by default; submit=true actually submits. */
export async function tradeUmushroom(kind, options) {
  if (active()) throw new Error("A portfolio review is running; call stop_umushroom_review before trading.");
  const page = await ensureUmushroomPage({ navigate: false });
  const login = await inspectLogin(page);
  if (login.state === "login_required" || login.state === "region_required") throw new Error(login.message);
  await overlay(page, `${kind === "buy" ? "Buy" : "Sell"} ${options.company}${options.submit ? " (submit)" : " (preview only)"}`);
  const result = kind === "buy" ? await buyStock(page, options) : await sellStock(page, options);
  await overlay(page, `${kind === "buy" ? "Buy" : "Sell"} ${options.company}: ${result.submitted ? "submitted" : "preview done, not submitted"}`);
  return result;
}
