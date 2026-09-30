// =============================================================================
// Local runtime configuration (the single source of configuration)
// -----------------------------------------------------------------------------
// All environment variables, local folders, timeouts and pacing values are read and defined here; other files only import them.
// Note: environment variables are read the first time this file is imported. A script that wants a different default
// (e.g. MCP_CHROME_MODE=profile) must set process.env before importing this file.
//
// Environment variables:
//   MCP_CHROME_MODE           auto (default: attach to your everyday Chrome, fall back to the project profile) / attach / profile
//   MCP_CHROME_CDP_URL        explicit debugging address of the Chrome to attach to (http://127.0.0.1:9222 or ws://...)
//   MCP_CHROME_USER_DATA_DIR  "User Data" folder of your everyday Chrome (used to find DevToolsActivePort)
//   MCP_CHROME_FALLBACK_DIR   project Chrome profile folder (default .browser-data\umushroom-profile)
//   MCP_CHROME_EXECUTABLE_PATH path to chrome.exe (default: the installed Google Chrome)
//   MCP_CHROME_CHANNEL        Playwright browser channel, default chrome
//   MCP_HEADLESS              true = run without a window (project-profile mode)
//   MCP_CHROME_SANDBOX        false = disable the Chromium sandbox
//   MCP_SLOW_MO               delay in ms between browser actions, default 300
//   MCP_LOG_MODE              off = disable journal mode (default on: snapshot the portfolio after every buy/sell)
//   MCP_LOG_OPEN              off = do not pop up the journal page (default: open it beside UMushroom every time)
//   MCP_LOG_PORT              local port of the journal page, default 6420
//   MCP_LOG_DIR               where journals are stored, default ./logs (tests point it to a temp folder)
// =============================================================================
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const env = process.env;

/** Project root (the parent of src). */
export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Local folders created by the project (all ignored in .gitignore). */
export const PATHS = Object.freeze({
  browserData: join(PROJECT_DIR, ".browser-data"),             // Chrome profile folders
  reports: join(PROJECT_DIR, "reports", "umushroom"),          // read-only review reports
  explore: join(PROJECT_DIR, ".explore"),                      // explore helper commands and results
  inspectorStorage: join(PROJECT_DIR, ".mcp-inspector", "storage"),
  mcpConfig: join(PROJECT_DIR, "mcp.json"),                    // MCP server config used by the Inspector
  logs: env.MCP_LOG_DIR || join(PROJECT_DIR, "logs"),          // portfolio journals (one sub-folder per portfolio)
  web: join(PROJECT_DIR, "web"),                               // static files of the journal page
});

/** Chrome settings. */
export const CHROME = Object.freeze({
  // Connection mode: auto / attach / profile
  mode: (env.MCP_CHROME_MODE || "auto").toLowerCase(),
  // Explicit debugging address (takes precedence over DevToolsActivePort)
  cdpUrl: env.MCP_CHROME_CDP_URL || "",
  // "User Data" root of your everyday Chrome that is logged in to UMushroom
  userDataDir: env.MCP_CHROME_USER_DATA_DIR ||
    join(env.LOCALAPPDATA || resolve(env.USERPROFILE || PROJECT_DIR, "AppData", "Local"), "Google", "Chrome", "User Data"),
  // Fallback: the project profile folder (log in once with npm run login and it stays logged in)
  fallbackProfileDir: env.MCP_CHROME_FALLBACK_DIR || join(PROJECT_DIR, ".browser-data", "umushroom-profile"),
  executablePath: env.MCP_CHROME_EXECUTABLE_PATH || "",
  channel: env.MCP_CHROME_CHANNEL || "chrome",
  headless: env.MCP_HEADLESS === "true",
  // Inside the Codex Windows sandbox, Chromium's own sandbox must be disabled
  sandbox: env.MCP_CHROME_SANDBOX === "false" ? false : !env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY,
  slowMo: Number(env.MCP_SLOW_MO ?? 300),
});

/** Journal mode settings. */
export const LOG = Object.freeze({
  enabled: env.MCP_LOG_MODE !== "off",   // snapshot the portfolio automatically after every buy/sell
  autoOpen: env.MCP_LOG_OPEN !== "off",  // pop up the journal page beside UMushroom when UMushroom is opened
  port: Number(env.MCP_LOG_PORT || 6420),
});

/** Timeouts and pacing (milliseconds). */
export const TIMEOUTS = Object.freeze({
  action: 8_000,          // default timeout of a single Playwright action
  navigation: 45_000,     // page navigation
  attach: 60_000,         // attaching to your everyday Chrome (waits for you to click "Allow remote debugging")
  loginWait: 10 * 60_000, // how long the read-only review waits for a manual login
  reviewPause: 1_000,     // pause after each review step so it can be watched
});

/** Maximum number of portfolios the read-only review checks. */
export const MAX_PORTFOLIOS = 100;

/** Wait for the given number of milliseconds. */
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Find chrome.exe of the local Google Chrome installation.
 * Uses MCP_CHROME_EXECUTABLE_PATH first, then the usual Windows install locations; returns undefined if not found.
 */
export function findChromeExecutable() {
  if (CHROME.executablePath && existsSync(CHROME.executablePath)) return CHROME.executablePath;
  return [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA]
    .filter(Boolean)
    .map((base) => join(base, "Google", "Chrome", "Application", "chrome.exe"))
    .find(existsSync);
}
