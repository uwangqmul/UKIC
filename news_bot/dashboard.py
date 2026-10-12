"""
Build the local dashboard (dashboard.html): candlestick charts + news + Jev judgements.

Usage: python dashboard.py   (then open dashboard.html in a browser)
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

import jev
from news import CONFIG, HEADERS, db, first_match, keyword_patterns, log

BASE = Path(__file__).resolve().parent
OUT = BASE / "dashboard.html"
NO_CHART = set()  # symbols without price data; config.json "price_symbol" gives the Yahoo ticker when it differs
NEWS_DAYS = 14
NEWS_PER_STOCK = 80
JEV_BACKFILL = 1500  # max older items to judge per run (Jev is cheap: a few hundred items cost under 1 cent)


# ---------- Prices ----------
def fetch_prices(symbol):
    for host in ("query1", "query2"):
        try:
            r = requests.get(
                f"https://{host}.finance.yahoo.com/v8/finance/chart/{symbol}",
                params={"range": "1y", "interval": "1d"}, headers=HEADERS, timeout=20)
            r.raise_for_status()
            res = r.json()["chart"]["result"][0]
            q = res["indicators"]["quote"][0]
            off = res["meta"].get("gmtoffset", 0)
            bars = []
            for t, o, h, l, c in zip(res["timestamp"], q["open"], q["high"], q["low"], q["close"]):
                if None in (o, h, l, c):
                    continue
                day = datetime.fromtimestamp(t + off, tz=timezone.utc).strftime("%Y-%m-%d")
                bars.append([day, round(o, 4), round(h, 4), round(l, 4), round(c, 4)])
            return {"bars": bars, "currency": res["meta"].get("currency", "")}
        except Exception as e:
            err = e
    log.warning("Price fetch failed for %s: %s", symbol, str(err)[:120])
    return None


def close_time(day, symbol):
    """Market close in UTC: US stocks 21:00 (the winter close; an hour late in summer, which is the safe side),
    Korean stocks 06:30."""
    hh, mm = (6, 30) if symbol.endswith(".KS") else (21, 0)
    return datetime.fromisoformat(day).replace(hour=hh, minute=mm, tzinfo=timezone.utc)


def price_moves(bars, published_iso, symbol):
    """Price moves after a news item, measured from the first close AFTER it was published - the earliest
    price you could buy at after seeing it - so moves that happened before the report are not counted."""
    if not bars or not published_iso:
        return None
    pub = datetime.fromisoformat(published_iso)
    days = [b[0] for b in bars]
    base_idx = next((i for i, d in enumerate(days) if close_time(d, symbol) > pub), None)
    if base_idx is None:
        return {"base_day": None, "next": None, "since": None}
    base = bars[base_idx][4]
    nxt = bars[base_idx + 1][4] if base_idx + 1 < len(bars) else None
    return {
        "base_day": days[base_idx],
        "next": round(nxt / base - 1, 4) if nxt else None,
        "since": round(bars[-1][4] / base - 1, 4) if base_idx < len(bars) - 1 else None,
    }


# ---------- Jev backfill ----------
def backfill_jev(conn, stocks):
    if not jev.enabled():
        return 0
    since = (datetime.now(timezone.utc) - timedelta(days=NEWS_DAYS)).isoformat()
    rows = conn.execute(
        "SELECT id, symbol, title, summary, source FROM articles "
        "WHERE jev_label IS NULL AND published >= ? ORDER BY published DESC LIMIT ?",
        (since, JEV_BACKFILL)).fetchall()

    def judge(r):
        s = stocks.get(r[1], {"name": r[1]})
        return r[0], jev.analyze(s["name"], r[1], r[2], r[3] or "", r[4] or "")

    done = 0
    with ThreadPoolExecutor(max_workers=10) as pool:
        for rid, j in pool.map(judge, rows):
            if j:
                conn.execute("UPDATE articles SET jev_label=?, jev_prob=?, jev_impact=?, jev_rel=? WHERE id=?",
                             (j["label"], j["prob"], j["impact"], j["relevant"], rid))
                done += 1
    conn.commit()
    return done


# ---------- Summary ----------
def jev_score(items):
    """Net Jev leaning over the last 3 days: bullish positive, bearish negative, weighted by impact and
    relevance; roughly -1 to 1."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=3)
    total, weight = 0.0, 0.0
    for n in items:
        j = n.get("jev")
        if not j or not n["published"] or datetime.fromisoformat(n["published"]) < cutoff:
            continue
        w = (1 + j["impact"]) / 3 * max(j["relevant"], 0.3)
        sign = {"up": 1, "down": -1}.get(j["label"], 0)
        total += sign * j["prob"] * w
        weight += w
    # +1 smoothing so one or two items cannot push a stock to an extreme value
    return round(total / (weight + 1), 3) if weight else 0.0


def build_data():
    conn = db()
    stocks_cfg = {s["symbol"]: s for s in CONFIG["stocks"]}
    n = backfill_jev(conn, stocks_cfg)
    if n:
        log.info("Dashboard: Jev judged %d older items", n)

    chart_syms = [s for s in stocks_cfg if s not in NO_CHART]
    px = {s: stocks_cfg[s].get("price_symbol", s) for s in stocks_cfg}  # Yahoo ticker, e.g. GOLD.AS for the gold ETC
    with ThreadPoolExecutor(max_workers=6) as pool:
        prices = dict(zip(chart_syms, pool.map(fetch_prices, [px[s] for s in chart_syms])))

    since = (datetime.now(timezone.utc) - timedelta(days=NEWS_DAYS)).isoformat()
    stocks, hits, judged = [], 0, 0
    for sym, s in stocks_cfg.items():
        p = prices.get(sym)
        bars = p["bars"] if p else []
        rows = conn.execute(
            "SELECT title, link, source, published, summary, tag, jev_label, jev_prob, jev_impact, jev_rel "
            "FROM articles WHERE symbol=? AND (published >= ? OR published IS NULL) "
            "ORDER BY published DESC LIMIT ?", (sym, since, NEWS_PER_STOCK)).fetchall()
        news = []
        excl = keyword_patterns(s.get("exclude", []))
        for t, link, src, pub, summ, tag, jl, jp, ji, jr in rows:
            if first_match(t, excl):
                continue
            item = {"title": t, "link": link, "source": src, "published": pub,
                    "summary": summ or "", "tag": tag or "news", "jev": None, "move": price_moves(bars, pub, px[sym])}
            if jl:
                item["jev"] = {"label": jl, "prob": jp, "impact": ji, "relevant": jr}
                mv = item["move"]
                if jl in ("up", "down") and mv and mv["next"] is not None and abs(mv["next"]) >= 0.003:
                    judged += 1
                    hits += (mv["next"] > 0) == (jl == "up")
            news.append(item)
        last = bars[-1][4] if bars else None
        prev = bars[-2][4] if len(bars) > 1 else None
        stocks.append({
            "symbol": sym, "name": s["name"], "currency": p["currency"] if p else "",
            "bars": bars, "last": last, "change": round(last / prev - 1, 4) if last and prev else None,
            "news": news, "score": jev_score(news),
            "counts": {k: sum(1 for x in news if x["jev"] and x["jev"]["label"] == k) for k in ("up", "down", "neutral")},
            "chart_note": "" if bars else "Price data unavailable right now",
        })
    return {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "jev_enabled": jev.enabled(),
        "accuracy": {"hits": hits, "total": judged},
        "stocks": stocks,
    }


def main():
    t0 = time.time()
    data = build_data()
    template = (BASE / "dashboard_template.html").read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    OUT.write_text(template.replace("/*__DATA__*/null", payload), encoding="utf-8")
    log.info("Dashboard built: %s (%.1f s)", OUT.name, time.time() - t0)


if __name__ == "__main__":
    main()
