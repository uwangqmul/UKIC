// =============================================================================
// Feed check: fetch every news source in docs/news-sources.json once and report which ones work from this machine
// -----------------------------------------------------------------------------
//   npm run check-feeds
// Optional environment variables (PowerShell: $env:NAME='value'):
//   FEED_CONTACT        contact e-mail for the User-Agent that SEC EDGAR and BLS require (e.g. ukic-agent@yourdomain.com);
//                       without it the SEC/BLS checks are skipped. Use a dedicated address, not a personal one.
//   ALPACA_KEY_ID       Alpaca API key: tests the Alpaca/Benzinga news REST endpoint and the live news stream
//   ALPACA_SECRET_KEY   Alpaca API secret
// Read-only: only GET requests (and one WebSocket login to Alpaca); nothing is posted or ordered.
// Results are printed and saved to reports/feed-check.json (reports/ is not committed).
// Status: OK | BLOCKED (401/403/406/429: the site refuses scripts) | MISSING (404/410) | WRONG_TYPE (e.g. an HTML page
// where a feed was expected) | ERROR (network/timeout) | SKIPPED (missing FEED_CONTACT or Alpaca keys).
// =============================================================================
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_FILE = join(PROJECT_DIR, "docs", "news-sources.json");
const REPORT_FILE = join(PROJECT_DIR, "reports", "feed-check.json");
const TIMEOUT_MS = 15_000;

/** User-Agent per source: most sites want a browser, some only answer feed readers, SEC/BLS require a contact. */
export function userAgent(kind, contact) {
  if (kind === "feedreader") return "Feedly/1.0"; // exactly this: investor.lilly.com refuses longer variants
  if (kind === "contact") return contact ? `UKIC news check ${contact}` : null;
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
}

/**
 * Newest date found in a feed or JSON body (RSS/Atom item dates, Q4 press-release lists, SEC filings), as "YYYY-MM-DD HH:MM" UTC;
 * "" if none. Dates more than 2 days ahead (scheduled maintenance, future publication dates) are ignored.
 */
export function latestDate(body, now = Date.now()) {
  const text = String(body ?? "").replace(/\\\//g, "/"); // JSON may escape "/" as "\/"
  const dates = [];
  for (const m of text.matchAll(/<(pubDate|updated|dc:date|published)>\s*(?:<!\[CDATA\[)?([^<\]]+)/gi)) dates.push(m[2]);
  for (const m of text.matchAll(/"(?:PressReleaseDate|filingDate|publication_date|created_at)"\s*:\s*\[?\s*"([^"]+)"/g)) dates.push(m[1]);
  const times = dates.map((d) => Date.parse(d.trim())).filter((t) => Number.isFinite(t) && t <= now + 2 * 86_400_000);
  return times.length ? new Date(Math.max(...times)).toISOString().slice(0, 16).replace("T", " ") : "";
}

/** Classify one HTTP response for a source of the given type (rss | json | html | text). */
export function classify(status, contentType, body, type) {
  if ([401, 403, 406, 429].includes(status)) return "BLOCKED";
  if ([404, 410].includes(status)) return "MISSING";
  if (status < 200 || status >= 300) return "ERROR";
  const head = String(body ?? "").slice(0, 2000).trimStart();
  if (type === "rss" && !/<(rss|feed|rdf:RDF)[\s>]/i.test(head)) return "WRONG_TYPE";
  if (type === "json") { try { JSON.parse(body); } catch { return "WRONG_TYPE"; } }
  if (type === "html" && !/html/i.test(contentType ?? "") && !/<html/i.test(head)) return "WRONG_TYPE";
  return "OK";
}

/** Fetch one source and return { status, http, latest, note }. Never throws. */
export async function checkSource(source, { contact, fetchImpl = fetch } = {}) {
  const ua = userAgent(source.ua, contact);
  if (!ua) return { status: "SKIPPED", http: null, latest: "", note: "set FEED_CONTACT (SEC/BLS require a contact e-mail)" };
  try {
    const res = await fetchImpl(source.url, { headers: { "user-agent": ua, accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    const status = classify(res.status, res.headers.get("content-type"), body, source.type);
    return { status, http: res.status, latest: status === "OK" ? latestDate(body) : "", note: "" };
  } catch (error) {
    return { status: "ERROR", http: null, latest: "", note: error.cause?.code ?? error.name ?? String(error) };
  }
}

/** Every check to run: company feeds, then one SEC filings request per stock, then the shared sources. */
export function buildChecks(data) {
  const checks = [];
  const ticker = (a) => a.ticker.split(" ")[0];
  for (const a of data.assets) for (const f of a.feeds) checks.push({ section: a.group, label: `${ticker(a)}: ${f.name}`, ...f });
  for (const a of data.assets.filter((x) => x.cik)) {
    const cik10 = String(a.cik).padStart(10, "0");
    checks.push({ section: "SEC filings", label: `${ticker(a)}: CIK ${a.cik}`, url: data.secFilingsUrl.replace("{cik10}", cik10), type: "json", ua: "contact" });
  }
  for (const s of data.shared) checks.push({ section: s.group, label: s.name, ...s });
  return checks;
}

/** Run checks a few at a time (SEC allows at most 10 requests per second; this stays well below). */
export async function runChecks(checks, options = {}, concurrency = 4) {
  const results = new Array(checks.length);
  let next = 0;
  const worker = async () => {
    while (next < checks.length) {
      const i = next++;
      results[i] = { ...checks[i], ...(await checkSource(checks[i], options)) };
      if (checks[i].ua === "contact") await new Promise((r) => setTimeout(r, 250)); // be gentle with SEC/BLS
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** Alpaca news: REST endpoint and live stream login + subscription (needs ALPACA_KEY_ID / ALPACA_SECRET_KEY). */
export async function checkAlpaca(alpaca, { keyId, secret, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!keyId || !secret) {
    const skipped = { status: "SKIPPED", http: null, latest: "", note: "set ALPACA_KEY_ID and ALPACA_SECRET_KEY" };
    return [{ section: "Alpaca", label: "Alpaca news REST", ...skipped }, { section: "Alpaca", label: "Alpaca live news stream", ...skipped }];
  }
  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
  const rest = await checkSource({ url: alpaca.rest, type: "json" }, { fetchImpl: (url, init) => fetchImpl(url, { ...init, headers: { ...init.headers, ...headers } }) });
  const stream = await new Promise((done) => {
    if (!WebSocketImpl) return done({ status: "SKIPPED", http: null, latest: "", note: "this Node.js has no WebSocket (needs Node 22+)" });
    const ws = new WebSocketImpl(alpaca.stream);
    const finish = (status, note) => { clearTimeout(timer); try { ws.close(); } catch {} done({ status, http: null, latest: "", note }); };
    const timer = setTimeout(() => finish("ERROR", "no answer within 15 s"), TIMEOUT_MS);
    ws.onerror = () => finish("ERROR", "connection failed");
    ws.onmessage = (event) => {
      let messages;
      try { messages = [].concat(JSON.parse(String(event.data))); } catch { return finish("ERROR", "unreadable message"); }
      for (const m of messages) {
        if (m.T === "success" && m.msg === "connected") ws.send(JSON.stringify({ action: "auth", key: keyId, secret }));
        else if (m.T === "success" && m.msg === "authenticated") ws.send(JSON.stringify({ action: "subscribe", news: ["*"] }));
        else if (m.T === "subscription") return finish("OK", "logged in and subscribed to all news");
        else if (m.T === "error") return finish(m.code === 402 || m.code === 403 || m.code === 409 ? "BLOCKED" : "ERROR", `${m.code} ${m.msg}`);
      }
    };
  });
  return [{ section: "Alpaca", label: "Alpaca news REST", ...rest }, { section: "Alpaca", label: "Alpaca live news stream", ...stream }];
}

/** Print the results grouped by section, then a summary. */
function print(results) {
  let section = "";
  for (const r of results) {
    if (r.section !== section) { section = r.section; console.log(`\n== ${section} ==`); }
    const extra = r.latest ? ` (latest ${r.latest})` : r.note ? ` (${r.note})` : r.http ? ` (HTTP ${r.http})` : "";
    console.log(`  ${r.status.padEnd(10)} ${r.label}${extra}`);
  }
  const counts = results.reduce((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {});
  console.log(`\nSummary: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
}

async function main() {
  const data = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  const contact = process.env.FEED_CONTACT?.trim() || "";
  const checks = buildChecks(data);
  console.log(`Checking ${checks.length} sources from ${SOURCES_FILE} ...`);
  const results = [...await runChecks(checks, { contact }),
    ...await checkAlpaca(data.alpaca, { keyId: process.env.ALPACA_KEY_ID, secret: process.env.ALPACA_SECRET_KEY })];
  print(results);
  await mkdir(dirname(REPORT_FILE), { recursive: true });
  await writeFile(REPORT_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  console.log(`Saved to ${REPORT_FILE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
