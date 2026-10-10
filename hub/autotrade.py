"""
Automatic order placing after each reasoning run.

Modes (settings.auto_mode, changed only from the dashboard's Orders tab):
  off      nothing happens (default)
  dry_run  for each qualifying suggestion, the trader opens UMushroom and fills in the order form
           in the competition portfolio WITHOUT submitting. This checks that the page's buttons still work.
  live     same, but the order is submitted.

Limits (all in settings):
  auto_portfolio        the competition portfolio name; nothing runs without it
  auto_min_prob         Jev probability needed (stricter than the suggestion threshold)
  auto_amount_usd       amount per BUY
  auto_sell             SELL size: "all" or a number of shares
  auto_max_per_run      orders per reasoning run
  auto_max_per_day      orders per London day
  auto_cooldown_hours   no second order for the same stock within this time
  auto_us_only          skip tickers with a market suffix (e.g. 005930.KS)
  auto_run_kinds        which runs may trade (morning / intraday)

Live mode can only be switched on after a dry run in the same portfolio filled the form correctly
within the last 7 days. If the competition page changes and a live order fails, the mode drops back to dry_run.
"""
import json
from datetime import datetime, timedelta

from common import DATA, load_settings, log, now_utc, save_settings, to_london
from trader_bridge import holdings, trade

LEDGER = DATA / "auto_trades.jsonl"
DRY_RUN_VALID_DAYS = 7


def ledger(limit=None):
    try:
        rows = [json.loads(l) for l in LEDGER.read_text(encoding="utf-8").splitlines() if l.strip()]
    except OSError:
        rows = []
    return rows[-limit:] if limit else rows


def _append(row):
    with LEDGER.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _london_now():
    return to_london(now_utc())


def last_good_dry_run(portfolio):
    since = _london_now() - timedelta(days=DRY_RUN_VALID_DAYS)
    for r in reversed(ledger()):
        if (r.get("mode") == "dry_run" and r.get("ok") and r.get("portfolio", "").lower() == portfolio.lower()
                and datetime.strptime(r["time"], "%Y-%m-%d %H:%M") >= since):
            return r
    return None


def can_go_live(settings=None):
    s = settings or load_settings()
    if not s["auto_portfolio"].strip():
        return False, "请先填写比赛组合名称，并点\"保存限额\"。"
    if not last_good_dry_run(s["auto_portfolio"]):
        return False, (f"比赛组合“{s['auto_portfolio']}”最近 {DRY_RUN_VALID_DAYS} 天没有成功的演练。"
                       "请先点“演练一次”，确认它在比赛组合里正确填好了订单。")
    return True, ""


def set_mode(mode):
    if mode not in ("off", "dry_run", "live"):
        return {"ok": False, "error": "bad mode"}
    if mode == "live":
        ok, why = can_go_live()
        if not ok:
            return {"ok": False, "error": why}
    save_settings({"auto_mode": mode})
    log.info("Auto trading mode: %s", mode)
    return {"ok": True, "mode": mode}


def test_dry_run(symbol="AAPL"):
    """Fill in (never submit) a BUY in the competition portfolio to check the page still works."""
    s = load_settings()
    if not s["auto_portfolio"].strip():
        return {"ok": False, "submitted": False, "output": "请先填写比赛组合名称，并点\"保存限额\"。"}
    res = trade("buy", symbol, s["auto_portfolio"], amount=str(s["auto_amount_usd"]), submit=False,
                headless=bool(s["auto_headless"]))
    _append({"time": _london_now().strftime("%Y-%m-%d %H:%M"), "decision": "test", "mode": "dry_run",
             "portfolio": s["auto_portfolio"], "action": "BUY", "symbol": symbol, "prob": 0,
             "amount": str(s["auto_amount_usd"]), "attempted": False, "ok": res["ok"],
             "submitted": res["submitted"], "output": res["output"][-1500:]})
    return res


def pick(dec, s):
    """Candidate orders from a decision, after every limit. Returns (orders, skipped)."""
    now = _london_now()
    mode = s["auto_mode"]
    past = [r for r in ledger() if r.get("mode") == mode and r.get("attempted")]
    today = sum(1 for r in past if r["time"][:10] == now.strftime("%Y-%m-%d"))
    cutoff = now - timedelta(hours=float(s["auto_cooldown_hours"]))
    recent = {r["symbol"] for r in past if datetime.strptime(r["time"], "%Y-%m-%d %H:%M") >= cutoff}
    held = holdings(s["auto_portfolio"])
    orders, skipped = [], []
    for r in dec["rows"]:
        if r["action"] == "HOLD":
            continue
        sym = r["symbol"]
        why = None
        if r["prob"] < float(s["auto_min_prob"]):
            why = f"probability {r['prob']:.0%} below {float(s['auto_min_prob']):.0%}"
        elif s["auto_us_only"] and "." in sym:
            why = "not a US ticker"
        elif sym in recent:
            why = f"already traded in the last {s['auto_cooldown_hours']}h"
        elif r["action"] == "SELL" and held is None:
            why = "no journal for this portfolio, holdings unknown"
        elif r["action"] == "SELL" and sym.upper() not in held["tickers"]:
            why = "not held"
        if why:
            skipped.append({"symbol": sym, "action": r["action"], "why": why})
            continue
        orders.append(r)
    room = max(0, min(int(s["auto_max_per_run"]), int(s["auto_max_per_day"]) - today))
    for r in orders[room:]:
        skipped.append({"symbol": r["symbol"], "action": r["action"], "why": "run/day limit reached"})
    return orders[:room], skipped


def execute(dec):
    """Called by pipeline.run after a decision is written. Returns a summary or None when off."""
    s = load_settings()
    mode = s["auto_mode"]
    if mode == "off" or dec["kind"] not in s["auto_run_kinds"]:
        return None
    if not s["auto_portfolio"].strip():
        log.warning("Auto trading is %s but no competition portfolio is set; skipped", mode)
        return {"mode": mode, "done": [], "skipped": [], "error": "no portfolio set"}
    if mode == "live" and not can_go_live(s)[0]:
        save_settings({"auto_mode": "dry_run"})
        mode = "dry_run"
        log.warning("Live auto trading needs a recent good dry run; switched back to dry_run")
    orders, skipped = pick(dec, s)
    done = []
    for i, r in enumerate(orders):
        side = "buy" if r["action"] == "BUY" else "sell"
        size = {"amount": str(s["auto_amount_usd"])} if side == "buy" else {"shares": str(s["auto_sell"])}
        res = trade(side, r["symbol"], s["auto_portfolio"], submit=(mode == "live"),
                    headless=bool(s["auto_headless"]), **size)
        row = {"time": _london_now().strftime("%Y-%m-%d %H:%M"), "decision": dec["id"], "mode": mode,
               "portfolio": s["auto_portfolio"], "action": r["action"], "symbol": r["symbol"], "prob": r["prob"],
               **size, "attempted": True, "ok": res["ok"], "submitted": res["submitted"],
               "output": res["output"][-1500:]}
        _append(row)
        done.append(row)
        if mode == "live" and not res["ok"] and res["submitted"] is False:
            # the page did not behave as expected: stop placing live orders until a dry run works again
            save_settings({"auto_mode": "dry_run"})
            log.warning("Live order failed for %s; auto trading switched back to dry_run", r["symbol"])
            skipped += [{"symbol": x["symbol"], "action": x["action"], "why": "stopped after a failed live order"}
                        for x in orders[i + 1:]]
            break
    return {"mode": mode, "done": done, "skipped": skipped}


def telegram_lines(summary):
    if not summary:
        return []
    label = {"dry_run": "🧪 Auto (dry run, not submitted)", "live": "🤖 Auto orders"}[summary["mode"]]
    lines = [label + ":"]
    for d in summary["done"]:
        size = f"${d['amount']}" if "amount" in d else f"{d['shares']} shares"
        state = ("✅" if d["ok"] else "❌") + (" unconfirmed, check UMushroom" if d["submitted"] == "unknown" else "")
        lines.append(f"{state} {d['action']} {d['symbol']} {size} ({d['prob']:.0%})")
    if not summary["done"]:
        lines.append("no order met the limits" + (f" ({summary['error']})" if summary.get("error") else ""))
    return lines
