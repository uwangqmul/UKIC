"""
Reasoning pipeline (Nick's five points):
  1. purpose      UMushroom competition only: prepare news for Jev
  2. assets       only assets ticked "trade" in hub/data/assets.json; each news item is tagged
                  "immediate" (moves within hours) or "delayed" (shows up after 12-24 hours)
  3. format       one brief per run (hub/data/briefs/*.json and *.md), one block per asset
  4. feed Jev     per asset: probability of "price rise" / "price down" / "no clear move",
                  separately for the next few hours and for the next 12-24 hours
  5. apply        BUY / SELL / HOLD suggestion per asset -> hub/data/decisions/*.json -> Telegram
                  Orders are placed by hand from the dashboard (preview first, then submit).

Usage: python pipeline.py [morning|intraday|night|manual]
       python pipeline.py telegram <decision.json>
"""
import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import autotrade
from common import (ASSETS_FILE, BRIEFS, DECISIONS, NEWS_BOT, load_settings, log, now_utc, read_json,
                    to_london, write_json)

KINDS = {
    "morning": "Morning run (full reasoning, sent to Telegram)",
    "intraday": "Intraday run",
    "night": "Night run (collect only)",
    "manual": "Manual run",
}
DIRECTIONS = {
    "rise": "The news makes a share price rise more likely: good results, raised guidance, big contract or order, "
            "strong launch, upgrade, buyback, favourable regulation",
    "down": "The news makes a share price fall more likely: missed results, cut guidance, lawsuit or fine, downgrade, "
            "lost contract, recall, outage, breach, export restrictions or tariffs",
    "flat": "No clear move: routine, already priced in, mixed, or only mentions the company in passing",
}


# ---------- 1-3. Build the brief ----------
def stock_list():
    cfg = read_json(NEWS_BOT / "config.json", {"stocks": []})
    meta = read_json(ASSETS_FILE, {"assets": {}, "horizon_rules": {}})
    out = []
    for s in cfg.get("stocks", []):
        m = meta["assets"].get(s["symbol"], {})
        out.append({"symbol": s["symbol"], "name": s["name"], "sector": m.get("sector", "Other"),
                    "trade": m.get("trade", True)})
    return out, meta.get("horizon_rules", {})


def horizon_of(text, rules):
    low = text.lower()
    for kind in ("immediate", "delayed"):
        if any(k.lower() in low for k in rules.get(kind, {}).get("keywords", [])):
            return kind
    return "delayed"


def read_articles(hours):
    db = NEWS_BOT / "alerts.db"
    if not db.exists():
        return []
    since = (now_utc() - timedelta(hours=hours)).isoformat()
    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT symbol, title, link, source, published, summary, tag, jev_label, jev_prob, jev_impact, jev_rel "
            "FROM articles WHERE published >= ? ORDER BY published DESC", (since,)).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def build_brief(kind="manual"):
    settings = load_settings()
    stocks, rules = stock_list()
    articles = read_articles(settings["lookback_hours"])
    now = now_utc()
    assets = []
    for s in stocks:
        if not s["trade"]:
            continue
        items, seen = [], set()
        for a in (x for x in articles if x["symbol"] == s["symbol"]):
            if (a.get("jev_rel") is not None) and a["jev_rel"] < 0.3:
                continue  # only mentioned in passing
            key = a["title"].lower()[:80]
            if key in seen:
                continue  # same headline from several sources
            seen.add(key)
            try:
                age = (now - datetime.fromisoformat(a["published"])).total_seconds() / 3600
            except Exception:
                age = None
            items.append({
                "title": a["title"], "link": a["link"], "source": a["source"], "tag": a.get("tag") or "news",
                "age_h": round(age, 1) if age is not None else None,
                "horizon": horizon_of(f"{a['title']} {a.get('summary') or ''}", rules),
                "article_jev": a.get("jev_label"), "article_prob": a.get("jev_prob"),
                "article_impact": a.get("jev_impact"),
            })
        assets.append({**s, "items": items[:12]})
    stamp = to_london(now)
    brief = {"id": stamp.strftime("%Y%m%d-%H%M"), "kind": kind, "london": stamp.strftime("%Y-%m-%d %H:%M"),
             "lookback_hours": settings["lookback_hours"], "assets": assets}
    write_json(BRIEFS / f"{brief['id']}.json", brief)
    (BRIEFS / f"{brief['id']}.md").write_text(brief_markdown(brief), encoding="utf-8")
    return brief


def brief_markdown(brief):
    lines = [f"# Brief {brief['london']} London ({brief['kind']})", "",
             f"News from the last {brief['lookback_hours']} hours. immediate = moves within hours; "
             "delayed = shows up after 12-24 hours.", ""]
    for a in brief["assets"]:
        if not a["items"]:
            continue
        lines.append(f"## {a['symbol']} {a['name']} ({a['sector']})")
        for i in a["items"]:
            j = f" | article Jev {i['article_jev']} {i['article_prob']:.0%}" if i["article_jev"] and i["article_prob"] else ""
            age = f"{i['age_h']}h ago" if i["age_h"] is not None else "?"
            lines.append(f"- [{i['horizon']}] [{i['tag']}] {i['title']} ({age}){j}")
        lines.append("")
    return "\n".join(lines)


# ---------- 4. Jev ----------
def _jev():
    try:
        import jev  # news_bot/jev.py, reads TYPESAFE_API_KEY from news_bot/.env (loaded in common.py)
        return jev if jev.enabled() else None
    except Exception as e:
        log.warning("Jev not available: %s", e)
        return None


def jev_asset(jev, asset):
    from typesafe_sdk import Choice, Score
    name = asset["name"]
    state = [f"Company: {name} (ticker {asset['symbol']}), sector {asset['sector']}", "Recent news, newest first:"]
    for i in asset["items"][:8]:
        state.append(f"- ({i['age_h']}h ago, {i['horizon']}, {i['tag']}) {i['title']}")
    q = {
        "hours": Choice(instructions=f"Over the next few hours of trading, what is the most likely move of {name}'s "
                                     f"share price given these news items?", criteria=DIRECTIONS),
        "day": Choice(instructions=f"Over the next 12 to 24 hours, what is the most likely move of {name}'s "
                                   f"share price given these news items?", criteria=DIRECTIONS),
        "strength": Score(instructions=f"How strongly could this news move {name}'s share price?",
                          criteria=["Weak, unlikely to move it", "Could move it a little", "Could move it a lot"]),
    }
    r = jev._get_client().system_one("\n".join(state), q, timeout=30)
    probs = {h: {k: float(r.choices[h].probabilities.get(k, 0)) for k in DIRECTIONS} for h in ("hours", "day")}
    return probs, float(r.scores["strength"].score), "jev"


def fallback_asset(asset):
    """No Jev key: average the per-article judgements news_bot already stored."""
    num = den = 0.0
    for i in asset["items"]:
        if not i["article_jev"] or i["article_prob"] is None:
            continue
        w = 1 + (i["article_impact"] or 0)
        sign = {"up": 1, "down": -1}.get(i["article_jev"], 0)
        num += sign * i["article_prob"] * w
        den += w
    score = num / den if den else 0.0
    p = {"rise": max(score, 0.0), "down": max(-score, 0.0)}
    p["flat"] = 1 - p["rise"] - p["down"]
    return {"hours": p, "day": p}, 0.0, "article-average"


# ---------- 5. Decide ----------
def decide(probs, settings):
    best = None
    for h in ("hours", "day"):
        p = probs[h]
        if p["rise"] >= settings["buy_threshold"] and p["rise"] - p["down"] >= settings["min_margin"]:
            cand = ("BUY", h, p["rise"])
        elif p["down"] >= settings["sell_threshold"] and p["down"] - p["rise"] >= settings["min_margin"]:
            cand = ("SELL", h, p["down"])
        else:
            continue
        if not best or cand[2] > best[2]:
            best = cand
    return best or ("HOLD", None, max(probs["hours"]["flat"], probs["day"]["flat"]))


def reason(brief):
    settings = load_settings()
    jev = _jev()
    todo = [a for a in brief["assets"] if a["items"]]

    def one(a):
        try:
            probs, strength, src = jev_asset(jev, a) if jev else fallback_asset(a)
        except Exception as e:
            log.warning("Jev failed for %s: %s", a["symbol"], str(e)[:150])
            probs, strength, src = fallback_asset(a)
        action, horizon, prob = decide(probs, settings)
        return {"symbol": a["symbol"], "name": a["name"], "sector": a["sector"], "action": action,
                "horizon": horizon, "prob": round(prob, 3), "strength": round(strength, 2),
                "probs": {h: {k: round(v, 3) for k, v in p.items()} for h, p in probs.items()},
                "source": src, "news": len(a["items"]),
                "top": [{"title": i["title"], "link": i["link"], "horizon": i["horizon"]} for i in a["items"][:3]]}

    with ThreadPoolExecutor(max_workers=6) as pool:
        rows = list(pool.map(one, todo))
    order = {"BUY": 0, "SELL": 1, "HOLD": 2}
    rows.sort(key=lambda r: (order[r["action"]], -r["prob"]))
    return rows


def telegram_text(dec):
    acts = [r for r in dec["rows"] if r["action"] != "HOLD"]
    lines = [f"🍄 UMushroom {dec['london']} London: {KINDS.get(dec['kind'], dec['kind'])}",
             f"{len(dec['rows'])} assets with news, {len(acts)} suggestions" +
             ("" if dec["engine"] == "jev" else " (no Jev key: article average)")]
    for r in acts[:10]:
        icon = "🟢 BUY" if r["action"] == "BUY" else "🔴 SELL"
        when = "next hours" if r["horizon"] == "hours" else "12-24h"
        lines.append(f"{icon} {r['symbol']} {r['prob']:.0%} ({when}) - {r['top'][0]['title'][:90] if r['top'] else ''}")
    if not acts:
        lines.append("No BUY/SELL above the thresholds. Hold.")
    lines.append("Orders are manual: open the dashboard http://127.0.0.1:6400/")
    return "\n".join(lines)


def notify(text):
    try:
        from telegram_bot import send_message
        send_message(text, preview=False)
        return True
    except (Exception, SystemExit) as e:  # telegram_bot exits when the token is missing
        log.warning("Telegram failed: %s", e)
        return False


def run(kind="manual"):
    settings = load_settings()
    brief = build_brief(kind)
    log.info("Brief %s: %d assets, %d with news", brief["id"], len(brief["assets"]),
             sum(1 for a in brief["assets"] if a["items"]))
    if kind == "night":
        return {"brief": brief["id"], "decision": None}
    rows = reason(brief)
    dec = {"id": brief["id"], "kind": kind, "london": brief["london"], "brief": brief["id"],
           "engine": "jev" if any(r["source"] == "jev" for r in rows) else "article-average",
           "rows": rows}
    acts = [r for r in rows if r["action"] != "HOLD"]
    send = (kind == "morning" and settings["telegram_morning"]) or kind == "manual" or (
        kind == "intraday" and (settings["telegram_intraday"] == "all" or
                                (settings["telegram_intraday"] == "actionable" and acts)))
    dec["telegram"] = notify(telegram_text(dec)) if send else False
    write_json(DECISIONS / f"{dec['id']}.json", dec)
    log.info("Decision %s: %d BUY/SELL", dec["id"], len(acts))
    try:
        summary = autotrade.execute(dec)
    except Exception as e:
        log.exception("Auto trading failed")
        summary = {"mode": settings["auto_mode"], "done": [], "skipped": [], "error": str(e)[:200]}
    if summary:
        dec["auto"] = summary
        write_json(DECISIONS / f"{dec['id']}.json", dec)
        if summary["done"] or summary.get("error"):
            notify("\n".join(autotrade.telegram_lines(summary)))
    return {"brief": brief["id"], "decision": dec["id"]}


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "telegram":
        # python pipeline.py telegram <decision.json>: send a decision file (e.g. one written by Claude)
        print("sent" if notify(telegram_text(read_json(sys.argv[2], {}))) else "failed")
    else:
        print(json.dumps(run(sys.argv[1] if len(sys.argv) > 1 else "manual"), indent=2))
