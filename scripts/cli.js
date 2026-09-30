// =============================================================================
// Command-line entry point: every npm script runs through here
// -----------------------------------------------------------------------------
//   npm run login                one-time login: open the project profile in a normal Chrome and log in to UMushroom by hand
//   npm run open                 open My Overview without logging in and print the login state (Ctrl+C to stop)
//   npm run trade -- <buy|sell> <company> [--portfolio name] [--portfolio-index N]
//                    [--shares N|all | --amount N] [--submit]
//                                buy / sell; preview only by default, add --submit to place the order
//   npm run umushroom            read-only review of all portfolios with a report (Ctrl+C to stop)
//   npm run log -- <portfolio name> [--portfolio-index N]
//                                journal mode: snapshot a portfolio and open the journal page beside it (Ctrl+C to stop)
//   npm run journal              open only the journal page (portfolios can be adjusted there; updates every full hour while running; Ctrl+C to stop)
//
// Every command loads src/ with a dynamic import, so environment-variable defaults can be set before the configuration is read.
// =============================================================================
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const [command] = process.argv.slice(2);
const commandArgs = process.argv.slice(3);

/** Run cleanup on Ctrl+C / termination signals (registered once). */
function onExit(cleanup) {
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

// -----------------------------------------------------------------------------
// login: Google blocks sign-ins in browsers controlled by automation ("This browser or app may not be secure"),
// so a plain Chrome without any automation flags opens the project profile folder and you log in once by hand.
// -----------------------------------------------------------------------------
async function login() {
  const { CHROME, findChromeExecutable } = await import("../src/config.js");
  const { OVERVIEW_URL } = await import("../src/site.js");
  const chrome = findChromeExecutable();
  if (!chrome) {
    console.error("Google Chrome was not found; please set MCP_CHROME_EXECUTABLE_PATH.");
    process.exit(1);
  }
  const child = spawn(chrome, [
    `--user-data-dir=${CHROME.fallbackProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    OVERVIEW_URL,
  ], { stdio: "ignore", windowsHide: false });

  console.log(`Opened Chrome in normal mode (profile folder: ${CHROME.fallbackProfileDir}).`);
  console.log("Log in to UMushroom in this window, and once you see My Overview, CLOSE THIS CHROME WINDOW.");
  console.log("After the window is closed, run: $env:MCP_CHROME_MODE='profile'; npm run open");
  // On Windows the chrome.exe launcher exits immediately, so it cannot tell when the window closes; do not wait for it.
  child.unref();
}

// -----------------------------------------------------------------------------
// open: smoke test. Connect to Chrome, open My Overview, print the login state, then keep running until Ctrl+C.
// -----------------------------------------------------------------------------
async function open() {
  const { openUmushroom, closeUmushroom } = await import("../src/umushroom.js");
  console.log("Connecting to Google Chrome and opening https://umushroom.com/en/my-overview ...");
  console.log("If Chrome asks \"Allow remote debugging?\", click \"Allow\".");
  try {
    const result = await openUmushroom();
    console.log(JSON.stringify(result, null, 2));
    console.log(result.session?.mode === "attach"
      ? "Mode: attached to your everyday Chrome."
      : "Mode: project Chrome profile (not attached to your everyday Chrome). To log in here, run npm run login first.");
    console.log(result.login.state === "logged_in"
      ? "✅ My Overview opened without logging in. Press Ctrl+C to stop."
      : "⚠️ The page is open but the login state could not be confirmed; see login.message above. Press Ctrl+C to stop.");
  } catch (error) {
    console.error("❌ Failed to open:\n" + error.message);
    process.exitCode = 1;
  }

  // In attach mode only the tab opened by this script is closed; your Chrome keeps running.
  async function shutdown() {
    await closeUmushroom().catch(() => {});
    process.exit(process.exitCode ?? 0);
  }
  onExit(shutdown);
  if (process.exitCode) await shutdown();
  else setInterval(() => {}, 1 << 30); // keep the process alive so the page can be inspected
}

// -----------------------------------------------------------------------------
// trade: buy / sell. Uses the logged-in project Chrome profile by default (profile mode).
// -----------------------------------------------------------------------------
async function trade() {
  const { positionals, values } = parseArgs({
    args: commandArgs,
    allowPositionals: true,
    options: {
      portfolio: { type: "string" }, "portfolio-index": { type: "string" },
      shares: { type: "string" }, amount: { type: "string" }, submit: { type: "boolean", default: false },
    },
  });
  const [kind, ...rest] = positionals;
  const company = rest.join(" ");
  if (!["buy", "sell"].includes(kind) || !company) {
    console.error('Usage: npm run trade -- <buy|sell> <company> [--portfolio name] [--shares N|all | --amount N] [--submit]');
    process.exit(1);
  }
  process.env.MCP_CHROME_MODE ||= "profile"; // must be set before src/ is loaded
  const { tradeUmushroom, closeUmushroom } = await import("../src/umushroom.js");
  const options = {
    company, portfolio: values.portfolio, submit: values.submit,
    portfolioIndex: values["portfolio-index"] ? Number(values["portfolio-index"]) : undefined,
    shares: values.shares === "all" ? "all" : values.shares ? Number(values.shares) : undefined,
    amount: values.amount ? Number(values.amount) : undefined,
  };
  try {
    console.log(JSON.stringify(await tradeUmushroom(kind, options), null, 2));
    console.log(options.submit ? "✅ Submitted." : "ℹ️ Preview only, nothing submitted; add --submit once everything looks right.");
  } catch (error) {
    console.error("❌ " + error.message);
    if (error.result) console.error(JSON.stringify(error.result, null, 2)); // preview data already read before the error
    process.exitCode = 1;
  } finally {
    await closeUmushroom().catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// review: read-only review. Prints progress changes every 1.5 s and the full result at the end.
// -----------------------------------------------------------------------------
async function review() {
  const { startUmushroomReview, getUmushroomReviewStatus, closeUmushroom } = await import("../src/umushroom.js");
  console.log("Opening the UMushroom home page in the logged-in Google Chrome; on first use confirm your region and log in.");
  console.log("After login the portfolios are reviewed automatically, slowed down so each step can be seen. Press Ctrl+C to stop and close Chrome.");
  startUmushroomReview();
  let previous = "";
  const timer = setInterval(() => {
    const status = getUmushroomReviewStatus();
    const message = `[${status.status}] ${status.currentStep}`;
    if (message !== previous) { console.log(message); previous = message; }
    const finished = !["starting", "waiting_login", "running"].includes(status.status);
    if (finished && (status.summaryPath || status.reportError)) {
      clearInterval(timer);
      console.log(JSON.stringify(status, null, 2));
      console.log("The review has stopped; the Google Chrome window stays open for inspection. Press Ctrl+C to exit.");
    }
  }, 1500);

  onExit(async () => {
    clearInterval(timer);
    await closeUmushroom();
    process.exit(0);
  });
}

// -----------------------------------------------------------------------------
// log / journal: journal mode. Uses the logged-in project Chrome profile by default (profile mode).
// The journal page stays online while this runs; Ctrl+C stops and closes the windows this project opened.
// -----------------------------------------------------------------------------
async function log() {
  const { positionals, values } = parseArgs({
    args: commandArgs, allowPositionals: true,
    options: { "portfolio-index": { type: "string" } },
  });
  const portfolio = positionals.join(" ");
  if (!portfolio) {
    console.error('Usage: npm run log -- <portfolio name> [--portfolio-index N]   e.g. npm run log -- "First Portfolio"');
    process.exit(1);
  }
  process.env.MCP_CHROME_MODE ||= "profile"; // must be set before src/ is loaded
  const { logPortfolio, closeUmushroom } = await import("../src/umushroom.js");
  onExit(async () => { await closeUmushroom().catch(() => {}); process.exit(process.exitCode ?? 0); });
  try {
    const portfolioIndex = values["portfolio-index"] ? Number(values["portfolio-index"]) : undefined;
    const result = await logPortfolio({ portfolio, portfolioIndex, open: true });
    console.log(JSON.stringify(result, null, 2));
    console.log(`✅ Recorded ${result.portfolio.name}: ${result.holdings.length} holdings, ${result.pending.length} pending orders, ${result.transactions} transactions.`);
    console.log(`Journal page: ${result.journalUrl} (open in the window beside UMushroom). Press Ctrl+C to stop.`);
    setInterval(() => {}, 1 << 30); // keep the journal page service online
  } catch (error) {
    console.error("❌ Recording failed: " + error.message);
    process.exitCode = 1;
    await closeUmushroom().catch(() => {});
  }
}

async function journal() {
  process.env.MCP_CHROME_MODE ||= "profile";
  const { openJournal, closeUmushroom } = await import("../src/umushroom.js");
  onExit(async () => { await closeUmushroom().catch(() => {}); process.exit(0); });
  const { url } = await openJournal();
  console.log(`Journal page: ${url} (opened in Chrome; any browser can also visit it). Press Ctrl+C to stop.`);
  setInterval(() => {}, 1 << 30);
}

// -----------------------------------------------------------------------------
const commands = { login, open, trade, review, log, journal };
if (!commands[command]) {
  console.error(`Unknown command: ${command ?? "(none)"}. Available: ${Object.keys(commands).join(" / ")}`);
  process.exit(1);
}
await commands[command]();
