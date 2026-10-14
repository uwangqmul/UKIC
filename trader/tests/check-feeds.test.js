// Feed-check tests: the news-source list (docs/news-sources.json) is complete and consistent, and the checker classifies
// responses correctly. Uses a local HTTP server only; never contacts the real feeds. Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { buildChecks, checkSource, checkAlpaca, classify, latestDate, runChecks } from "../scripts/check-feeds.js";

const data = JSON.parse(await readFile(new URL("../docs/news-sources.json", import.meta.url), "utf8"));

// ---------- The source list ----------
test("source list: 40 assets with unique tickers; every stock has a SEC CIK, every fund an ISIN", () => {
  assert.equal(data.assets.length, 40);
  const tickers = data.assets.map((a) => a.ticker.split(" ")[0]);
  assert.equal(new Set(tickers).size, 40, "tickers must be unique");
  for (const a of data.assets) {
    assert.ok(a.group && a.name && a.umushroom && a.expect, `${a.ticker}: group, name, umushroom and expect are required`);
    if (a.isin) assert.match(a.isin, /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, `${a.ticker}: ISIN`);
    else assert.ok(Number.isInteger(a.cik) && a.cik > 0, `${a.ticker}: a stock needs its SEC CIK`);
  }
  // Exxon moved to Texas on 1 Jul 2026: the listed shares file under the new CIK
  assert.equal(data.assets.find((a) => a.ticker === "XOM").cik, 2115436);
  // Plain "Alphabet" is refused as ambiguous by the order code; the funds are ordered by ISIN (two products share the ticker GOLD)
  assert.equal(data.assets.find((a) => a.name.startsWith("Alphabet")).umushroom, "GOOGL");
  assert.equal(data.assets.find((a) => a.isin === "FR0013416716").umushroom, "FR0013416716");
});

test("source list: every feed has an https URL and a known type", () => {
  const all = [...data.assets.flatMap((a) => a.feeds), ...data.shared];
  for (const f of all) {
    assert.match(f.url, /^https:\/\//, f.name);
    assert.ok(["rss", "json", "html", "text"].includes(f.type), `${f.name}: type ${f.type}`);
    assert.ok([undefined, "feedreader", "contact"].includes(f.ua), `${f.name}: ua ${f.ua}`);
  }
  for (const s of data.shared) assert.ok([1, 2, 3].includes(s.tier), `${s.name}: tier`);
});

test("buildChecks: company feeds, then one SEC request per stock (10-digit CIK), then the shared sources", () => {
  const checks = buildChecks(data);
  const sec = checks.filter((c) => c.section === "SEC filings");
  assert.equal(sec.length, 38);
  assert.ok(sec.every((c) => c.ua === "contact"));
  assert.ok(sec.some((c) => c.url === "https://data.sec.gov/submissions/CIK0002115436.json"));
  const sections = checks.map((c) => c.section);
  assert.ok(sections.indexOf("SEC filings") > sections.lastIndexOf("Hedges"), "SEC checks come after all company feeds");
});

// ---------- Classification ----------
test("classify: blocked, missing, wrong type and OK", () => {
  assert.equal(classify(403, "text/html", "Just a moment...", "rss"), "BLOCKED");
  assert.equal(classify(429, "text/plain", "", "json"), "BLOCKED");
  assert.equal(classify(404, "text/html", "", "rss"), "MISSING");
  assert.equal(classify(500, "text/html", "", "rss"), "ERROR");
  assert.equal(classify(200, "text/html", "<!doctype html><html>", "rss"), "WRONG_TYPE", "an HTML page where a feed was expected");
  assert.equal(classify(200, "application/json", "<html>", "json"), "WRONG_TYPE");
  assert.equal(classify(200, "application/rss+xml", '<?xml version="1.0"?><rss version="2.0">', "rss"), "OK");
  assert.equal(classify(200, "application/atom+xml", '<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom">', "rss"), "OK");
});

test("latestDate: newest RSS/Atom/JSON date; escaped slashes are read; dates far in the future are ignored", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  assert.equal(latestDate("<item><pubDate>Wed, 30 Sep 2026 10:00:00 GMT</pubDate></item><item><pubDate>Thu, 01 Oct 2026 09:00:00 GMT</pubDate></item>", now), "2026-10-01 09:00");
  assert.equal(latestDate("<entry><updated>2026-09-28T07:00:00Z</updated></entry>", now), "2026-09-28 07:00");
  assert.equal(latestDate('{"filings":{"recent":{"filingDate":["2026-09-25","2026-09-01"]}}}', now), "2026-09-25 00:00");
  assert.ok(latestDate('{"PressReleaseDate":"09\\/24\\/2026 07:00:00"}', now).startsWith("2026-09-24"));
  // Scheduled maintenance on a status page is not "the latest news"
  assert.equal(latestDate("<pubDate>Thu, 29 Oct 2026 21:00:00 GMT</pubDate><pubDate>Tue, 29 Sep 2026 21:00:00 GMT</pubDate>", now), "2026-09-29 21:00");
  assert.equal(latestDate("no dates here", now), "");
});

// ---------- Fetching (local server) ----------
let server, base;
before(async () => {
  server = createServer((req, res) => {
    const ua = req.headers["user-agent"] ?? "";
    if (req.url === "/rss") { res.writeHead(200, { "content-type": "application/rss+xml" }); return res.end('<?xml version="1.0"?><rss><channel><item><pubDate>Thu, 01 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>'); }
    if (req.url === "/blocked") { res.writeHead(403, { "content-type": "text/html" }); return res.end("Just a moment..."); }
    if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><html><body>not a feed</body></html>"); }
    // Like investor.lilly.com: only answers a feed reader; like SEC: only answers a User-Agent with a contact
    if (req.url === "/feedreader") { res.writeHead(ua === "Feedly/1.0" ? 200 : 403, { "content-type": "application/rss+xml" }); return res.end("<rss></rss>"); }
    if (req.url === "/sec") { res.writeHead(/@/.test(ua) ? 200 : 403, { "content-type": "application/json" }); return res.end('{"filings":{"recent":{"filingDate":["2026-09-25"]}}}'); }
    if (req.url === "/news") { res.writeHead(req.headers["apca-api-key-id"] === "key" ? 200 : 401, { "content-type": "application/json" }); return res.end('{"news":[]}'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test("checkSource: OK with the latest date, BLOCKED, MISSING, WRONG_TYPE and network errors", async () => {
  const ok = await checkSource({ url: `${base}/rss`, type: "rss" });
  assert.deepEqual([ok.status, ok.http, ok.latest], ["OK", 200, "2026-10-01 09:00"]);
  assert.equal((await checkSource({ url: `${base}/blocked`, type: "rss" })).status, "BLOCKED");
  assert.equal((await checkSource({ url: `${base}/nope`, type: "rss" })).status, "MISSING");
  assert.equal((await checkSource({ url: `${base}/page`, type: "rss" })).status, "WRONG_TYPE");
  assert.equal((await checkSource({ url: "http://127.0.0.1:1/unreachable", type: "rss" })).status, "ERROR");
});

test("checkSource: feed-reader and contact User-Agents; SEC/BLS are skipped without a contact", async () => {
  assert.equal((await checkSource({ url: `${base}/feedreader`, type: "rss", ua: "feedreader" })).status, "OK");
  assert.equal((await checkSource({ url: `${base}/feedreader`, type: "rss" })).status, "BLOCKED", "a browser User-Agent is refused there");
  const skipped = await checkSource({ url: `${base}/sec`, type: "json", ua: "contact" });
  assert.equal(skipped.status, "SKIPPED");
  assert.match(skipped.note, /FEED_CONTACT/);
  assert.equal((await checkSource({ url: `${base}/sec`, type: "json", ua: "contact" }, { contact: "agent@example.com" })).status, "OK");
});

test("runChecks: keeps the order of the checks", async () => {
  const results = await runChecks([{ label: "a", url: `${base}/rss`, type: "rss" }, { label: "b", url: `${base}/blocked`, type: "rss" }, { label: "c", url: `${base}/page`, type: "html" }]);
  assert.deepEqual(results.map((r) => [r.label, r.status]), [["a", "OK"], ["b", "BLOCKED"], ["c", "OK"]]);
});

test("checkAlpaca: skipped without keys; REST sends the key headers; stream logs in and subscribes", async () => {
  const skipped = await checkAlpaca(data.alpaca, {});
  assert.deepEqual(skipped.map((r) => r.status), ["SKIPPED", "SKIPPED"]);

  // A fake stream that answers like Alpaca: connected -> auth -> authenticated -> subscribe -> subscription
  class FakeSocket {
    constructor() { setTimeout(() => this.reply([{ T: "success", msg: "connected" }])); }
    reply(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
    send(text) {
      const m = JSON.parse(text);
      if (m.action === "auth") setTimeout(() => this.reply(m.key === "key" ? [{ T: "success", msg: "authenticated" }] : [{ T: "error", code: 402, msg: "auth failed" }]));
      if (m.action === "subscribe") setTimeout(() => this.reply([{ T: "subscription", news: m.news }]));
    }
    close() {}
  }
  const alpaca = { rest: `${base}/news`, stream: "wss://example.invalid" };
  const good = await checkAlpaca(alpaca, { keyId: "key", secret: "s", WebSocketImpl: FakeSocket });
  assert.deepEqual(good.map((r) => r.status), ["OK", "OK"]);
  const bad = await checkAlpaca(alpaca, { keyId: "wrong", secret: "s", WebSocketImpl: FakeSocket });
  assert.deepEqual(bad.map((r) => r.status), ["BLOCKED", "BLOCKED"]);
  assert.match(bad[1].note, /402/);
});
