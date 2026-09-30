// =============================================================================
// Local server for the journal page
// -----------------------------------------------------------------------------
// Serves the journal page (web\journal.html) and the journal API at http://127.0.0.1:<port>/ :
//   GET /api/version            last modification time of the journals (the page polls every 5 s and refreshes on change)
//   GET /api/portfolios         every portfolio with a journal, with its latest summary
//   GET /api/portfolio?id=<id>  one portfolio's latest snapshot, all snapshots and activity
//   GET /api/status             hourly-update switch, next run time, last result, the task currently running
//   POST /api/<action>          adjust portfolios: available / track / untrack / refresh / setHourly / trade
// POST actions are provided by the journal service (autolog.js) via setDashboardActions; without them the server answers 503.
//
// Security: listens only on 127.0.0.1, so other devices on the network cannot reach it; a POST must carry the
// "x-umushroom-journal: 1" header and come from this page, so other websites cannot use your browser to call these actions.
// =============================================================================
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LOG, PATHS } from "./config.js";
import { listPortfolioLogs, logsVersion, readPortfolioLog } from "./journal.js";

const APP_ID = "umushroom-journal"; // identifies whether the service on a port is this project's journal service
let running;                         // the service started by this process: Promise<{ url, server }>
let actions = null;                  // actions provided by the journal service (registered with setDashboardActions)
const POST_ACTIONS = ["available", "track", "untrack", "refresh", "setHourly", "trade"];

/** Register the actions the journal page may call (called by autolog.js). */
export function setDashboardActions(value) { actions = value; }

/** Read a JSON request body (at most 64 KB). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; if (data.length > 65_536) reject(new Error("Request too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Malformed request")); } });
    req.on("error", reject);
  });
}

/** Origin check for POST requests: the custom header is required, and Origin (if present) must be this service itself. */
function allowedPost(req) {
  if (req.headers["x-umushroom-journal"] !== "1") return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

/** Send a JSON response. */
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Handle one request. */
async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(join(PATHS.web, "journal.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    if (url.pathname === "/api/version") return sendJson(res, 200, { app: APP_ID, version: await logsVersion() });
    if (url.pathname === "/api/portfolios") return sendJson(res, 200, await listPortfolioLogs());
    if (url.pathname === "/api/status") {
      return sendJson(res, 200, actions ? await actions.status() : { actions: false });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5);
      if (!allowedPost(req)) return sendJson(res, 403, { error: "Refused: the request did not come from the journal page" });
      if (!POST_ACTIONS.includes(name)) return sendJson(res, 404, { error: "No such action" });
      if (!actions) return sendJson(res, 503, { error: "The journal service has no browser attached, so portfolios cannot be adjusted. Open it with npm run open / npm run journal or by double-clicking start-umushroom.cmd." });
      try {
        return sendJson(res, 200, await actions[name](await readBody(req)));
      } catch (error) {
        const detail = error.result ? { preview: error.result.preview } : {};
        return sendJson(res, 400, { error: String(error.message).split(/\r?\n/)[0], ...detail });
      }
    }
    if (url.pathname === "/api/portfolio") {
      const log = await readPortfolioLog(url.searchParams.get("id") ?? "");
      return log ? sendJson(res, 200, log) : sendJson(res, 404, { error: "No journal for this portfolio" });
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

/** Check whether this project's journal service is already running on a port (e.g. started by the MCP server). */
async function isOurService(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).app === APP_ID;
  } catch { return false; }
}

/** Listen on port; returns null if the port is taken. */
function listen(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => { handle(req, res); });
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Start the journal page service and return its URL (repeated calls return the same one).
 * If this project's journal service is already running on the default port (started by another process), reuse it;
 * if the port is used by another program, try the next 10 ports.
 */
export function startDashboard() {
  running ??= (async () => {
    for (let port = LOG.port; port < LOG.port + 10; port += 1) {
      if (await isOurService(port)) return { url: `http://127.0.0.1:${port}/`, server: null };
      const server = await listen(port);
      if (server) {
        server.unref(); // do not keep the process alive just for the journal service
        return { url: `http://127.0.0.1:${port}/`, server };
      }
    }
    throw new Error(`Ports ${LOG.port}-${LOG.port + 9} are all in use, so the journal page cannot start. Use MCP_LOG_PORT to choose another port.`);
  })().catch((error) => { running = undefined; throw error; });
  return running.then(({ url }) => url);
}

/** Stop the journal service started by this process. */
export async function stopDashboard() {
  const current = running;
  running = undefined;
  const { server } = (await current?.catch(() => null)) ?? {};
  await new Promise((done) => (server ? server.close(() => done()) : done()));
}
