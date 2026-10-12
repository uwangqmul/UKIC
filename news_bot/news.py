"""
Stock news collector and notifier: collect -> filter -> de-duplicate -> Telegram

Sources:
  - Google News search (per company: market news, product launches, contracts)
  - Yahoo Finance ticker news (US-listed stocks)
  - Official company sources (config.json "official"): newsroom/IR RSS feeds, investor-site JSON press-release lists,
    or a Google News search limited to the company's own news pages; a feed can have a fallback used only when it fails
  - US Department of Defense daily contract announcements

Usage: python news.py
"""
import html
import json
import logging
import re
import sqlite3
import time
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

from telegram_bot import send_message  # also loads .env
import jev

BASE = Path(__file__).resolve().parent
CONFIG = json.loads((BASE / "config.json").read_text(encoding="utf-8"))
DB_PATH = BASE / "alerts.db"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
}
FEED_READER_UA = "Feedly/1.0"  # exactly this: some IR sites (e.g. investor.lilly.com) only answer feed readers
ATOM = "{http://www.w3.org/2005/Atom}"
TG_LIMIT = 3800  # Telegram's limit is 4096 characters per message; keep a margin

TAGS = {"official": "🏢 Official", "contract": "🛡️ Contract/Defense", "news": "📰 News"}
CONTRACT_RE = re.compile(
    r"\b(contracts?|awarded|award|Pentagon|Army|Navy|Air Force|Space Force|Marine Corps|DoD|"
    r"Department of (Defense|War)|DARPA|missile|defen[cs]e deal)\b", re.I)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(BASE / "stock_alert.log", encoding="utf-8"), logging.StreamHandler()],
)
log = logging.getLogger("news")
for noisy in ("httpx", "httpx2", "typesafe_sdk"):
    logging.getLogger(noisy).setLevel(logging.WARNING)


# ---------- Database ----------
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY, symbol TEXT, title TEXT, link TEXT,
            source TEXT, published TEXT, summary TEXT,
            status TEXT DEFAULT 'pending', created_at TEXT)"""
    )
    cols = [r[1] for r in conn.execute("PRAGMA table_info(articles)")]
    for col, typ in [("tag", "TEXT DEFAULT 'news'"), ("jev_label", "TEXT"), ("jev_prob", "REAL"),
                     ("jev_impact", "REAL"), ("jev_rel", "REAL")]:
        if col not in cols:
            conn.execute(f"ALTER TABLE articles ADD COLUMN {col} {typ}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_symbol_link ON articles(symbol, link)")
    return conn


# ---------- Helpers ----------
def clean(text):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def shorten(text, limit):
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def parse_date(value):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).astimezone(timezone.utc)
    except Exception:
        pass
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def keyword_patterns(keywords):
    """English keywords match whole words, case-sensitive (so "intelligence" is not Intel and
    "10 micron" is not Micron). Non-ASCII keywords (e.g. Chinese) match as plain substrings."""
    pats = []
    for k in keywords:
        if re.search(r"[^\x00-\x7f]", k):
            pats.append(re.compile(re.escape(k)))
        else:
            pats.append(re.compile(r"(?<![\w.$])" + re.escape(k) + r"(?![\w])"))
    return pats


def first_match(text, pats):
    for p in pats:
        m = p.search(text)
        if m:
            return m
    return None


def excerpt(text, m, width=160):
    start = max(0, m.start() - 20)
    snippet = text[start:start + width]
    return ("…" if start else "") + snippet.strip() + ("…" if start + width < len(text) else "")


def title_key(title):
    """Strip the trailing " - Publisher" from Google News titles so duplicates match across sources."""
    return re.sub(r"\s+[-–|]\s+[^-–|]{2,40}$", "", title).lower().strip()


def us_eastern_to_utc(naive):
    """US Eastern wall-clock time -> UTC (EDT from the 2nd Sunday of March to the 1st Sunday of November, 2am)."""
    y = naive.year
    march = datetime(y, 3, 8 + (6 - datetime(y, 3, 8).weekday()) % 7, 2)
    november = datetime(y, 11, 1 + (6 - datetime(y, 11, 1).weekday()) % 7, 2)
    offset = 4 if march <= naive < november else 5
    return (naive + timedelta(hours=offset)).replace(tzinfo=timezone.utc)


def json_items(data, url):
    """Investor-site press-release lists (".../feed/PressRelease.svc/GetPressReleaseList", used by Corning, P&G,
    J&J, Netflix). Dates are US Eastern ("10/07/2026 08:08:00"); links are relative to the site."""
    site = re.sub(r"^(https?://[^/]+).*", r"\1", url)
    items = []
    for r in data.get("GetPressReleaseListResult") or []:
        try:
            published = us_eastern_to_utc(datetime.strptime(r.get("PressReleaseDate", ""), "%m/%d/%Y %H:%M:%S"))
        except ValueError:
            published = None
        link = r.get("LinkToDetailPage") or ""
        items.append({
            "title": clean(r.get("Headline")),
            "link": urllib.parse.urljoin(site + "/", link) if link else "",
            "guid": str(r.get("PressReleaseId") or ""),
            "source": re.sub(r"^https?://(www\.)?([^/]+).*", r"\2", url),
            "published": published,
            "text": clean(r.get("ShortBody") or r.get("ShortDescription") or ""),
        })
    return [i for i in items if i["title"] and i["link"]]


# ---------- Collection ----------
def fetch_source(url, kind="rss", ua=None, retries=2):
    """Returns (ok, items). ok is False when the source could not be read (blocked, offline, not a feed)."""
    headers = {**HEADERS, "User-Agent": FEED_READER_UA} if ua == "feedreader" else HEADERS
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, headers=headers, timeout=20)
            r.raise_for_status()
            if kind == "json":
                return True, json_items(r.json(), url)
            root = ET.fromstring(r.content)
            break
        except Exception as e:
            if attempt == retries:
                log.warning("Source unavailable: %s (%s)", url[:90], str(e)[:120])
                return False, []
            time.sleep(2)

    default_source = re.sub(r"^https?://(www\.)?([^/]+).*", r"\2", url)
    items = []
    # RSS 2.0
    for it in root.iter("item"):
        src_el = it.find("source")
        items.append({
            "title": clean(it.findtext("title")),
            "link": (it.findtext("link") or "").strip(),
            "guid": (it.findtext("guid") or "").strip(),
            "source": clean(src_el.text) if src_el is not None and src_el.text else default_source,
            "published": parse_date(it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date")),
            "text": clean(it.findtext("description") or it.findtext("{http://purl.org/rss/1.0/modules/content/}encoded")),
        })
    # Atom (e.g. Apple Newsroom)
    for e in root.iter(f"{ATOM}entry"):
        link_el = e.find(f"{ATOM}link[@rel='alternate']")
        if link_el is None:
            link_el = e.find(f"{ATOM}link")
        items.append({
            "title": clean(e.findtext(f"{ATOM}title")),
            "link": link_el.get("href", "").strip() if link_el is not None else "",
            "guid": (e.findtext(f"{ATOM}id") or "").strip(),
            "source": default_source,
            "published": parse_date(e.findtext(f"{ATOM}published") or e.findtext(f"{ATOM}updated")),
            "text": clean(e.findtext(f"{ATOM}summary") or e.findtext(f"{ATOM}content")),
        })
    return True, [i for i in items if i["title"] and i["link"]]


def fetch_feed(url, retries=2):
    return fetch_source(url, retries=retries)[1]


def google_url(query):
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"})


def source_spec(entry):
    """An "official" entry -> {url, type, ua, fallback}. An entry is a feed URL, or an object with "url" (and optional
    "type": "rss"/"json", "ua": "feedreader") or "search" (a Google News search, e.g. "site:rtx.com/news"), and an
    optional "fallback" entry that is read only when the main source fails."""
    if isinstance(entry, str):
        entry = {"url": entry}
    if entry.get("search"):
        spec = {"url": google_url(entry["search"] + " when:3d"), "type": "rss", "ua": None}
    else:
        spec = {"url": entry["url"], "type": entry.get("type", "rss"), "ua": entry.get("ua")}
    spec["fallback"] = source_spec(entry["fallback"]) if entry.get("fallback") else None
    return spec


def fetch_official(spec):
    ok, items = fetch_source(spec["url"], spec["type"], spec["ua"])
    if not ok and spec["fallback"]:
        log.info("Using the fallback for %s", spec["url"][:90])
        return fetch_official(spec["fallback"])
    return items


def build_jobs():
    """Return [(source, kind, symbols)]; source is a URL or an official-source spec; symbols=None means match every
    company by keyword."""
    jobs = []
    yahoo_syms = []
    for s in CONFIG["stocks"]:
        jobs.append((google_url(s["query"] + s.get("suffix", CONFIG["google_suffix"])), "news", [s["symbol"]]))
        if s.get("contracts"):
            jobs.append((google_url(s["query"] + CONFIG["contract_suffix"]), "contract", [s["symbol"]]))
        for entry in s.get("official", []):
            jobs.append((source_spec(entry), "official", [s["symbol"]]))
        if s.get("yahoo", True):
            yahoo_syms.append(s["symbol"])
    for i in range(0, len(yahoo_syms), 10):
        chunk = ",".join(yahoo_syms[i:i + 10])
        jobs.append((f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={chunk}&region=US&lang=en-US", "news", None))
    for g in CONFIG.get("global_sources", []):
        jobs.append((g["url"], g.get("type", "news"), None))
    return jobs


def collect():
    """Fetch all sources and return {symbol: {title_key: item}}."""
    stocks = {s["symbol"]: s for s in CONFIG["stocks"]}
    pats = {sym: keyword_patterns(s["keywords"]) for sym, s in stocks.items()}
    excl = {sym: keyword_patterns(s.get("exclude", [])) for sym, s in stocks.items()}
    cutoff = datetime.now(timezone.utc) - timedelta(days=CONFIG.get("max_age_days", 3))
    jobs = build_jobs()

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda j: fetch_official(j[0]) if isinstance(j[0], dict) else fetch_feed(j[0]), jobs))

    found = {sym: {} for sym in stocks}
    for (url, kind, syms), items in zip(jobs, results):
        for it in items:
            if it["published"] and it["published"] < cutoff:
                continue
            candidates = syms or list(stocks)
            for sym in candidates:
                full = f"{it['title']} {it['text']}"
                m = first_match(full, pats[sym])
                if kind != "official" and not m:
                    continue  # official newsroom items need no keyword; everything else must mention the company
                if first_match(it["title"], excl[sym]):
                    continue  # same name, different company (e.g. Owens Corning)
                is_dod = kind == "contract" and syms is None
                if kind == "official":
                    tag = "official"
                elif is_dod or CONTRACT_RE.search(it["title"]):
                    tag = "contract"
                else:
                    tag = "news"
                text = it["text"]
                if text.startswith(it["title"][:30]):
                    text = ""  # Google News descriptions often just repeat the title
                title = it["title"]
                if is_dod:
                    # A DoD announcement lists every contract of the day; keep the part about this company
                    tm = first_match(text, pats[sym])
                    title = "DoD contract: " + (excerpt(text, tm, 150) if tm else title)
                    summary = ""
                else:
                    tm = first_match(text, pats[sym])
                    summary = excerpt(text, tm) if (tm and len(text) > 200 and tm.start() > 120) else shorten(text, 200)
                item = dict(it, title=title, tag=tag, summary=summary)
                key = title_key(it["title"])
                prev = found[sym].get(key)
                # Same story from several sources: prefer the official/contract tag
                if prev is None or (prev["tag"] == "news" and tag != "news"):
                    found[sym][key] = item
    log.info("Requested %d sources, %d returned items", len(jobs), sum(1 for r in results if r))
    return found


# ---------- Notifications ----------
def esc(s):
    return html.escape(s or "", quote=False)


def fmt_time(iso):
    if not iso:
        return "unknown"
    return datetime.fromisoformat(iso).astimezone().strftime("%m-%d %H:%M")


def format_single(stock, a):
    lines = [f"{TAGS.get(a['tag'], '📰 News')} | <b>{esc(stock['symbol'])} {esc(stock['name'])}</b>", "",
             f"<b>{esc(a['title'])}</b>",
             f"Source: {esc(a['source'])} | Time: {fmt_time(a['published'])}"]
    if a["summary"]:
        lines.append(f"Summary: {esc(a['summary'])}")
    if a.get("jev"):
        lines.append(esc(jev.line(a["jev"])))
    lines.append(f'<a href="{html.escape(a["link"])}">Read more</a>')
    return "\n".join(lines)


def format_digest(stocks, rows, header):
    """Digest grouped by company, split into several messages if needed."""
    groups = {}
    for a in rows:
        groups.setdefault(a["symbol"], []).append(a)
    blocks = []
    for sym, items in groups.items():
        s = stocks.get(sym, {"symbol": sym, "name": ""})
        head = f"<b>[{esc(s['symbol'])} {esc(s['name'])}]</b>"
        judged = [a["jev"]["label"] for a in items if a.get("jev")]
        if judged:
            head += " " + " ".join(f"{jev.ICONS[k]}{judged.count(k)}" for k in ("up", "down", "neutral")
                                   if judged.count(k))
        lines = [head]
        for a in items:
            icon = TAGS.get(a["tag"], "📰").split()[0]
            lines.append(f'{icon} <a href="{html.escape(a["link"])}">{esc(shorten(a["title"], 120))}</a>'
                         f"{esc(jev.badge(a.get('jev')))}"
                         f" ({esc(shorten(a['source'], 25))}, {fmt_time(a['published'])})")
        blocks.append("\n".join(lines))
    messages, cur = [], header
    for b in blocks:
        if len(cur) + len(b) + 2 > TG_LIMIT:
            messages.append(cur)
            cur = ""
        cur += ("\n\n" if cur else "") + b
    if cur:
        messages.append(cur)
    return messages


def run_once():
    conn = db()
    now = datetime.now(timezone.utc).isoformat()
    stocks = {s["symbol"]: s for s in CONFIG["stocks"]}
    found = collect()
    per_run = CONFIG["max_items_per_stock_per_run"]
    new_stocks = []

    for sym, items in found.items():
        first_time = conn.execute("SELECT 1 FROM articles WHERE symbol=? LIMIT 1", (sym,)).fetchone() is None
        new = [i for i in items.values()
               if not conn.execute("SELECT 1 FROM articles WHERE symbol=? AND (id=? OR link=?)",
                                   (sym, f"{sym}:{i['guid'] or i['link']}", i["link"])).fetchone()]
        # Official/contract items first, then newest first
        new.sort(key=lambda i: (i["tag"] == "news", -(i["published"].timestamp() if i["published"] else 0)))
        limit = 1 if first_time else per_run  # a newly added company sends only its latest item; the rest are marked read
        if first_time and new:
            new_stocks.append(sym)
        for idx, i in enumerate(new):
            conn.execute(
                "INSERT OR IGNORE INTO articles (id, symbol, title, link, source, published, summary, status, created_at, tag) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (f"{sym}:{i['guid'] or i['link']}", sym, i["title"], i["link"], i["source"],
                 i["published"].isoformat() if i["published"] else None, i["summary"],
                 "pending" if idx < limit else "skipped", now, i["tag"]),
            )
        if new:
            log.info("%s: %d new (%d to send)", sym, len(new), min(len(new), limit))
    conn.commit()

    cols = ["id", "symbol", "title", "link", "source", "published", "summary", "tag",
            "jev_label", "jev_prob", "jev_impact", "jev_rel"]
    rows = [dict(zip(cols, r)) for r in conn.execute(
        f"SELECT {', '.join(cols)} FROM articles WHERE status='pending' ORDER BY symbol, published DESC")]
    if not rows:
        log.info("No new items this round")
        return 0

    # Jev judgement (only for items being sent; results are stored so a retry does not call Jev again)
    if jev.enabled():
        todo = [r for r in rows if not r["jev_label"]]

        def judge(r):
            s = stocks.get(r["symbol"], {"name": r["symbol"]})
            return r, jev.analyze(s["name"], r["symbol"], r["title"], r["summary"], r["source"])

        with ThreadPoolExecutor(max_workers=6) as pool:
            for r, j in pool.map(judge, todo):
                if j:
                    r.update(jev_label=j["label"], jev_prob=j["prob"], jev_impact=j["impact"], jev_rel=j["relevant"])
                    conn.execute("UPDATE articles SET jev_label=?, jev_prob=?, jev_impact=?, jev_rel=? WHERE id=?",
                                 (j["label"], j["prob"], j["impact"], j["relevant"], r["id"]))
        conn.commit()
        log.info("Jev judged %d items", sum(1 for r in todo if r["jev_label"]))
    for r in rows:
        if r["jev_label"]:
            r["jev"] = {"label": r["jev_label"], "prob": r["jev_prob"], "impact": r["jev_impact"],
                        "relevant": r["jev_rel"]}

    # Send queue: mark as sent only on success; failures are retried next round
    if len(rows) > CONFIG["digest_threshold"]:
        header = (f"📊 <b>Now monitoring {len(new_stocks)} companies. Latest item for each:</b>"
                  if len(new_stocks) >= 5 else f"📊 <b>News digest ({len(rows)} items)</b>")
        batches = [(m, None) for m in format_digest(stocks, rows, header)]
        ids_all = [r["id"] for r in rows]
    else:
        batches = [(format_single(stocks.get(r["symbol"], {"symbol": r["symbol"], "name": ""}), r), r["id"])
                   for r in rows]
        ids_all = None

    sent = 0
    for text, rid in batches:
        try:
            send_message(text, html=True, preview=rid is not None)
            if rid:
                conn.execute("UPDATE articles SET status='sent' WHERE id=?", (rid,))
                conn.commit()
            sent += 1
            time.sleep(1.1)  # stay under Telegram's per-chat rate limit
        except Exception as e:
            log.error("Send failed, will retry next round: %s", e)
            break
    else:
        if ids_all:
            conn.executemany("UPDATE articles SET status='sent' WHERE id=?", [(i,) for i in ids_all])
            conn.commit()
    log.info("Sent %d messages (%d items) this round", sent, len(rows))
    return sent


if __name__ == "__main__":
    run_once()
