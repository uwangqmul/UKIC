"""
Calls the trader (Node, UMushroom) from Python: `npm run trade -- <buy|sell> <company> ...` inside trader/.
Used by the dashboard's Orders tab and by autotrade.py.
"""
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

from common import ASSETS_FILE, TRADER, log, read_json

NAME_RE = re.compile(r"^[\w .&'-]{1,60}$")
NPM = "npm.cmd" if sys.platform == "win32" else "npm"
# An exact UMushroom security page (assets.json "umushroom" for a ticker shared by several securities, e.g. NET)
PAGE_RE = re.compile(r"^https://umushroom\.com/en/(equity|etf)/[a-z0-9][a-z0-9._-]{0,80}$", re.I)  # some slugs have capitals (SPCX-...)
_order_lock = threading.Lock()  # dashboard, autotrade and Telegram share one browser: one order at a time


# Funds are bought by ISIN, but a sale finds the holding by its page: their pages on UMushroom
FUND_PAGES = {"GOLD": "https://umushroom.com/en/etf/amundi-physical-gold-etc-c-2",
              "DTLA": "https://umushroom.com/en/etf/ishares-treasury-bond-20-yr-ucits-etf-usd-acc"}


def order_id(company, action="buy"):
    """What to type on UMushroom for one of our symbols (assets.json "umushroom", e.g. the gold ETC's ISIN,
    because the ticker GOLD is shared by two products). Anything else is passed through unchanged."""
    if action == "sell" and str(company).strip().upper() in FUND_PAGES:
        return FUND_PAGES[str(company).strip().upper()]
    meta = read_json(ASSETS_FILE, {}).get("assets", {}).get(str(company).strip().upper(), {})
    return meta.get("umushroom") or company


def trade(action, company, portfolio="", shares="", amount="", submit=False, headless=False, weight=""):
    """Returns {ok, submitted, output}. submitted: True / False / "unknown" (sent but not confirmed: trader locks the stock)."""
    company, portfolio = str(order_id(company, action)).strip(), str(portfolio).strip()
    shares, amount = str(shares or "").strip(), str(amount or "").strip()
    weight = str(weight or "").strip().rstrip("%")
    if action not in ("buy", "sell") or not (NAME_RE.match(company) or PAGE_RE.match(company)):
        return {"ok": False, "submitted": False, "output": "Invalid action or company"}
    args = [NPM, "run", "trade", "--", action, company]
    if portfolio:
        if not NAME_RE.match(portfolio):
            return {"ok": False, "submitted": False, "output": "Invalid portfolio name"}
        args += ["--portfolio", portfolio]
    if shares:
        if not (re.fullmatch(r"\d+(\.\d+)?", shares) or (shares == "all" and action == "sell")):
            return {"ok": False, "submitted": False, "output": "Invalid shares"}
        args += ["--shares", shares]
    elif amount:
        if not re.fullmatch(r"\d+(\.\d+)?", amount):
            return {"ok": False, "submitted": False, "output": "Invalid amount"}
        args += ["--amount", amount]
    elif weight and action == "buy":
        # % of the portfolio, typed into the order form's weight box; UMushroom works out the amount
        if not (re.fullmatch(r"\d+(\.\d+)?", weight) and 0 < float(weight) <= 100):
            return {"ok": False, "submitted": False, "output": "Invalid weight"}
        args += ["--weight", weight]
    else:
        return {"ok": False, "submitted": False, "output": "Give shares, an amount or (buy) a weight"}
    if submit is True:
        args.append("--submit")
    env = dict(os.environ)
    if headless:
        env["MCP_HEADLESS"] = "true"
    log.info("Trade: %s", " ".join(args[4:]))
    try:
        with _order_lock:
            p = subprocess.run(args, cwd=TRADER, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=240, env=env)
    except subprocess.TimeoutExpired as e:
        # The order may already have been sent when the time ran out: never report it as "not submitted"
        out = "\n".join(x if isinstance(x, str) else (x or b"").decode("utf-8", "replace") for x in (e.stdout, e.stderr))
        log.warning("Trade timed out after 240 s (submit %s)", submit is True)
        return {"ok": False, "submitted": "unknown" if submit is True else False,
                "output": (out.strip() + "\nTimed out after 240 s. Check UMushroom before trying again.").strip()[-6000:]}
    except Exception as e:
        return {"ok": False, "submitted": False, "output": str(e)}
    out = (p.stdout + "\n" + p.stderr).strip()
    if re.search(r'"submitted":\s*"unknown"', out):
        submitted = "unknown"
    elif re.search(r'"submitted":\s*true', out):
        submitted = True
    else:
        submitted = False
    log.info("Trade finished (exit %s, submitted %s)", p.returncode, submitted)
    return {"ok": p.returncode == 0, "submitted": submitted, "output": out[-6000:]}


def _batch_fields(o):
    """One order of a batch, checked like trade(): the dict the trader's trade-batch reads, or an error text."""
    action = o.get("action")
    company = str(order_id(o.get("company", ""), action)).strip()
    portfolio = str(o.get("portfolio") or "").strip()
    shares, amount = str(o.get("shares") or "").strip(), str(o.get("amount") or "").strip()
    weight = str(o.get("weight") or "").strip().rstrip("%")
    if action not in ("buy", "sell") or not (NAME_RE.match(company) or PAGE_RE.match(company)):
        return "Invalid action or company"
    if not NAME_RE.match(portfolio):
        return "Invalid portfolio name"
    out = {"action": action, "company": company, "portfolio": portfolio}
    if shares:
        if not (re.fullmatch(r"\d+(\.\d+)?", shares) or (shares == "all" and action == "sell")):
            return "Invalid shares"
        out["shares"] = shares
    elif amount:
        if not re.fullmatch(r"\d+(\.\d+)?", amount):
            return "Invalid amount"
        out["amount"] = amount
    elif weight and action == "buy":
        if not (re.fullmatch(r"\d+(\.\d+)?", weight) and 0 < float(weight) <= 100):
            return "Invalid weight"
        out["weight"] = weight
    else:
        return "Give shares, an amount or (buy) a weight"
    return out


def _kill_tree(p):
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
    else:
        p.kill()


def trade_batch(orders, submit=False, headless=False, on_result=None, should_stop=None, seconds_per_order=180):
    """Many orders in ONE Chrome session (`npm run trade-batch`): no new browser per order, the trader clicks the UMushroom
    logo between orders and records the journal once at the end. orders: [{action, company, portfolio, shares|amount|weight}].
    on_result(i, res) is called as each order finishes, res = {ok, submitted, output} like trade(); should_stop() is asked as
    results come in and skips the orders not started yet. Returns the list of results in order."""
    import json
    import tempfile
    results = [None] * len(orders)

    def report(i, res):
        results[i] = res
        if on_result:
            on_result(i, res)

    prepared, index = [], []
    for i, o in enumerate(orders):
        f = _batch_fields(o)
        if isinstance(f, str):
            report(i, {"ok": False, "submitted": False, "output": f})
        else:
            prepared.append({**f, "submit": submit is True})
            index.append(i)
    if not prepared:
        return results
    tmp = Path(tempfile.mkdtemp(prefix="hub-batch-"))
    orders_file, stop_file = tmp / "orders.json", tmp / "stop"
    orders_file.write_text(json.dumps(prepared), encoding="utf-8")
    env = dict(os.environ)
    if headless:
        env["MCP_HEADLESS"] = "true"
    log.info("Trade batch: %d orders (submit %s): %s", len(prepared), submit is True,
             ", ".join(f"{o['action']} {o['company']}" for o in prepared)[:500])
    lines = []
    with _order_lock:
        p = subprocess.Popen([NPM, "run", "trade-batch", "--", "--file", str(orders_file), "--stop-file", str(stop_file)],
                             cwd=TRADER, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                             errors="replace", env=env)
        timer = threading.Timer(60 + seconds_per_order * len(prepared), lambda: _kill_tree(p))
        timer.start()
        try:
            for line in p.stdout:
                lines.append(line.rstrip())
                if line.startswith("RESULT "):
                    try:
                        r = json.loads(line[7:])
                    except ValueError:
                        continue
                    i = index[r["index"]]
                    detail = r.get("error") or ("skipped" if r.get("skipped") else json.dumps(r.get("preview") or {}))
                    report(i, {"ok": bool(r.get("ok")), "submitted": r.get("submitted", False), "output": detail,
                               "skipped": bool(r.get("skipped"))})
                if should_stop and should_stop() and not stop_file.exists():
                    stop_file.write_text("stop", encoding="utf-8")
            p.wait()
        finally:
            timer.cancel()
    tail = "\n".join(lines[-15:])
    for i in index:  # the trader stopped before reporting these
        if results[i] is None:
            report(i, {"ok": False, "submitted": "unknown" if submit is True else False,
                       "output": "No result from the trader (it stopped or timed out). Check UMushroom before retrying.\n" + tail[-800:]})
    log.info("Trade batch finished: %d submitted, %d failed", sum(1 for r in results if r and r["submitted"] is True),
             sum(1 for r in results if r and not r["ok"]))
    return results


def journal(portfolio):
    """Read-only snapshot of a portfolio's holdings, pending orders and cash (`npm run log`): opens the portfolio page in
    the project Chrome and reads it, never opens an order form. Returns {ok, output}."""
    portfolio = str(portfolio).strip()
    if not NAME_RE.match(portfolio):
        return {"ok": False, "output": "Invalid portfolio name"}
    log.info("Journal: %s", portfolio)
    try:
        with _order_lock:  # same browser as the orders
            # --exit: stop once the snapshot is saved (without it the command keeps the journal page online and never returns)
            p = subprocess.run([NPM, "run", "log", "--", portfolio, "--exit"], cwd=TRADER, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=240)
    except Exception as e:
        return {"ok": False, "output": str(e)}
    out = (p.stdout + "\n" + p.stderr).strip()
    return {"ok": p.returncode == 0, "output": out[-3000:]}


def holdings(portfolio):
    """Tickers held in a portfolio according to the trader's latest journal snapshot (None if no journal)."""
    for latest in (TRADER / "logs").glob("*/latest.json"):
        snap = read_json(latest, {})
        if snap.get("portfolio", {}).get("name", "").strip().lower() == portfolio.strip().lower():
            held = set()
            for h in snap.get("holdings", []):
                m = re.search(r"/equity/([a-z0-9.]+)-", h.get("href", ""))
                if m:
                    held.add(m.group(1).upper())
            return {"tickers": held, "taken_at": snap.get("takenAt", "")}
    return None
