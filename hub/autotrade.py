"""
Automatic order placing after each reasoning run.

Modes (settings.auto_mode, changed only from the dashboard's Orders tab):
  off      nothing happens (default)
  dry_run  exactly like live (same picks, same limits, several stocks per run, order submitted),
           but in the PRACTICE portfolio, so the whole flow including the submit button is tested
           without touching the competition portfolio.
  live     orders are submitted in the competition portfolio.

Limits (all in settings):
  auto_portfolio        the competition portfolio name (live)
  auto_practice_portfolio  the practice portfolio name (dry_run); must differ from the competition one
  auto_min_prob         Jev probability needed (stricter than the suggestion threshold)
  auto_strategy         "signals": buy/sell the single Jev BUY/SELL suggestions (sizes below)
                        "tilt": rebalance the portfolio to the Sector tilt targets (tilt.py + rebalance.py): refresh its
                        holdings (read-only journal), sell what is above target, then buy what is below, by weight
  auto_weight_pct       signals: each buy in % of the portfolio (0 = auto_amount_usd instead)
  auto_amount_usd       signals: amount per BUY when auto_weight_pct is 0
  auto_sell             signals: SELL size, "all" or a number of shares
  auto_tilt_max_per_run / auto_tilt_max_per_day / auto_tilt_min_change_pct   tilt: order limits and smallest change
  auto_max_per_run      orders per reasoning run
  auto_max_per_day      orders per London day
  auto_cooldown_hours   no second order for the same stock within this time
  auto_us_only          skip tickers with a market suffix (e.g. 005930.KS) and assets marked "us": false in assets.json
  auto_run_kinds        which runs may trade (morning / intraday)

Live mode can only be switched on after a dry run submitted an order successfully in the practice portfolio
within the last 7 days. If the competition page changes and a live order fails, the mode drops back to dry_run.
"""
import json
import threading
from datetime import datetime, timedelta

from common import ASSETS_FILE, DATA, DECISIONS, load_settings, log, now_utc, read_json, save_settings, to_london
import rebalance
import tilt
from trader_bridge import holdings, journal, trade, trade_batch

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


def portfolio_for(s, mode):
    return (s["auto_practice_portfolio"] if mode == "dry_run" else s["auto_portfolio"]).strip()


def practice_problem(s):
    """Why dry runs cannot run yet ("" when they can). Dry runs submit, so they need their own portfolio."""
    practice = s["auto_practice_portfolio"].strip()
    if not practice:
        return ("Dry runs really submit orders. Enter a practice portfolio name first (not the competition one) "
                "and click \"Save limits\".")
    if practice.lower() == s["auto_portfolio"].strip().lower():
        return ("The practice portfolio must not have the same name as the competition portfolio, otherwise "
                "dry-run orders would land in the competition.")
    return ""


def last_good_dry_run(portfolio):
    """Latest dry run in this portfolio whose order was really submitted (older fill-only runs do not count)."""
    since = _london_now() - timedelta(days=DRY_RUN_VALID_DAYS)
    for r in reversed(ledger()):
        if (r.get("mode") == "dry_run" and r.get("ok") and r.get("submitted") is True
                and r.get("portfolio", "").lower() == portfolio.lower()
                and datetime.strptime(r["time"], "%Y-%m-%d %H:%M") >= since):
            return r
    return None


def can_go_live(settings=None):
    s = settings or load_settings()
    if not s["auto_portfolio"].strip():
        return False, "Enter the competition portfolio name first and click \"Save limits\"."
    why = practice_problem(s)
    if why:
        return False, why
    if not last_good_dry_run(s["auto_practice_portfolio"]):
        return False, (f"The practice portfolio \"{s['auto_practice_portfolio']}\" has no successfully submitted "
                       f"dry run in the last {DRY_RUN_VALID_DAYS} days. Click \"Dry run once\" or let dry-run mode "
                       "run a round, and check the order really went through.")
    return True, ""


def set_mode(mode):
    if mode not in ("off", "dry_run", "live"):
        return {"ok": False, "error": "bad mode"}
    if mode == "dry_run":
        why = practice_problem(load_settings())
        if why:
            return {"ok": False, "error": why}
    if mode == "live":
        ok, why = can_go_live()
        if not ok:
            return {"ok": False, "error": why}
    save_settings({"auto_mode": mode})
    log.info("Auto trading mode: %s", mode)
    return {"ok": True, "mode": mode}


def test_dry_run(symbol="AAPL"):
    """Submit one BUY in the practice portfolio to check the whole order flow, submit button included."""
    s = load_settings()
    why = practice_problem(s)
    if why:
        return {"ok": False, "submitted": False, "output": why}
    size = buy_size(s)
    res = trade("buy", symbol, s["auto_practice_portfolio"], submit=True, headless=bool(s["auto_headless"]), **size)
    _append({"time": _london_now().strftime("%Y-%m-%d %H:%M"), "decision": "test", "mode": "dry_run",
             "portfolio": s["auto_practice_portfolio"], "action": "BUY", "symbol": symbol, "prob": 0,
             **size, "attempted": False, "ok": res["ok"],
             "submitted": res["submitted"], "output": res["output"][-1500:]})
    return res


def buy_size(s):
    """Signals strategy: a buy by weight (% of the portfolio) unless auto_weight_pct is 0, then the fixed amount."""
    w = float(s.get("auto_weight_pct") or 0)
    return {"weight": f"{w:g}"} if w > 0 else {"amount": str(s["auto_amount_usd"])}


def pick(dec, s):
    """Candidate orders from a decision, after every limit. Returns (orders, skipped)."""
    now = _london_now()
    mode = s["auto_mode"]
    past = [r for r in ledger() if r.get("mode") == mode and r.get("attempted")]
    today = sum(1 for r in past if r["time"][:10] == now.strftime("%Y-%m-%d"))
    cutoff = now - timedelta(hours=float(s["auto_cooldown_hours"]))
    recent = {r["symbol"] for r in past if datetime.strptime(r["time"], "%Y-%m-%d %H:%M") >= cutoff}
    held = holdings(portfolio_for(s, mode))
    non_us = {k for k, v in read_json(ASSETS_FILE, {}).get("assets", {}).items() if v.get("us") is False}
    orders, skipped = [], []
    for r in dec["rows"]:
        if r["action"] == "HOLD":
            continue
        sym = r["symbol"]
        why = None
        if r["prob"] < float(s["auto_min_prob"]):
            why = f"probability {r['prob']:.0%} below {float(s['auto_min_prob']):.0%}"
        elif s["auto_us_only"] and ("." in sym or sym in non_us):
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


def execute(dec, force_dry_run=False):
    """Called by pipeline.run after a decision is written. Returns a summary or None when off.
    force_dry_run: the dashboard's "run a dry run now" button, whatever the mode and run kind."""
    s = load_settings()
    mode = "dry_run" if force_dry_run else s["auto_mode"]
    if not force_dry_run and (mode == "off" or dec["kind"] not in s["auto_run_kinds"]):
        return None
    if mode == "live" and not can_go_live(s)[0]:
        save_settings({"auto_mode": "dry_run"})
        mode = "dry_run"
        log.warning("Live auto trading needs a recent good dry run; switched back to dry_run")
    if mode == "dry_run" and practice_problem(s):
        log.warning("Auto trading is dry_run but the practice portfolio is not usable; skipped")
        return {"mode": mode, "done": [], "skipped": [], "error": "no practice portfolio set"}
    if mode == "live" and not s["auto_portfolio"].strip():
        log.warning("Auto trading is live but no competition portfolio is set; skipped")
        return {"mode": mode, "done": [], "skipped": [], "error": "no portfolio set"}
    portfolio = portfolio_for(s, mode)
    if s.get("auto_strategy") == "tilt":
        return execute_tilt(dec, s, mode, portfolio)
    orders, skipped = pick(dec, s)
    sized = [(r, buy_size(s) if r["action"] == "BUY" else {"shares": str(s["auto_sell"])}) for r in orders]
    done = _run_round(dec, s, mode, portfolio, [(r["action"], r["symbol"], size, {"prob": r["prob"]}) for r, size in sized], skipped)
    return {"mode": mode, "done": done, "skipped": skipped}


def _run_round(dec, s, mode, portfolio, plan, skipped):
    """Place a round's orders in one browser session. plan: [(action, symbol, size, extra ledger fields)].
    Live mode stops the rest of the round after an order the page did not accept."""
    done, stop = [], {"now": False}

    def on_result(i, res):
        action, symbol, size, extra = plan[i]
        if res.get("skipped"):
            skipped.append({"symbol": symbol, "action": action, "why": "stopped after a failed live order"})
            return
        row = {"time": _london_now().strftime("%Y-%m-%d %H:%M"), "decision": dec["id"], "mode": mode,
               "portfolio": portfolio, "action": action, "symbol": symbol, "prob": 0, **extra, **size,
               "attempted": True, "ok": res["ok"], "submitted": res["submitted"], "output": res["output"][-1500:]}
        _append(row)
        done.append(row)
        if mode == "live" and not res["ok"] and res["submitted"] is False:
            # the page did not behave as expected: stop placing live orders until a dry run works again
            save_settings({"auto_mode": "dry_run"})
            log.warning("Live order failed for %s; auto trading switched back to dry_run", symbol)
            stop["now"] = True

    if plan:
        trade_batch([{"action": a.lower(), "company": sym, "portfolio": portfolio, **size} for a, sym, size, _ in plan],
                    submit=True, headless=bool(s["auto_headless"]), on_result=on_result, should_stop=lambda: stop["now"])
    return done


def tilt_plan(dec, s, portfolio, refresh=True):
    """The sector tilt targets for this decision and the rebalance plan of the portfolio (fresh holdings first)."""
    if refresh:
        j = journal(portfolio)
        if not j["ok"]:
            return None, {"ok": False, "error": "could not read the portfolio's holdings: " + j["output"][-300:]}
    t = tilt.compute(decision=dec, min_rise=float(s["auto_min_prob"]))
    targets = {a["symbol"]: a["target"] for g in t["groups"] for a in g["assets"]}
    no_buy = {r["symbol"] for r in dec.get("rows", []) if r.get("action") == "SELL"}  # never buy what Jev rates SELL
    return t, rebalance.plan(portfolio, targets, float(s.get("auto_tilt_min_change_pct", 0.5)), no_buy)


def execute_tilt(dec, s, mode, portfolio):
    """Tilt strategy: sells above target first, then buys below target by weight, within the tilt limits.
    The competition rule check in the trader still applies to every order."""
    t, p = tilt_plan(dec, s, portfolio)
    if not p.get("ok"):
        log.warning("Tilt rebalance skipped: %s", p.get("error"))
        return {"mode": mode, "strategy": "tilt", "done": [], "skipped": [], "error": p.get("error")}
    now = _london_now()
    past = [r for r in ledger() if r.get("mode") == mode and r.get("attempted")]
    today = sum(1 for r in past if r["time"][:10] == now.strftime("%Y-%m-%d"))
    cutoff = now - timedelta(hours=float(s["auto_cooldown_hours"]))
    recent = {r["symbol"] for r in past if datetime.strptime(r["time"], "%Y-%m-%d %H:%M") >= cutoff}
    orders, skipped = [], []
    for side, r, _ in rebalance.by_sector(p, t["groups"]):  # sector by sector: its sells, then its buys
        if r["symbol"] in recent:
            skipped.append({"symbol": r["symbol"], "action": side,
                            "why": f"already traded in the last {s['auto_cooldown_hours']}h"})
        else:
            orders.append((side, r))
    room = max(0, min(int(s["auto_tilt_max_per_run"]), int(s["auto_tilt_max_per_day"]) - today))
    for side, r in orders[room:]:
        skipped.append({"symbol": r["symbol"], "action": side, "why": "run/day limit reached (the next run continues)"})
    plan = [(side, r["symbol"], {"shares": r["shares"]} if side == "SELL" else {"weight": f"{r['weight']:g}"},
             {"strategy": "tilt", "from": r["current"], "to": r["target"]}) for side, r in orders[:room]]
    done = _run_round(dec, s, mode, portfolio, plan, skipped)
    log.info("Tilt rebalance of %s: %d orders, %d skipped", portfolio, len(done), len(skipped))
    return {"mode": mode, "strategy": "tilt", "done": done, "skipped": skipped}


_now_lock = threading.Lock()


def dry_run_latest_now(notify=None):
    """Dry run the latest decision right away in a background thread (orders go to the practice portfolio)."""
    why = practice_problem(load_settings())
    if why:
        return {"ok": False, "error": why}
    files = sorted(DECISIONS.glob("*.json"))
    if not files:
        return {"ok": False, "error": "No trade suggestions yet. Run reasoning once from the Overview tab first."}
    dec = read_json(files[-1], None)
    if not dec or not dec.get("rows"):
        return {"ok": False, "error": "The latest trade suggestion is empty."}
    if not _now_lock.acquire(blocking=False):
        return {"ok": False, "error": "The previous dry run is still in progress."}

    def work():
        try:
            summary = execute(dec, force_dry_run=True)
            log.info("Dry run now on %s: %d orders", dec["id"], len(summary["done"]))
            if notify and summary["done"]:
                notify("\n".join(telegram_lines(summary)))
        except Exception:
            log.exception("Dry run now failed")
        finally:
            _now_lock.release()

    threading.Thread(target=work, daemon=True).start()
    return {"ok": True, "decision": dec["id"], "london": dec.get("london", "")}


def running_now():
    return _now_lock.locked()


def telegram_lines(summary):
    if not summary:
        return []
    label = {"dry_run": "🧪 Auto dry run (submitted in the practice portfolio)", "live": "🤖 Auto orders"}[summary["mode"]]
    lines = [label + ":"]
    for d in summary["done"]:
        size = (f"{d['weight']}% of the portfolio" if d.get("weight") else f"${d['amount']}" if d.get("amount")
                else f"{d['shares']} shares")
        state = ("✅" if d["ok"] else "❌") + (" unconfirmed, check UMushroom" if d["submitted"] == "unknown" else "")
        why = f"{d['from']}% -> {d['to']}%" if d.get("strategy") == "tilt" else f"{d['prob']:.0%}"
        lines.append(f"{state} {d['action']} {d['symbol']} {size} ({why})")
    if not summary["done"]:
        lines.append("no order met the limits" + (f" ({summary['error']})" if summary.get("error") else ""))
    return lines
