// =============================================================================
// Browser session and shared page helpers
// -----------------------------------------------------------------------------
// 1. Session: connect to Chrome and provide a UMushroom tab controlled by this project.
//    - attach  attach to your everyday Chrome (Chrome 144+, enable remote debugging at chrome://inspect/#remote-debugging)
//    - profile use the project profile folder .browser-data\umushroom-profile (log in once with npm run login)
//    - auto    try attach first, fall back to profile (default)
//    Since Chrome 136 automation may not launch the default user-data folder, so Playwright can no longer open your everyday profile.
// 2. Journal binding: the first time UMushroom is opened, the journal page pops up beside it (disable with MCP_LOG_OPEN=off);
//    actions started from the journal page run in a background worker tab (getWorkerPage).
// 3. Page helpers: find visible elements, show a progress box in the corner, detect the login state.
// =============================================================================
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { CHROME, LOG, TIMEOUTS, sleep } from "./config.js";
import { OVERVIEW_URL, SELECTORS as S } from "./site.js";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

// Current browser session (shared within the process): Promise<{ mode, browser?, context, ownedPages:Set<Page>, ... }>
let sessionPromise;

/**
 * Find the debugging address of a running Chrome.
 * 1. MCP_CHROME_CDP_URL (e.g. http://127.0.0.1:9222 or ws://...)
 * 2. After remote debugging is enabled at chrome://inspect/#remote-debugging, Chrome 144+ writes
 *    DevToolsActivePort into the User Data root (line 1: port, line 2: /devtools/browser/<id>).
 */
export async function findRunningChromeEndpoint() {
  if (CHROME.cdpUrl) return { endpoint: CHROME.cdpUrl, source: "MCP_CHROME_CDP_URL" };
  const file = join(CHROME.userDataDir, "DevToolsActivePort");
  let text;
  try { text = await readFile(file, "utf8"); } catch { return null; }
  const [port, path] = text.split(/\r?\n/).map((s) => s.trim());
  if (!/^\d+$/.test(port) || !path?.startsWith("/devtools/browser/")) return null;
  return { endpoint: `ws://127.0.0.1:${port}${path}`, source: file };
}

/** Option 1: attach to the everyday Chrome you are already using and logged in with. */
async function attachToRunningChrome() {
  const found = await findRunningChromeEndpoint();
  if (!found) {
    throw new Error("No running Chrome with remote debugging enabled was found (DevToolsActivePort is missing). " +
      "Open chrome://inspect/#remote-debugging in your everyday Chrome and enable remote debugging.");
  }
  // Chrome shows an "Allow remote debugging?" dialog when we connect; you must click "Allow". Leave plenty of time.
  const browser = await chromium.connectOverCDP(found.endpoint, { timeout: TIMEOUTS.attach, slowMo: CHROME.slowMo });
  const context = browser.contexts()[0] ?? await browser.newContext();
  return { mode: "attach", endpointSource: found.source, browser, context, ownedPages: new Set() };
}

/** Option 2: launch Chrome with the project profile folder (the login is stored in that folder). */
async function launchFallbackProfile() {
  const context = await chromium.launchPersistentContext(CHROME.fallbackProfileDir, {
    ...(CHROME.executablePath ? { executablePath: CHROME.executablePath } : { channel: CHROME.channel }),
    headless: CHROME.headless,
    slowMo: CHROME.slowMo,
    chromiumSandbox: CHROME.sandbox,
    viewport: null,
    args: ["--start-maximized"],
  });
  return { mode: "profile", profileDir: CHROME.fallbackProfileDir, context, ownedPages: new Set() };
}

/** Pick the connection mode from MCP_CHROME_MODE; in auto mode a failed attach falls back to the project profile. */
async function openSession() {
  const errors = [];
  if (CHROME.mode === "auto" || CHROME.mode === "attach") {
    try { return await attachToRunningChrome(); } catch (error) {
      errors.push(`Could not attach to your everyday Chrome: ${firstLine(error)}`);
      if (CHROME.mode === "attach") throw new Error(errors.join("\n"));
    }
  }
  try {
    const session = await launchFallbackProfile();
    if (errors.length) session.attachError = errors.join("\n");
    return session;
  } catch (error) {
    errors.push(`Could not launch the project Chrome profile: ${firstLine(error)}`);
    throw new Error(errors.join("\n"));
  }
}

/** First line of an error message (Playwright errors are usually long). */
function firstLine(error) { return String(error?.message ?? error).split(/\r?\n/)[0]; }

/** Lazily create and reuse the browser session; after the browser is closed or disconnected the next call reconnects. */
function getSession() {
  if (!sessionPromise) {
    const pending = openSession().then((session) => {
      session.context.setDefaultTimeout(TIMEOUTS.action);
      const reset = () => { if (sessionPromise === pending) sessionPromise = undefined; };
      session.context.once("close", reset);
      session.browser?.once("disconnected", reset);
      return session;
    });
    pending.catch(() => { if (sessionPromise === pending) sessionPromise = undefined; });
    sessionPromise = pending;
  }
  return sessionPromise;
}

/** Connection details of the current session (tells the user which Chrome is being used). */
export async function getSessionInfo() {
  const s = await getSession();
  return { mode: s.mode, ...(s.endpointSource ? { endpointSource: s.endpointSource } : {}), ...(s.profileDir ? { profileDir: s.profileDir } : {}), ...(s.attachError ? { attachError: s.attachError } : {}) };
}

/**
 * Return a UMushroom tab controlled by this project.
 * In attach mode a new tab is always opened, so your existing tabs are never touched.
 */
export async function ensureUmushroomPage({ navigate = false, url = OVERVIEW_URL } = {}) {
  const session = await getSession();
  let page = [...session.ownedPages].find((p) => !p.isClosed());
  if (!page && session.mode === "profile") {
    page = session.context.pages().find((p) => !p.isClosed() && p !== session.workerPage &&
      (p.url() === "about:blank" || /umushroom\.com/.test(p.url())));
  }
  if (!page) {
    page = await session.context.newPage();
    session.ownedPages.add(page);
    page.once("close", () => session.ownedPages.delete(page));
    navigate = true;
  }
  await page.bringToFront();
  if (navigate || page.url() === "about:blank") {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  }
  // Journal binding: the first time this session opens UMushroom, pop up the journal page beside it.
  // Only once; if you close the journal window it will not keep reappearing. Set MCP_LOG_OPEN=off to disable.
  if (LOG.autoOpen && !session.journalShown && /umushroom\.com/.test(page.url())) {
    session.journalShown = true;
    await showJournalBeside(page);
  }
  return page;
}

/** Start the journal service and open the journal page beside UMushroom; on failure only print a note, UMushroom keeps working. */
async function showJournalBeside(page) {
  try {
    const { ensureJournalService } = await import("./autolog.js"); // loaded dynamically to avoid a circular import
    await openSideWindow(await ensureJournalService());
    await page.bringToFront(); // give focus back to UMushroom
  } catch (error) {
    console.error(`The journal page did not open automatically: ${firstLine(error)}`);
  }
}

/**
 * Open url (the journal page) in a new Chrome window next to the UMushroom page.
 * If that URL is already open, just reload it and bring it to the front.
 * In project-profile mode the two windows are arranged as the left and right halves of the screen (left: UMushroom, right: journal);
 * in attach mode your own Chrome windows are not moved, only a new window is opened.
 */
export async function openSideWindow(url) {
  const session = await getSession();
  session.sidePages ??= new Map();
  const existing = session.sidePages.get(url);
  if (existing && !existing.isClosed()) {
    await existing.reload().catch(() => {});
    await existing.bringToFront();
    return existing;
  }
  const anchor = [...session.ownedPages].find((p) => !p.isClosed()) ??
    session.context.pages().find((p) => !p.isClosed() && p !== session.workerPage && /umushroom\.com/.test(p.url()));
  let page = null;
  if (anchor) {
    // Playwright's newPage() only opens tabs; the Chrome DevTools protocol can open a new window directly.
    try {
      const cdp = await session.context.newCDPSession(anchor);
      const opened = session.context.waitForEvent("page", { timeout: 10_000 });
      await cdp.send("Target.createTarget", { url, newWindow: true });
      page = await opened;
      await cdp.detach().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    } catch { page = null; }
  }
  if (!page) { // fallback: open a new tab
    page = await session.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  }
  session.sidePages.set(url, page);
  if (anchor && session.mode === "profile") await arrangeSideBySide(anchor, page).catch(() => {});
  return page;
}

/**
 * Background worker tab: actions started from the journal page (hourly updates, adding portfolios, buy/sell) run here,
 * so they never interrupt the UMushroom page you are looking at. It opens in the background without stealing focus and is recreated if closed.
 */
export async function getWorkerPage() {
  const session = await getSession();
  if (session.workerPage && !session.workerPage.isClosed()) return session.workerPage;
  const anchor = [...session.ownedPages].find((p) => !p.isClosed()) ??
    session.context.pages().find((p) => !p.isClosed() && /umushroom\.com/.test(p.url())) ??
    session.context.pages().find((p) => !p.isClosed());
  let page = null;
  if (anchor) {
    try { // create a background tab via the DevTools protocol (background: true does not switch to it)
      const cdp = await session.context.newCDPSession(anchor);
      const opened = session.context.waitForEvent("page", { timeout: 10_000 });
      await cdp.send("Target.createTarget", { url: "about:blank", background: true });
      page = await opened;
      await cdp.detach().catch(() => {});
    } catch { page = null; }
  }
  page ??= await session.context.newPage();
  session.workerPage = page;
  (session.sidePages ??= new Map()).set("worker", page); // closed together with the session in attach mode
  return page;
}

/**
 * Arrange the windows of two pages as the left and right halves of the screen.
 * The usable area is taken from the left window while it is maximised (Chrome starts with --start-maximized);
 * if it is not maximised, the screen area reported by the page is used.
 */
async function arrangeSideBySide(leftPage, rightPage) {
  const cdpLeft = await leftPage.context().newCDPSession(leftPage);
  const { bounds } = await cdpLeft.send("Browser.getWindowForTarget");
  await cdpLeft.detach().catch(() => {});
  const area = bounds.windowState === "maximized"
    ? { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height }
    : await leftPage.evaluate(() => ({ x: screen.availLeft ?? 0, y: screen.availTop ?? 0, w: screen.availWidth, h: screen.availHeight }));
  const half = Math.floor(area.w / 2);
  const place = async (page, left) => {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left, top: area.y, width: half, height: area.h } });
    await cdp.detach().catch(() => {});
  };
  await place(leftPage, area.x);
  await place(rightPage, area.x + half);
}

/**
 * Attach mode: close only the tabs this project opened and disconnect; your Chrome keeps running.
 * Project-profile mode: close the project Chrome window.
 */
export async function closeUmushroomSession() {
  const pending = sessionPromise;
  if (!pending) return;
  try {
    const session = await pending.catch(() => undefined);
    if (!session) return;
    if (session.mode === "attach") {
      for (const page of session.ownedPages) await page.close().catch(() => {});
      for (const page of session.sidePages?.values() ?? []) await page.close().catch(() => {});
      await session.browser.close().catch(() => {}); // with connectOverCDP this only disconnects; your Chrome is not closed
    } else {
      await session.context.close().catch(() => {});
    }
  } finally {
    if (sessionPromise === pending) sessionPromise = undefined;
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Return the first visible element matched by locator, or null if none is visible. */
export async function visible(locator) {
  for (let i = 0; i < await locator.count(); i += 1) {
    if (await locator.nth(i).isVisible()) return locator.nth(i);
  }
  return null;
}

/**
 * Detect the login state of the current page using only visible elements; never reads passwords, cookies or tokens.
 * Returns state: closed / unknown / region_required / login_required / logged_in.
 */
export async function inspectLogin(page) {
  if (page.isClosed()) return { state: "closed", message: "The project Google Chrome window has been closed." };
  const url = new URL(page.url());
  if (!/^(www\.)?umushroom\.com$/.test(url.hostname)) return { state: "unknown", message: `The current page is not on UMushroom (${url.hostname}); it may have been redirected to a login page.` };
  if (/\/(login|sign-?in|sign-?up|auth)(\/|$)/i.test(url.pathname)) {
    return { state: "login_required", message: "UMushroom redirected to its login page: this Chrome profile has no valid login." };
  }
  if (await visible(page.getByRole("heading", { name: "Confirm your region and language", exact: true }))) {
    return { state: "region_required", message: "Please confirm your region and language in this Google Chrome window, then log in." };
  }
  if (await visible(page.locator('input[type="password"]')) ||
      await visible(page.getByRole("button", { name: /^(Login|Login \/ Sign up|Log in|Sign in)$/i }))) {
    return { state: "login_required", message: "Please log in manually in this Google Chrome window; it uses Chrome's saved login." };
  }
  const ownList = await visible(page.locator(S.portfolios));
  const accountButton = await visible(page.locator(".header .profile-holder button.profile-trigger"));
  const welcome = await visible(page.locator(".my-overview .welcome-row h1"));
  if ((url.pathname === "/en/my-profile" && ownList) || accountButton || (url.pathname === "/en/my-overview" && welcome)) {
    return { state: "logged_in", message: "Detected the account button, welcome heading or personal portfolio list that only appear after login." };
  }
  return { state: "unknown", message: "Login state is not clear yet; please finish logging in and return to the UMushroom home page." };
}

/** Show an automation progress box in the bottom-right corner (does not block clicks; failures are ignored). */
export async function overlay(page, text) {
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

/** Poll the login state until it is no longer unknown or the time runs out (the SPA needs time to render). */
export async function waitForLoginState(page, ms = 15_000) {
  // After the SPA loads it takes a moment to render the account button / welcome heading, so poll until the state is clear.
  const deadline = Date.now() + ms;
  let login = await inspectLogin(page);
  while (login.state === "unknown" && Date.now() < deadline) {
    await sleep(1000);
    login = await inspectLogin(page);
  }
  return login;
}
