"""
Batch orders from the dashboard's Orders tab: a list (e.g. pasted from a CSV) placed one after another in one portfolio.

Only started by the person at the dashboard. "Preview" fills in each order form without submitting; "Submit" places the
orders and needs the portfolio name typed again as confirmation (checked in server.py). Stop skips the orders not yet
started. Every result is appended to hub/data/batch_orders.jsonl.
"""
import json
import re
import threading

from common import DATA, log, now_utc, to_london
from trader_bridge import NAME_RE, PAGE_RE, order_id, trade_batch

LEDGER = DATA / "batch_orders.jsonl"
MAX_ORDERS = 60
ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
NUMBER = re.compile(r"^\d+(\.\d+)?$")

_state = {"running": False, "submit": False, "portfolio": "", "started": "", "finished": "", "stopping": False, "rows": []}
_lock = threading.Lock()


def _now():
    return to_london(now_utc()).strftime("%Y-%m-%d %H:%M:%S")


def state():
    return {**_state, "rows": [dict(r) for r in _state["rows"]]}


def check(orders):
    """Validate the pasted orders. Returns (rows, errors); a row is {action, company, shares, amount}."""
    rows, errors = [], []
    if not isinstance(orders, list) or not orders:
        return [], ["The list is empty."]
    if len(orders) > MAX_ORDERS:
        return [], [f"At most {MAX_ORDERS} orders per batch."]
    for i, o in enumerate(orders, 1):
        action = str(o.get("action") or "buy").lower()
        company = str(o.get("company") or "").strip()
        shares, amount = str(o.get("shares") or "").strip(), str(o.get("amount") or "").replace(",", "").strip()
        weight = str(o.get("weight") or "").replace("%", "").strip() if not (shares or amount) else ""
        if action not in ("buy", "sell"):
            errors.append(f"Line {i}: action must be buy or sell.")
        elif not company or not (NAME_RE.match(company) or PAGE_RE.match(order_id(company)) or ISIN_RE.match(company)):
            errors.append(f"Line {i}: \"{company}\" is not a ticker, name, ISIN or UMushroom page address.")
        elif weight:
            if action != "buy" or not (NUMBER.match(weight) and 0 < float(weight) <= 100):
                errors.append(f"Line {i} ({company}): a weight is a % between 0 and 100, and only for buys.")
            else:
                rows.append({"action": action, "company": company, "shares": "", "amount": "", "weight": weight})
        elif bool(shares) == bool(amount):
            errors.append(f"Line {i} ({company}): give either shares or an amount, not both.")
        elif shares and not (NUMBER.match(shares) and float(shares) > 0) and not (shares == "all" and action == "sell"):
            errors.append(f"Line {i} ({company}): shares must be a number greater than 0.")
        elif amount and not (NUMBER.match(amount) and float(amount) > 0):
            errors.append(f"Line {i} ({company}): amount must be a number greater than 0.")
        else:
            rows.append({"action": action, "company": company, "shares": shares, "amount": amount, "weight": ""})
    return rows, errors


def start(portfolio, orders, submit):
    portfolio = str(portfolio or "").strip()
    if not NAME_RE.match(portfolio):
        return {"ok": False, "error": "Enter the portfolio name."}
    rows, errors = check(orders)
    if errors:
        return {"ok": False, "error": " ".join(errors[:5])}
    if not _lock.acquire(blocking=False):
        return {"ok": False, "error": "A batch is already running."}
    _state.update(running=True, submit=bool(submit), portfolio=portfolio, started=_now(), finished="", stopping=False,
                  rows=[{**r, "status": "waiting", "result": ""} for r in rows])
    log.info("Batch %s: %d orders in %s", "submit" if submit else "preview", len(rows), portfolio)
    threading.Thread(target=_work, daemon=True).start()
    return {"ok": True, "state": state()}


def stop():
    if _state["running"]:
        _state["stopping"] = True
    return state()


def _work():
    """The whole list in one browser session (trader_bridge.trade_batch): no new Chrome per order."""
    rows = _state["rows"]

    def on_result(i, res):
        r = rows[i]
        tail = [x for x in res["output"].splitlines() if x.strip()][-2:]
        if res.get("skipped"):
            r.update(status="skipped", result="stopped before this order")
        elif not res["ok"]:
            r.update(status="failed" if res["submitted"] != "unknown" else "unconfirmed",
                     result=" / ".join(tail)[-400:])
        elif not _state["submit"]:
            r.update(status="previewed", result="form filled in, not submitted")
        elif res["submitted"] is True:
            r.update(status="submitted", result="")
        else:
            r.update(status="unconfirmed", result="sent but not confirmed: check UMushroom")
        if i + 1 < len(rows) and rows[i + 1]["status"] == "waiting" and not _state["stopping"]:
            rows[i + 1]["status"] = "running"
        with LEDGER.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"time": _now(), "portfolio": _state["portfolio"], "submit": _state["submit"], **r,
                                "output": res["output"][-1500:]}, ensure_ascii=False) + "\n")

    try:
        if rows:
            rows[0]["status"] = "running"
        orders = [{"action": r["action"], "company": r["company"], "portfolio": _state["portfolio"], "shares": r["shares"],
                   "amount": r["amount"], "weight": r.get("weight", "")} for r in rows]
        trade_batch(orders, submit=_state["submit"], on_result=on_result, should_stop=lambda: _state["stopping"])
    except Exception:
        log.exception("Batch failed")
    finally:
        _state.update(running=False, finished=_now())
        counts = {}
        for r in _state["rows"]:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        log.info("Batch finished: %s", counts)
        _lock.release()
