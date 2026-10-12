"""
Telegram order menu with buttons: /trade (or a bare /buy or /sell) opens one message that walks through
Buy/Sell → portfolio → stock → size → Submit, editing itself at each step. Nothing has to be typed, except an
optional custom ticker, amount or number of shares.

  Portfolios  settings "tg_portfolios", the default portfolio, the automatic-order portfolios and every portfolio
              the trader has a journal for
  Stocks      buy: the latest Jev BUY picks first (⭐), then every asset in news_bot/config.json, a page at a time;
              sell: the holdings in the trader's latest journal of that portfolio (all assets when there is none)
  Size        buy: preset amounts (settings "tg_amounts") or a typed amount / number of shares; sell: all or shares

Only the person who opened a menu can press its buttons, and only allowed users can open one (checked by the
caller). Submit hands the order to the same path as the text commands (tg_commands.submit_order).
"""
import itertools
import re
import time

from common import ASSETS_FILE, DECISIONS, NEWS_BOT, TRADER, load_settings, read_json
from trader_bridge import NAME_RE, holdings

MENU_MINUTES = 10
PAGE_SIZE = 20
PER_ROW = 4
NUMBER = re.compile(r"^\d+(\.\d+)?$")

_flows = {}          # flow id -> state
_typing = {}         # (chat_id, user_id) -> flow id waiting for a typed ticker, amount or number of shares
_ids = itertools.count(1)


# ---------- choices ----------

def portfolios():
    s = load_settings()
    names = list(s.get("tg_portfolios") or []) + [s.get("default_portfolio", ""), s.get("auto_portfolio", ""),
                                                  s.get("auto_practice_portfolio", "")]
    for latest in sorted((TRADER / "logs").glob("*/latest.json")):
        names.append(read_json(latest, {}).get("portfolio", {}).get("name", ""))
    seen, out = set(), []
    for n in names:
        n = str(n or "").strip()
        if n and NAME_RE.match(n) and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out[:10]


def buy_stocks():
    """(ticker, label) with the latest Jev BUY picks first."""
    cfg = [st["symbol"] for st in read_json(NEWS_BOT / "config.json", {}).get("stocks", [])]
    traded = read_json(ASSETS_FILE, {}).get("assets", {})
    files = sorted(DECISIONS.glob("*.json"))
    dec = read_json(files[-1], {}) if files else {}
    picks = sorted((r for r in dec.get("rows", []) if r.get("action") == "BUY"), key=lambda r: -r.get("prob", 0))
    out = [(r["symbol"], f"⭐{r['symbol']} {r.get('prob', 0):.0%}") for r in picks]
    rest = sorted((t for t in cfg if t not in {r["symbol"] for r in picks}),
                  key=lambda t: (not traded.get(t, {}).get("trade", True), t))
    return out + [(t, t) for t in rest]


def sell_stocks(portfolio):
    held = holdings(portfolio)
    if held and held["tickers"]:
        return [(t, t) for t in sorted(held["tickers"])], f"holdings from the journal of {held['taken_at'][:16]}"
    return buy_stocks(), "no journal for this portfolio, so all assets are listed"


def amounts():
    vals = load_settings().get("tg_amounts") or [1000, 2500, 5000, 10000]
    return [str(int(v)) if float(v).is_integer() else str(v) for v in vals][:6]


# ---------- rendering ----------

def _b(fid, label, op, arg=""):
    return {"text": label, "callback_data": f"m|{fid}|{op}|{arg}"[:64]}


def _size(f):
    if f["shares"] == "all":
        return "all shares"
    return f"{f['shares']} shares" if f["shares"] else (f"${float(f['amount']):,.2f}" if f["amount"] else "")


def summary(f):
    parts = [("Action", {"BUY": "🟢 BUY", "SELL": "🔴 SELL"}.get(f["action"], "")), ("Portfolio", f["portfolio"]),
             ("Stock", f["symbol"]), ("Size", _size(f))]
    return "\n".join(f"{k}: {v}" for k, v in parts if v)


def render(fid):
    f = _flows[fid]
    nav = [_b(fid, "◀ Back", "back"), _b(fid, "✖ Cancel", "x")]
    head = "\n".join(x for x in (f"🧾 Order menu for {f['who']}", summary(f)) if x)
    if f.get("typing"):
        what = {"sym": "a ticker or company name (e.g. AAPL)", "amt": "an amount in USD (e.g. 2500)",
                "sh": "a number of shares (e.g. 10)"}[f["typing"]]
        return head + f"\n\n⌨️ Reply to the group with {what}.", [[_b(fid, "◀ Back", "untype"), _b(fid, "✖ Cancel", "x")]]
    if not f["action"]:
        return head + "\n\nBuy or sell?", [[_b(fid, "🟢 Buy", "a", "BUY"), _b(fid, "🔴 Sell", "a", "SELL")],
                                           [_b(fid, "✖ Cancel", "x")]]
    if not f["portfolio"]:
        rows = [[_b(fid, p, "p", str(i))] for i, p in enumerate(f["pf_list"])]
        return head + "\n\nWhich portfolio?", rows + [nav]
    if not f["symbol"]:
        stocks, note = (buy_stocks(), "⭐ = latest Jev BUY picks") if f["action"] == "BUY" else sell_stocks(f["portfolio"])
        pages = max(1, -(-len(stocks) // PAGE_SIZE))
        page = min(f["page"], pages - 1)
        chunk = stocks[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]
        rows = [[_b(fid, label, "s", t) for t, label in chunk[i:i + PER_ROW]] for i in range(0, len(chunk), PER_ROW)]
        more = []
        if page > 0:
            more.append(_b(fid, "◀ Prev", "pg", str(page - 1)))
        more.append(_b(fid, "⌨️ Type a ticker", "t", "sym"))
        if page < pages - 1:
            more.append(_b(fid, "Next ▶", "pg", str(page + 1)))
        return head + f"\n\nWhich stock? ({note}; page {page + 1}/{pages})", rows + [more, nav]
    if not (f["amount"] or f["shares"]):
        if f["action"] == "BUY":
            row = [_b(fid, f"${int(float(a)):,}", "z", a) for a in amounts()]
            rows = [row[:3], row[3:]] if len(row) > 3 else [row]
            rows.append([_b(fid, "⌨️ Other amount", "t", "amt"), _b(fid, "⌨️ Shares", "t", "sh")])
        else:
            rows = [[_b(fid, "All shares", "z", "all"), _b(fid, "⌨️ Number of shares", "t", "sh")]]
        return head + "\n\nHow much?", [r for r in rows if r] + [nav]
    return head + "\n\nSubmit this order on UMushroom?", [[_b(fid, "✅ Submit", "ok"), _b(fid, "◀ Back", "back"),
                                                          _b(fid, "✖ Cancel", "x")]]


# ---------- flow ----------

def _edit(api, token, f, text, keyboard=None):
    params = {"chat_id": f["chat_id"], "message_id": f["msg_id"], "text": text}
    if keyboard is not None:
        params["reply_markup"] = {"inline_keyboard": keyboard}
    try:
        api(token, "editMessageText", **params)
    except Exception as ex:
        if "not modified" not in str(ex):
            raise


def open_menu(api, token, chat_id, uid, who, action="", reply_to=None):
    """Post a new menu message. action: "", "BUY" or "SELL" (a bare /buy or /sell skips the first step)."""
    _expire()
    fid = format(next(_ids), "x")
    _flows[fid] = {"uid": uid, "who": who, "chat_id": chat_id, "msg_id": None, "action": action, "portfolio": "",
                   "symbol": "", "amount": "", "shares": "", "page": 0, "typing": "", "pf_list": portfolios(),
                   "at": time.time()}
    text, kb = render(fid)
    params = {"chat_id": chat_id, "text": text, "reply_markup": {"inline_keyboard": kb}}
    if reply_to:
        params["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
    _flows[fid]["msg_id"] = api(token, "sendMessage", **params)["message_id"]
    return fid


def _back(f):
    """Undo the last choice."""
    for key in ("amount", "symbol", "portfolio", "action"):
        if key == "amount" and (f["amount"] or f["shares"]):
            f["amount"] = f["shares"] = ""
            return
        if key != "amount" and f[key]:
            f[key] = ""
            if key == "symbol":
                f["page"] = 0
            return


def on_callback(api, token, cq, submit):
    """A button press. submit(order, flow) places the order (text-command path) and returns an error text or ""."""
    data = cq.get("data", "")
    parts = data.split("|")
    if len(parts) != 4 or parts[0] != "m":
        return
    _, fid, op, arg = parts
    uid = str(cq.get("from", {}).get("id", ""))
    f = _flows.get(fid)
    if not f or time.time() - f["at"] > MENU_MINUTES * 60:
        _flows.pop(fid, None)
        api(token, "answerCallbackQuery", callback_query_id=cq["id"], text="This menu expired. Send /trade again.")
        return
    if uid != f["uid"]:
        api(token, "answerCallbackQuery", callback_query_id=cq["id"], text=f"Only {f['who']} can use this menu.")
        return
    api(token, "answerCallbackQuery", callback_query_id=cq["id"])
    f["at"] = time.time()
    if op == "x":
        _close(fid)
        return _edit(api, token, f, "✖ Order menu cancelled.\n" + summary(f), [])
    if op == "ok":
        order = {k: f[k] for k in ("action", "symbol", "shares", "amount", "portfolio")}
        why = submit(order, f)
        if why:
            return _edit(api, token, f, f"Can't place this order: {why}\n\n" + summary(f), render(fid)[1])
        _close(fid)
        return _edit(api, token, f, "⏳ Submitted to UMushroom, result follows below.\n" + summary(f), [])
    if op == "a" and arg in ("BUY", "SELL"):
        f["action"] = arg
    elif op == "p" and arg.isdigit() and int(arg) < len(f["pf_list"]):
        f["portfolio"] = f["pf_list"][int(arg)]
    elif op == "s" and NAME_RE.match(arg):
        f["symbol"] = arg
    elif op == "pg" and arg.isdigit():
        f["page"] = int(arg)
    elif op == "z" and (NUMBER.match(arg) or (arg == "all" and f["action"] == "SELL")):
        f["shares"], f["amount"] = ("all", "") if arg == "all" else ("", arg)
    elif op == "t" and arg in ("sym", "amt", "sh"):
        f["typing"] = arg
        _typing[(f["chat_id"], f["uid"])] = fid
    elif op == "untype":
        f["typing"] = ""
        _typing.pop((f["chat_id"], f["uid"]), None)
    elif op == "back":
        _back(f)
    text, kb = render(fid)
    _edit(api, token, f, text, kb)


def on_text(api, token, chat_id, uid, text):
    """A typed ticker, amount or number of shares for a menu waiting on it. Returns True when it was used."""
    fid = _typing.get((chat_id, uid))
    f = _flows.get(fid) if fid else None
    if not f or not f["typing"] or text.startswith("/"):
        return False
    value = text.strip().replace(",", "").lstrip("$＄")
    kind = f["typing"]
    if kind == "sym" and NAME_RE.match(text.strip()):
        f["symbol"] = text.strip().upper() if re.fullmatch(r"[A-Za-z.]{1,6}", text.strip()) else text.strip()
    elif kind == "amt" and NUMBER.match(value) and float(value) > 0:
        f["amount"], f["shares"] = value, ""
    elif kind == "sh" and NUMBER.match(value) and float(value) > 0:
        f["shares"], f["amount"] = value, ""
    else:
        return False
    f["typing"] = ""
    _typing.pop((chat_id, uid), None)
    f["at"] = time.time()
    text_, kb = render(fid)
    _edit(api, token, f, text_, kb)
    return True


def _close(fid):
    f = _flows.pop(fid, None)
    if f:
        _typing.pop((f["chat_id"], f["uid"]), None)


def _expire():
    for fid in [k for k, f in _flows.items() if time.time() - f["at"] > MENU_MINUTES * 60]:
        _close(fid)
