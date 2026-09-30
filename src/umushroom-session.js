import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

export const HOME_URL = "https://umushroom.com/";
export const OVERVIEW_URL = "https://umushroom.com/en/my-overview";
export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Root User Data folder of the Chrome you use every day and are already signed in to UMushroom with.
export const CHROME_USER_DATA_DIR = process.env.MCP_CHROME_USER_DATA_DIR ||
  join(process.env.LOCALAPPDATA || resolve(process.env.USERPROFILE || PROJECT_DIR, "AppData", "Local"), "Google", "Chrome", "User Data");

// Fallback: the project's own Chrome profile folder (sign in by hand once, then it stays signed in).
export const FALLBACK_PROFILE_DIR = process.env.MCP_CHROME_FALLBACK_DIR || join(PROJECT_DIR, ".browser-data", "umushroom-profile");

// auto: attach to the running Chrome first, then fall back to the project profile; attach: attach only; profile: project profile only.
const MODE = (process.env.MCP_CHROME_MODE || "auto").toLowerCase();
const SLOW_MO = Number(process.env.MCP_SLOW_MO ?? 300);
const chromiumSandbox = process.env.MCP_CHROME_SANDBOX === "false" ? false :
  !process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY;

let sessionPromise; // Promise<{ mode, browser?, context, ownedPages:Set<Page> }>

/**
 * Find the debugging address of the running Chrome.
 * 1. MCP_CHROME_CDP_URL (e.g. http://127.0.0.1:9222 or ws://...)
 * 2. After remote debugging is enabled at chrome://inspect/#remote-debugging, Chrome 144+
 *    writes DevToolsActivePort into the User Data root (line 1: port, line 2: /devtools/browser/<id>).
 */
export async function findRunningChromeEndpoint() {
  if (process.env.MCP_CHROME_CDP_URL) return { endpoint: process.env.MCP_CHROME_CDP_URL, source: "MCP_CHROME_CDP_URL" };
  const file = join(CHROME_USER_DATA_DIR, "DevToolsActivePort");
  let text;
  try { text = await readFile(file, "utf8"); } catch { return null; }
  const [port, path] = text.split(/\r?\n/).map((s) => s.trim());
  if (!/^\d+$/.test(port) || !path?.startsWith("/devtools/browser/")) return null;
  return { endpoint: `ws://127.0.0.1:${port}${path}`, source: file };
}

async function attachToRunningChrome() {
  const found = await findRunningChromeEndpoint();
  if (!found) {
    throw new Error("No running Chrome with remote debugging enabled was found (DevToolsActivePort is missing). " +
      "Open chrome://inspect/#remote-debugging in your everyday Chrome and enable remote debugging.");
  }
  // When connecting, Chrome shows an "Allow remote debugging?" dialog that you must click "Allow" on. Allow plenty of time.
  const browser = await chromium.connectOverCDP(found.endpoint, { timeout: 60_000, slowMo: SLOW_MO });
  const context = browser.contexts()[0] ?? await browser.newContext();
  return { mode: "attach", endpointSource: found.source, browser, context, ownedPages: new Set() };
}

async function launchFallbackProfile() {
  const context = await chromium.launchPersistentContext(FALLBACK_PROFILE_DIR, {
    ...(process.env.MCP_CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.MCP_CHROME_EXECUTABLE_PATH }
      : { channel: process.env.MCP_CHROME_CHANNEL || "chrome" }),
    headless: process.env.MCP_HEADLESS === "true",
    slowMo: SLOW_MO,
    chromiumSandbox,
    viewport: null,
    args: ["--start-maximized"],
  });
  return { mode: "profile", profileDir: FALLBACK_PROFILE_DIR, context, ownedPages: new Set() };
}

async function openSession() {
  const errors = [];
  if (MODE === "auto" || MODE === "attach") {
    try { return await attachToRunningChrome(); } catch (error) {
      errors.push(`Attaching to your everyday Chrome failed: ${firstLine(error)}`);
      if (MODE === "attach") throw new Error(errors.join("\n"));
    }
  }
  try {
    const session = await launchFallbackProfile();
    if (errors.length) session.attachError = errors.join("\n");
    return session;
  } catch (error) {
    errors.push(`Launching the project Chrome profile failed: ${firstLine(error)}`);
    throw new Error(errors.join("\n"));
  }
}

function firstLine(error) { return String(error?.message ?? error).split(/\r?\n/)[0]; }

function getSession() {
  if (!sessionPromise) {
    const pending = openSession().then((session) => {
      session.context.setDefaultTimeout(8_000);
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

export async function getSessionInfo() {
  const s = await getSession();
  return { mode: s.mode, ...(s.endpointSource ? { endpointSource: s.endpointSource } : {}), ...(s.profileDir ? { profileDir: s.profileDir } : {}), ...(s.attachError ? { attachError: s.attachError } : {}) };
}

/**
 * Return a UMushroom tab controlled by this project.
 * In attach mode it always opens a new tab and never touches your existing tabs.
 */
export async function ensureUmushroomPage({ navigate = false, url = OVERVIEW_URL } = {}) {
  const session = await getSession();
  let page = [...session.ownedPages].find((p) => !p.isClosed());
  if (!page && session.mode === "profile") {
    page = session.context.pages().find((p) => !p.isClosed() && (p.url() === "about:blank" || /umushroom\.com/.test(p.url())));
  }
  if (!page) {
    page = await session.context.newPage();
    session.ownedPages.add(page);
    page.once("close", () => session.ownedPages.delete(page));
    navigate = true;
  }
  await page.bringToFront();
  if (navigate || page.url() === "about:blank") {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  return page;
}

/**
 * Attach mode: only close the tabs this project opened and disconnect; your Chrome keeps running.
 * Profile mode: close the project Chrome window.
 */
export async function closeUmushroomSession() {
  const pending = sessionPromise;
  if (!pending) return;
  try {
    const session = await pending.catch(() => undefined);
    if (!session) return;
    if (session.mode === "attach") {
      for (const page of session.ownedPages) await page.close().catch(() => {});
      await session.browser.close().catch(() => {}); // with connectOverCDP this only disconnects and does not close your Chrome
    } else {
      await session.context.close().catch(() => {});
    }
  } finally {
    if (sessionPromise === pending) sessionPromise = undefined;
  }
}
