"""
UKIC Hub dashboard: http://127.0.0.1:6400/

Starts the scheduler and serves the dashboard. Only listens on this computer.
Every POST must carry the header "X-Hub: 1", so other web pages cannot trigger orders.

Usage: double-click start_hub.bat (or python hub/server.py)
"""
import json
import re
import socket
import sqlite3
import subprocess
import sys
import urllib.request
import webbrowser
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import scheduler
from common import (ASSETS_FILE, BRIEFS, DECISIONS, LOG_FILE, NEWS_BOT, ROOT, SKILL, TRADER, WEB, clock_info,
                    load_settings, log, now_utc, read_json, save_settings, to_london, write_json)

PORT = 6400
JOURNAL = "http://127.0.0.1:6420"
NEWS_LOCK_PORT = 47321
SKILL_FILES = {"skill": "SKILL.md", "prompt": "scheduled_prompt.md"}
COMPANY_RE = re.compile(r"^[\w .&'-]{1,60}$")
NPM = "npm.cmd" if sys.platform == "win32" else "npm"


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
        meta["assets"][row["symbol"]] = {"sector": str(row.get("sector", "Other"))[:40], "trade": bool(row.get("trade"))}
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
    action = body.get("action")
    company = str(body.get("company", "")).strip()
    portfolio = str(body.get("portfolio", "")).strip()
    if action not in ("buy", "sell") or not COMPANY_RE.match(company):
        return {"ok": False, "output": "Invalid action or company"}
    args = [NPM, "run", "trade", "--", action, company]
    if portfolio:
        if not COMPANY_RE.match(portfolio):
            return {"ok": False, "output": "Invalid portfolio name"}
        args += ["--portfolio", portfolio]
    shares, amount = str(body.get("shares", "")).strip(), str(body.get("amount", "")).strip()
    if shares:
        if not (re.fullmatch(r"\d+(\.\d+)?", shares) or (shares == "all" and action == "sell")):
            return {"ok": False, "output": "Invalid shares"}
        args += ["--shares", shares]
    elif amount:
        if not re.fullmatch(r"\d+(\.\d+)?", amount):
            return {"ok": False, "output": "Invalid amount"}
        args += ["--amount", amount]
    else:
        return {"ok": False, "output": "Give shares or amount"}
    if body.get("submit") is True:
        args.append("--submit")
    log.info("Trade: %s", " ".join(args[3:]))
    try:
        p = subprocess.run(args, cwd=TRADER, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=240)
        out = (p.stdout + "\n" + p.stderr).strip()
        log.info("Trade finished (%s)", p.returncode)
        return {"ok": p.returncode == 0, "output": out[-6000:]}
    except Exception as e:
        return {"ok": False, "output": str(e)}


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
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
                body.pop("auto_trade", None)  # stays off until order placing on the competition page is verified
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
            if u.path == "/api/launch":
                return self.send(200, launch(body.get("what")))
            if u.path == "/api/skill":
                name = SKILL_FILES.get(body.get("name", ""))
                if not name:
                    return self.send(404, {"error": "unknown file"})
                (SKILL / name).write_text(str(body.get("text", "")), encoding="utf-8")
                return self.send(200, {"ok": True})
            if u.path == "/api/test_telegram":
                import pipeline
                return self.send(200, {"ok": pipeline.notify("✅ UKIC Hub test message")})
            self.send(404, {"error": "not found"})
        except Exception as e:
            log.exception("POST %s", u.path)
            self.send(500, {"error": str(e)})


def main():
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"The hub is already running. Opening http://127.0.0.1:{PORT}/")
        webbrowser.open(f"http://127.0.0.1:{PORT}/")
        return
    scheduler.start()
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
