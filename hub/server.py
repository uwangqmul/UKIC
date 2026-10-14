"""
UKIC Hub dashboard: http://127.0.0.1:6400/

Starts the scheduler and serves the dashboard. Only listens on this computer.
Every POST must carry the header "X-Hub: 1", so other web pages cannot trigger orders.

Usage: double-click start_hub.bat (or python hub/server.py)
"""
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import autotrade
import batch
import rebalance
import tilt
import pipeline
import scheduler
import tg_commands
import trader_bridge
from common import (ASSETS_FILE, BRIEFS, DATA, DECISIONS, LOG_FILE, NEWS_BOT, ROOT, SKILL, TRADER, WEB, clock_info,
                    load_settings, log, now_utc, read_json, save_settings, to_london, write_json)

PORT = 6400
HUB_DIR = Path(__file__).resolve().parent


def code_stamp():
    """Newest change time of the hub's Python files: if it moves after start-up, the running server is out of date."""
    return max((f.stat().st_mtime for f in HUB_DIR.glob("*.py")), default=0)


STARTED_CODE = code_stamp()
STARTED_AT = now_utc()
JOURNAL = "http://127.0.0.1:6420"
NEWS_LOCK_PORT = 47321
SKILL_FILES = {"skill": "SKILL.md", "prompt": "scheduled_prompt.md"}


# ---------- Status ----------
def news_bot_running():
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", NEWS_LOCK_PORT))
        return False
    except OSError:
        return True
    finally:
        s.close()


def journal_running():
    try:
        with urllib.request.urlopen(f"{JOURNAL}/api/version", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def env_keys():
    keys = {}
    try:
        for line in (NEWS_BOT / ".env").read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                keys[k.strip()] = bool(v.strip())
    except OSError:
        pass
    return keys


def status():
    keys = env_keys()
    return {
        "server": {"started": to_london(STARTED_AT).strftime("%H:%M"), "code_changed": code_stamp() > STARTED_CODE + 1},
        "clock": clock_info(),
        "settings": load_settings(),
        "upcoming": scheduler.upcoming(10),
        "run": {k: scheduler.state[k] for k in ("running", "last", "last_error", "history")},
        "health": {
            "trader_folder": TRADER.exists(),
            "news_bot_folder": NEWS_BOT.exists(),
            "news_bot_running": news_bot_running(),
            "journal_running": journal_running(),
            "umushroom_login": (TRADER / ".browser-data" / "umushroom-profile").exists(),
            "telegram": keys.get("TELEGRAM_BOT_TOKEN", False) and keys.get("TELEGRAM_CHAT_ID", False),
            "telegram_last": read_json(DATA / "telegram_status.json", None),
            "tg_commands": tg_commands.status(),
            "jev": keys.get("TYPESAFE_API_KEY", False),
        },
    }


# ---------- Data ----------
def news(hours):
    db = NEWS_BOT / "alerts.db"
    if not db.exists():
        return []
    since = (now_utc() - timedelta(hours=hours)).isoformat()
    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(
            "SELECT symbol, title, link, source, published, tag, jev_label, jev_prob, jev_impact "
            "FROM articles WHERE published >= ? ORDER BY published DESC LIMIT 400", (since,))]
    finally:
        conn.close()


def assets():
    cfg = read_json(NEWS_BOT / "config.json", {"stocks": []})
    meta = read_json(ASSETS_FILE, {"assets": {}, "horizon_rules": {}})
    rows = [{"symbol": s["symbol"], "name": s["name"],
             "sector": meta["assets"].get(s["symbol"], {}).get("sector", "Other"),
             "trade": meta["assets"].get(s["symbol"], {}).get("trade", True)} for s in cfg.get("stocks", [])]
    return {"assets": rows, "horizon_rules": meta.get("horizon_rules", {})}


def save_assets(body):
    meta = read_json(ASSETS_FILE, {"assets": {}, "horizon_rules": {}})
    for row in body.get("assets", []):
        meta["assets"][row["symbol"]] = {**meta["assets"].get(row["symbol"], {}),
                                         "sector": str(row.get("sector", "Other"))[:40], "trade": bool(row.get("trade"))}
    if "horizon_rules" in body:
        for kind in ("immediate", "delayed"):
            words = body["horizon_rules"].get(kind, {}).get("keywords")
            if isinstance(words, list):
                meta["horizon_rules"].setdefault(kind, {})["keywords"] = [str(w).strip() for w in words if str(w).strip()]
    write_json(ASSETS_FILE, meta)
    return assets()


WATCHLIST_FILE = ASSETS_FILE.parent / "watchlist.json"


def watchlist():
    """One row per asset in news_bot/config.json, with the notes pasted on the dashboard."""
    saved = read_json(WATCHLIST_FILE, {})
    meta = assets()
    latest = next(iter(decisions(1)), None)
    advice = {r["symbol"]: r for r in (latest or {}).get("rows", [])}
    counts = {}
    for n in news(24):
        counts[n["symbol"]] = counts.get(n["symbol"], 0) + 1
    rows = []
    for a in meta["assets"]:
        w = saved.get(a["symbol"], {})
        r = advice.get(a["symbol"], {})
        rows.append({**a, "notes": w.get("notes", ""), "updated": w.get("updated", ""),
                     "news24": counts.get(a["symbol"], 0), "action": r.get("action"), "prob": r.get("prob")})
    return {"rows": rows, "decision": latest and latest["london"]}


def save_watch(body):
    symbol = str(body.get("symbol", ""))
    if symbol not in {a["symbol"] for a in assets()["assets"]}:
        return {"ok": False, "error": "unknown symbol"}
    saved = read_json(WATCHLIST_FILE, {})
    stamp = to_london(now_utc()).strftime("%Y-%m-%d %H:%M")
    saved[symbol] = {"notes": str(body.get("notes", ""))[:20000], "updated": stamp}
    write_json(WATCHLIST_FILE, saved)
    return {"ok": True, "updated": stamp}


def decisions(limit=30):
    out = []
    for p in sorted(DECISIONS.glob("*.json"), reverse=True)[:limit]:
        d = read_json(p, None)
        if d:
            out.append(d)
    return out


def log_tail(n=200):
    try:
        return "\n".join(LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])
    except OSError:
        return ""


# ---------- Actions ----------
def trade(body):
    return trader_bridge.trade(body.get("action"), body.get("company", ""), body.get("portfolio", ""),
                               shares=body.get("shares", ""), amount=body.get("amount", ""), weight=body.get("weight", ""),
                               submit=body.get("submit") is True)


def restart():
    """Start a fresh hub (new window) and stop this one, so code changes take effect. Refused while orders are running."""
    if batch.state()["running"] or autotrade.running_now() or scheduler.state.get("running"):
        return {"ok": False, "error": "Orders or a reasoning run are in progress: try again when they finish."}
    flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    subprocess.Popen([sys.executable, str(HUB_DIR / "server.py"), "--no-browser", "--wait-port"], cwd=ROOT, creationflags=flags)
    log.info("Restarting the hub for updated code")
    threading.Timer(1.0, lambda: os._exit(0)).start()  # after the reply is sent; the new hub takes the port
    return {"ok": True}


def autotrade_preview():
    """What the next automatic run would do with the latest decision, without placing anything."""
    s = load_settings()
    mode = s["auto_mode"] if s["auto_mode"] != "off" else "dry_run"
    portfolio = autotrade.portfolio_for(s, mode)
    files = sorted(DECISIONS.glob("2*.json"))
    dec = read_json(files[-1], None) if files else None
    if not dec:
        return {"ok": False, "error": "No reasoning result yet."}
    base = {"decision": dec["id"], "london": dec.get("london"), "mode": s["auto_mode"], "portfolio": portfolio,
            "strategy": s.get("auto_strategy", "signals")}
    if s.get("auto_strategy") == "tilt":
        _, p = autotrade.tilt_plan(dec, s, portfolio, refresh=False)
        if not p.get("ok"):
            return {**base, "ok": False, "error": p.get("error")}
        n = int(s["auto_tilt_max_per_run"])
        t = tilt.compute(decision=dec, min_rise=float(s["auto_min_prob"]))
        orders = [{"action": side, "symbol": r["symbol"],
                   "size": (r["shares"] + ("" if r["shares"] == "all" else " shares")) if side == "SELL" else f"{r['weight']}% of the portfolio",
                   "why": f"{g}: {r['current'] + r.get('pending', 0):.2f}% -> {r['target']}%"}
                  for side, r, g in rebalance.by_sector(p, t["groups"])]
        return {**base, "ok": True, "orders": orders[:n], "later": orders[n:], "snapshot_at": p["snapshot_at"],
                "age_hours": p["age_hours"], "note": "holdings are refreshed right before a real run"}
    orders, skipped = autotrade.pick(dec, dict(s, auto_mode=mode))
    size = autotrade.buy_size(s)
    return {**base, "ok": True, "skipped": skipped,
            "orders": [{"action": r["action"], "symbol": r["symbol"], "why": f"Jev {r['prob']:.0%}",
                        "size": (f"{size['weight']}% of the portfolio" if "weight" in size else f"${size['amount']}")
                        if r["action"] == "BUY" else f"{s['auto_sell']} shares"} for r in orders]}


def sector_preview(q):
    """What automatic trading would do, sector by sector, before it is switched on (nothing is ordered).
    q["mode"]: "dry_run" or "live" (which portfolio); default the current mode, or dry_run when Off."""
    s = load_settings()
    mode = q.get("mode") if q.get("mode") in ("dry_run", "live") else (s["auto_mode"] if s["auto_mode"] != "off" else "dry_run")
    portfolio = autotrade.portfolio_for(s, mode)
    files = sorted(DECISIONS.glob("2*.json"))
    dec = read_json(files[-1], None) if files else None
    if not dec:
        return {"ok": False, "error": "No reasoning result yet: run reasoning first."}
    strategy = s.get("auto_strategy", "signals")
    rows = {r["symbol"]: r for r in dec.get("rows", [])}
    t = tilt.compute(decision=dec, min_rise=float(s["auto_min_prob"]))
    orders, plan_error, snap = {}, "", {}
    if strategy == "tilt":
        _, p = autotrade.tilt_plan(dec, s, portfolio, refresh=False)
        if p.get("ok"):
            snap = {"at": p["snapshot_at"], "age_hours": p["age_hours"], "value": p["value"], "cash": p["cash"]}
            for r in p["sells"]:
                orders[r["symbol"]] = {"action": "SELL", "size": r["shares"] + ("" if r["shares"] == "all" else " shares"),
                                       "now": r["current"], "target": r["target"]}
            for r in p["buys"]:
                orders[r["symbol"]] = {"action": "BUY", "size": f"{r['weight']}%", "now": round(r["current"] + r["pending"], 2),
                                       "target": r["target"]}
            for r in p["kept"]:
                orders[r["symbol"]] = {"action": "HOLD", "size": "", "now": round(r["current"] + r["pending"], 2), "target": r["target"]}
            for r in p.get("blocked", []):
                orders[r["symbol"]] = {"action": "HOLD", "size": "(Jev SELL: not bought)", "now": round(r["current"] + r["pending"], 2),
                                       "target": r["target"]}
            sequence = [r["symbol"] for _, r, _ in rebalance.by_sector(p, t["groups"])]
        else:
            plan_error, sequence = p.get("error", ""), []
        per_run = int(s["auto_tilt_max_per_run"])
    else:
        picked, _ = autotrade.pick(dec, dict(s, auto_mode=mode))
        size = autotrade.buy_size(s)
        for r in picked:
            orders[r["symbol"]] = {"action": r["action"], "now": None, "target": None,
                                   "size": (f"{size['weight']}%" if "weight" in size else f"${size['amount']}") if r["action"] == "BUY"
                                   else f"{s['auto_sell']} shares"}
        sequence = [r["symbol"] for r in picked]
        per_run = int(s["auto_max_per_run"])
    first = set(sequence[:per_run])
    groups = []
    for g in t["groups"]:
        assets = []
        for a in g["assets"]:
            r = rows.get(a["symbol"], {})
            probs = r.get("probs") or {}
            o = orders.get(a["symbol"], {"action": "HOLD", "size": "", "now": None, "target": a["target"] if strategy == "tilt" else None})
            assets.append({"symbol": a["symbol"], "star": a["symbol"] == g["top"], "jev": r.get("action", ""),
                           "rise": max((p.get("rise", 0) for p in probs.values()), default=None),
                           "fall": max((p.get("down", 0) for p in probs.values()), default=None),
                           "score": a["score"], **o, "next_run": a["symbol"] in first})
        groups.append({"group": g["group"], "total": g["total"], "top": g["top"], "note": g["note"], "assets": assets})
    listed = {a["symbol"] for g in groups for a in g["assets"]}
    others = [{"symbol": o_sym.rsplit("/", 1)[-1], "star": False, "jev": "", "rise": None, "fall": None, "score": None,
               **o, "next_run": o_sym in first} for o_sym, o in orders.items() if o_sym not in listed]
    if others:  # holdings that are not one of the 40 assets: sold in full
        groups.insert(0, {"group": "Not on the list", "total": 0, "top": None, "note": "sold in full", "assets": others})
    return {"ok": True, "mode": mode, "portfolio": portfolio, "strategy": strategy, "decision": dec["id"],
            "london": dec.get("london"), "min_prob": float(s["auto_min_prob"]), "per_run": per_run,
            "total_orders": len(sequence), "snapshot": snap, "plan_error": plan_error, "groups": groups}


def portfolios():
    """Portfolio names the dashboard offers: settings, the competition rules file, and every journal."""
    s = load_settings()
    names = [s.get("default_portfolio", ""), s.get("auto_practice_portfolio", ""), s.get("auto_portfolio", "")]
    names += read_json(TRADER / "competition.json", {}).get("portfolios", [])
    snaps = [read_json(f, {}) for f in (TRADER / "logs").glob("*/latest.json")]
    for snap in sorted(snaps, key=lambda x: x.get("takenAt", ""), reverse=True):  # newest spelling first
        names.append(snap.get("portfolio", {}).get("name", ""))
    seen, out = set(), []
    for n in names:
        n = str(n or "").strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def rebalance_plan(q):
    """GET /api/rebalance?portfolio=&share=&cap=: the sector tilt targets and the sells/buys to reach them."""
    s = load_settings()
    t = tilt.compute(float(q["share"]) if q.get("share") else None, float(q["cap"]) if q.get("cap") else None)
    targets = {a["symbol"]: a["target"] for g in t["groups"] for a in g["assets"]}
    dec = tilt._latest_decision() or {}
    no_buy = {r["symbol"] for r in dec.get("rows", []) if r.get("action") == "SELL"}
    p = rebalance.plan(q.get("portfolio", ""), targets, float(s.get("auto_tilt_min_change_pct", 0.5)), no_buy)
    if p.get("ok"):
        p["lines"] = rebalance.plan_lines(p, t["groups"])
    return p


AUTO_LIMIT_KEYS = {"auto_portfolio": str, "auto_practice_portfolio": str, "auto_min_prob": float, "auto_amount_usd": float, "auto_sell": str,
                   "auto_strategy": str, "auto_weight_pct": float, "auto_tilt_max_per_run": int, "auto_tilt_max_per_day": int,
                   "auto_tilt_min_change_pct": float,
                   "auto_max_per_run": int, "auto_max_per_day": int, "auto_cooldown_hours": float,
                   "auto_us_only": bool, "auto_headless": bool, "auto_run_kinds": list}


def auto_state():
    s = load_settings()
    ok, why = autotrade.can_go_live(s)
    good = autotrade.last_good_dry_run(s["auto_practice_portfolio"]) if s["auto_practice_portfolio"].strip() else None
    return {"settings": {k: s[k] for k in ["auto_mode", *AUTO_LIMIT_KEYS]}, "can_go_live": ok, "why_not": why,
            "last_good_dry_run": good and good["time"], "running_now": autotrade.running_now(), "ledger": list(reversed(autotrade.ledger(40)))}


def save_auto_limits(body):
    update = {}
    for k, typ in AUTO_LIMIT_KEYS.items():
        if k not in body:
            continue
        v = body[k]
        if typ is list:
            v = [x for x in v if x in ("morning", "intraday", "manual")]
        elif typ is bool:
            v = bool(v)
        else:
            v = typ(v)
        update[k] = v
    if "auto_sell" in update and not (update["auto_sell"] == "all" or re.fullmatch(r"\d+(\.\d+)?", update["auto_sell"])):
        raise ValueError("auto_sell must be 'all' or a number of shares")
    for k in ("auto_portfolio", "auto_practice_portfolio"):
        if update.get(k) and not trader_bridge.NAME_RE.match(update[k]):
            raise ValueError("invalid portfolio name")
    comp = update.get("auto_portfolio", load_settings()["auto_portfolio"]).strip().lower()
    if comp and update.get("auto_practice_portfolio", "").strip().lower() == comp:
        raise ValueError("The practice portfolio must not have the same name as the competition portfolio")
    save_settings(update)
    return auto_state()


def launch(what):
    targets = {"news_bot": NEWS_BOT / "start_stock_bot.bat", "umushroom": TRADER / "start-umushroom.cmd",
               "news_dashboard": NEWS_BOT / "open_dashboard.bat"}
    path = targets.get(what)
    if not path or not path.exists():
        return {"ok": False, "output": f"Not found: {path}"}
    if sys.platform == "win32":
        subprocess.Popen(["cmd", "/c", "start", "", "/min" if what == "news_bot" else "/normal", str(path)],
                         cwd=path.parent)
    else:
        subprocess.Popen([str(path)], cwd=path.parent)
    return {"ok": True, "output": f"Started {path.name}"}


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, data, ctype="application/json; charset=utf-8"):
        body = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except ConnectionError:
            pass  # the browser closed the tab or reloaded mid-response

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path in ("/", "/index.html"):
                return self.send(200, (WEB / "index.html").read_bytes(), "text/html; charset=utf-8")
            if u.path == "/api/status":
                return self.send(200, status())
            if u.path == "/api/assets":
                return self.send(200, assets())
            if u.path == "/api/news":
                return self.send(200, news(int(q.get("hours", 48))))
            if u.path == "/api/watchlist":
                return self.send(200, watchlist())
            if u.path == "/api/autotrade":
                return self.send(200, auto_state())
            if u.path == "/api/batch":
                return self.send(200, batch.state())
            if u.path == "/api/autotrade/sectors":
                return self.send(200, sector_preview(q))
            if u.path == "/api/autotrade/preview":
                return self.send(200, autotrade_preview())
            if u.path == "/api/portfolios":
                return self.send(200, {"portfolios": portfolios()})
            if u.path == "/api/rebalance":
                return self.send(200, rebalance_plan(q))
            if u.path == "/api/tilt":
                share, cap = q.get("share"), q.get("cap")
                return self.send(200, tilt.compute(float(share) if share else None, float(cap) if cap else None))
            if u.path == "/api/decisions":
                return self.send(200, decisions())
            if u.path == "/api/brief":
                bid = re.sub(r"[^\d-]", "", q.get("id", ""))
                p = BRIEFS / f"{bid}.md"
                return self.send(200, {"id": bid, "text": p.read_text(encoding="utf-8") if p.exists() else ""})
            if u.path == "/api/skill":
                name = SKILL_FILES.get(q.get("name", ""))
                if not name:
                    return self.send(404, {"error": "unknown file"})
                return self.send(200, {"text": (SKILL / name).read_text(encoding="utf-8")})
            if u.path == "/api/log":
                return self.send(200, {"text": log_tail()})
            self.send(404, {"error": "not found"})
        except Exception as e:
            log.exception("GET %s", u.path)
            self.send(500, {"error": str(e)})

    def do_POST(self):
        if self.headers.get("X-Hub") != "1":
            return self.send(403, {"error": "forbidden"})
        u = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if u.path == "/api/settings":
                for k in [k for k in body if k.startswith("auto_")]:
                    body.pop(k)  # automatic orders are changed only through /api/autotrade/*
                return self.send(200, save_settings(body))
            if u.path == "/api/assets":
                return self.send(200, save_assets(body))
            if u.path == "/api/watchlist":
                return self.send(200, save_watch(body))
            if u.path == "/api/run":
                kind = body.get("kind", "manual")
                if kind not in ("manual", "morning", "intraday", "night"):
                    return self.send(400, {"error": "bad kind"})
                return self.send(200, {"started": scheduler.run_now(kind)})
            if u.path == "/api/trade":
                return self.send(200, trade(body))
            if u.path == "/api/autotrade/mode":
                if body.get("mode") == "live" and body.get("confirm") != "LIVE":
                    return self.send(400, {"ok": False, "error": "type LIVE to confirm"})
                return self.send(200, {**autotrade.set_mode(body.get("mode")), "state": auto_state()})
            if u.path == "/api/autotrade/settings":
                return self.send(200, save_auto_limits(body))
            if u.path == "/api/autotrade/run_latest":
                return self.send(200, {**autotrade.dry_run_latest_now(pipeline.notify), "state": auto_state()})
            if u.path == "/api/autotrade/test":
                sym = str(body.get("symbol") or "AAPL").strip().upper()
                return self.send(200, {**autotrade.test_dry_run(sym), "state": auto_state()})
            if u.path == "/api/batch/start":
                submit = body.get("submit") is True
                # submitting needs the portfolio name typed a second time, so a stray click can't place a whole list
                if submit and str(body.get("confirm", "")).strip() != str(body.get("portfolio", "")).strip():
                    return self.send(400, {"ok": False, "error": "type the portfolio name to confirm"})
                return self.send(200, batch.start(body.get("portfolio"), body.get("orders"), submit))
            if u.path == "/api/restart":
                return self.send(200, restart())
            if u.path == "/api/journal":
                return self.send(200, trader_bridge.journal(body.get("portfolio", "")))
            if u.path == "/api/batch/stop":
                return self.send(200, batch.stop())
            if u.path == "/api/launch":
                return self.send(200, launch(body.get("what")))
            if u.path == "/api/skill":
                name = SKILL_FILES.get(body.get("name", ""))
                if not name:
                    return self.send(404, {"error": "unknown file"})
                (SKILL / name).write_text(str(body.get("text", "")), encoding="utf-8")
                return self.send(200, {"ok": True})
            if u.path == "/api/test_telegram":
                return self.send(200, {"ok": pipeline.notify("✅ UKIC Hub test message")})
            self.send(404, {"error": "not found"})
        except Exception as e:
            log.exception("POST %s", u.path)
            self.send(500, {"error": str(e)})


class HubServer(ThreadingHTTPServer):
    # SO_REUSEADDR on Windows lets a second hub bind the same port (two schedulers, double runs).
    # Take the port exclusively so a second start_hub.bat hits the "already running" branch.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    httpd = None
    for _ in range(30 if "--wait-port" in sys.argv else 1):  # a restart waits for the old hub to let go of the port
        try:
            httpd = HubServer(("127.0.0.1", PORT), Handler)
            break
        except OSError:
            time.sleep(0.5)
    if httpd is None:
        print(f"The hub is already running. Opening http://127.0.0.1:{PORT}/")
        webbrowser.open(f"http://127.0.0.1:{PORT}/")
        return
    scheduler.start()
    tg_commands.start()
    url = f"http://127.0.0.1:{PORT}/"
    print("=" * 56)
    print(f" UKIC Hub running at {url}")
    print(f" Folder: {ROOT}")
    print(" Close this window to stop the dashboard and the schedule")
    print("=" * 56)
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
