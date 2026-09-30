// =============================================================================
// Start the MCP Inspector and open its control page in a separate Chrome window (npm run inspect)
// -----------------------------------------------------------------------------
// The Inspector starts this project's MCP server (src/server.js) from mcp.json; tools can then be called by clicking buttons on the page.
// The Inspector page uses a fresh temporary Chrome profile inside the project (.browser-data\inspector-chrome-<timestamp>),
// so it never locks the Chrome profile used by the UMushroom automation.
// =============================================================================
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PATHS, PROJECT_DIR as projectDir, findChromeExecutable as findChrome, sleep } from "../src/config.js";

// Inspector launcher entry (exists only after npm install)
const inspectorEntry = join(
  projectDir,
  "node_modules",
  "@modelcontextprotocol",
  "inspector",
  "clients",
  "launcher",
  "build",
  "index.js",
);

/** Check whether a local port is free. */
function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** Find the first free port in a range. */
async function choosePortInRange(start, end, message) {
  for (let port = start; port <= end; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error(message);
}

/** Inspector web page port: 6384-6400. */
function chooseInspectorPort() {
  return choosePortInRange(6384, 6400, "Ports 6384-6400 are all in use; please close the old Inspector first.");
}

/** Debugging port of the Inspector's Chrome: 9222-9299 (used to confirm the page opened). */
function chooseChromeDebugPort() {
  return choosePortInRange(9222, 9299, "Ports 9222-9299 are all in use, so the Chrome tab cannot be verified.");
}

/** Whether two URLs point to the same page (ignoring a trailing slash and the hash). */
function sameUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin &&
      a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "") &&
      a.search === b.search;
  } catch {
    return false;
  }
}

/** Make a tab navigate to address via the Chrome DevTools protocol; returns true on success. */
function navigateWithCdp(webSocketUrl, address) {
  return new Promise((resolve) => {
    let finished = false;
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => finish(false), 5_000);
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(result);
    };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: address } }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id === 1) finish(!message.error);
      } catch {
        finish(false);
      }
    });
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("close", () => finish(false));
  });
}

/** Wait up to 12 seconds for a Chrome tab showing the Inspector; if there is none, navigate the first tab there. */
async function verifyAndNavigateChrome(debugPort, address) {
  const deadline = Date.now() + 12_000;
  let attemptedNavigation = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const tabs = await response.json();
      const pages = tabs.filter((tab) => tab.type === "page");
      if (pages.some((tab) => sameUrl(tab.url, address))) return true;
      const page = pages.find((tab) => tab.webSocketDebuggerUrl);
      if (page && !attemptedNavigation) {
        attemptedNavigation = true;
        await navigateWithCdp(page.webSocketDebuggerUrl, address);
      }
    } catch {
      // Chrome may need a few seconds to bring up its debugging endpoint.
    }
    await sleep(250);
  }
  return false;
}

/** Open the Inspector page with a separate temporary Chrome profile and confirm it opened. */
async function openInChrome(chromePath, address, debugPort) {
  // Keep the Inspector UI separate from the user's logged-in Chrome profile.
  // Otherwise the Inspector process would lock the profile that Playwright
  // needs for UMushroom and the automation could not start.
  // Use a fresh profile for each Inspector run so a stale about:blank tab or
  // a crashed Chrome session cannot swallow the new Inspector URL.
  const inspectorProfileDir = join(PATHS.browserData, `inspector-chrome-${Date.now()}`);
  const chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${inspectorProfileDir}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "--start-maximized",
      `--remote-debugging-port=${debugPort}`,
      "--remote-allow-origins=*",
      address,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    },
  );
  chrome.once("error", (error) => {
    console.error(`Could not open Google Chrome automatically: ${error.message}`);
    console.error("Please copy the full address printed by the Inspector above into the Chrome address bar.");
  });
  chrome.unref();
  const verified = await verifyAndNavigateChrome(debugPort, address);
  if (verified) {
    console.log(`Confirmed the current Google Chrome tab shows the Inspector: ${address}\n`);
  } else {
    console.error(`Chrome started but the Inspector tab could not be confirmed; please paste this address into the address bar: ${address}`);
  }
}

/** Start the Inspector and open its address in Chrome once it is printed. */
async function main() {
  if (!existsSync(inspectorEntry)) {
    throw new Error("MCP Inspector not found. Please run npm install in the project folder first.");
  }

  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error("Google Chrome not found. Make sure Chrome is installed, or set MCP_CHROME_EXECUTABLE_PATH.");
  }

  const port = await chooseInspectorPort();
  const chromeDebugPort = await chooseChromeDebugPort();
  const origin = `http://127.0.0.1:${port}`;
  const inspector = spawn(process.execPath, [inspectorEntry, "--web", "--config", PATHS.mcpConfig], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      CLIENT_PORT: String(port),
      ALLOWED_ORIGINS: `${origin},http://localhost:${port},http://[::1]:${port}`,
      MCP_STORAGE_DIR: PATHS.inspectorStorage,
      MCP_AUTO_OPEN_ENABLED: "false",
    },
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });

  let banner = "";
  let opened = false;
  inspector.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    if (opened) return;
    banner = (banner + chunk.toString()).slice(-8192);
    const match = banner.match(/MCP Inspector Web is up and running at:\s*(https?:\/\/[^\s]+)/);
    if (!match) return;

    const address = new URL(match[1]);
    if (address.hostname !== "127.0.0.1" || Number(address.port) !== port || !address.searchParams.has("MCP_INSPECTOR_API_TOKEN")) {
      console.error("The address printed by the Inspector is not what was expected, so Chrome was not opened automatically.");
      return;
    }
    opened = true;
    void openInChrome(chromePath, address.href, chromeDebugPort);
  });
  inspector.stderr.on("data", (chunk) => process.stderr.write(chunk));
  inspector.once("error", (error) => {
    console.error(`Failed to start the Inspector: ${error.message}`);
    process.exitCode = 1;
  });
  inspector.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  process.once("SIGINT", () => inspector.kill());
  process.once("SIGTERM", () => inspector.kill());
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
