"""
Telegram group commands: the bot reads the group in real time (long polling, started by server.py).

  Order menu          /trade (or a bare /buy or /sell) opens a button menu: Buy/Sell, portfolio, stock, size,
                      Submit (tg_menu.py). Nothing has to be typed.
  Trade commands      "/buy AAPL 100 shares in First Portfolio" / "sell NVDA all in First Portfolio" / "/buy TSLA $5000 in X"
                      (Chinese orders work too.) The bot repeats the parsed order and only submits after the same
                      person replies "yes".
  Everything else     sent to Claude for analysis, when the message is addressed to the bot:
                      @mention, a reply to the bot, "/ask ...", or starting with "?" (or the full-width question mark). In a private chat, every message.

Only people listed in TELEGRAM_ALLOWED_USERS (news_bot/.env, comma-separated Telegram user IDs) can use it.
Anyone else gets their ID back so the owner can add them.

news_bot/.env keys:
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   already used for notifications; only this group (or private chats) is read
  TELEGRAM_ALLOWED_USERS                 e.g. 123456789,987654321
  ANTHROPIC_API_KEY                      Claude analysis and order parsing (without it, only simple trade commands work)
  CLAUDE_MODEL                           optional, default claude-opus-5-5
  DASHSCOPE_API_KEY                      Qwen (Alibaba Cloud Bailian) for analysis; used when Claude is not
                                         set or fails (e.g. no credit)
  QWEN_MODEL                             optional, default qwen-plus
  LLM_PROVIDER                           optional, "qwen" to ask Qwen first instead of Claude

Telegram setting: in @BotFather send /setprivacy, pick the bot, choose Disable. Otherwise the bot only sees
/commands and messages that @mention it.
"""
import json
import re
import threading
import time

import requests

from common import (ASSETS_FILE, DATA, DECISIONS, NEWS_BOT, load_settings, log, now_utc, read_json, to_london,
                    write_json)
import tg_menu
from trader_bridge import NAME_RE, trade

OFFSET_FILE = DATA / "tg_offset.json"
ORDERS_LOG = DATA / "tg_orders.jsonl"
CONFIRM_MINUTES = 5
STALE_SECONDS = 120          # ignore messages older than this (e.g. sent while the hub was off)
DEFAULT_MODEL = "claude-opus-5-5"

TRADE_WORD = re.compile(r"买入|买进|加仓|卖出|卖掉|清仓|减仓|买|卖|\bbuy\b|\bsell\b", re.I)
SIZE_HINT = re.compile(r"\d|全部|所有|\ball\b", re.I)
YES = {"确认", "确定", "是", "yes", "y", "ok", "/yes", "/confirm"}
NO = {"取消", "不", "否", "no", "n", "cancel", "/no", "/cancel"}

_state = {"running": False, "error": "", "bot": "", "last_message": "", "pending": 0}
_pending = {}                # (chat_id, user_id) -> order dict
_trade_lock = threading.Lock()
_told_ids = set()


# ---------- settings and Telegram API ----------

def env():
    try:
        from dotenv import dotenv_values
        vals = dotenv_values(NEWS_BOT / ".env")
    except Exception:
        vals = {}
    return {k: (v or "").strip() for k, v in vals.items()}


def allowed_users(e):
    return {x.strip() for x in re.split(r"[,\s]+", e.get("TELEGRAM_ALLOWED_USERS", "")) if x.strip()}


def api(token, method, **params):
    r = requests.post(f"https://api.telegram.org/bot{token}/{method}", json=params, timeout=60)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"{method}: {data.get('description')}")
    return data["result"]


def say(token, chat_id, text, reply_to=None):
    # Telegram allows 4096 characters per message
    for i in range(0, max(len(text), 1), 3900):
        params = {"chat_id": chat_id, "text": text[i:i + 3900]}
        if reply_to and i == 0:
            params["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
        try:
            api(token, "sendMessage", **params)
        except Exception as ex:
            log.warning("Telegram reply failed: %s", ex)


def status():
    e = env()
    return {**_state, "pending": len(_pending), "allowed_users": len(allowed_users(e)),
            "claude": bool(e.get("ANTHROPIC_API_KEY")), "qwen": bool(e.get("DASHSCOPE_API_KEY")),
            "providers": providers(e)}


# ---------- help and command menu ----------

def help_text(bot):
    s = load_settings()
    pf = s.get("default_portfolio") or "First Portfolio"
    amt = f"${float(s.get('tg_default_amount_usd') or 0):,.0f}"
    return f"""📘 UKIC Bot: how to use

Call the bot by starting with @{bot}, replying to one of its messages, or using a / command.

🧾 ORDER MENU (easiest)
/trade opens a menu: tap Buy or Sell, the portfolio, the stock (⭐ = latest Jev BUY picks) and the amount, then ✅ Submit. A bare /buy or /sell opens it too.

🟢 BUY
/buy AAPL $5000 in {pf}
/buy NVDA 10 shares in {pf}
@{bot} buy Apple
(no amount or portfolio given: {amt} in {pf})

🔴 SELL
/sell TSLA 5 shares in {pf}
/sell TSLA all in {pf}
(a sell always needs a number of shares or "all")

✅ CONFIRM
The bot repeats your order first. Reply "yes" within {CONFIRM_MINUTES} minutes to submit it, or "no" to cancel. Only the person who sent the order can confirm it. The bot then reports ✅ submitted or ❌ failed.

💬 ASK FOR ANALYSIS
? What is the outlook for NVDA this week?
/ask Should we take profit on PLTR?
@{bot} summarise today's news on Tesla

ℹ️ /help shows this guide again.
Only whitelisted members can trade. If you are not on the list, the bot replies with your Telegram ID: send it to the admin."""


COMMANDS = [
    {"command": "trade", "description": "Order menu: tap Buy/Sell, portfolio, stock and amount"},
    {"command": "buy", "description": "Buy: /buy AAPL $5000 in First Portfolio"},
    {"command": "sell", "description": "Sell: /sell TSLA 5 shares in First Portfolio (or all)"},
    {"command": "ask", "description": "Ask for analysis: /ask outlook for NVDA"},
    {"command": "help", "description": "Show the bot guide and order templates"},
]


def set_menu(token):
    """The / menu Telegram shows when someone types / in the group."""
    try:
        api(token, "setMyCommands", commands=COMMANDS)
    except Exception as ex:
        log.warning("Telegram command menu not set: %s", ex)


# ---------- order parsing ----------

def _clean_portfolio(p):
    p = re.sub(r"组合$", "", p.strip(" \"'“”「」『』，,。")).strip()  # drop a trailing "portfolio" word and quotes
    return p if p and NAME_RE.match(p) else ""


# Chinese company names -> tickers, for orders written in Chinese
CN_NAMES = {"苹果": "AAPL", "英伟达": "NVDA", "特斯拉": "TSLA", "微软": "MSFT", "谷歌": "GOOGL", "亚马逊": "AMZN",
            "脸书": "META", "帕兰提尔": "PLTR", "洛克希德": "LMT", "奈飞": "NFLX", "超威": "AMD", "英特尔": "INTC",
            "台积电": "TSM", "博通": "AVGO", "甲骨文": "ORCL", "伯克希尔": "BRK.B", "可口可乐": "KO", "迪士尼": "DIS"}


def parse_simple(text):
    """Rule-based parser for commands like 'buy AAPL 100 shares in First Portfolio' (English or Chinese).
    Returns an order or None."""
    t = text.strip()
    t = re.sub(r"^/(buy|sell)(@\w+)?", r"\1", t, flags=re.I)
    m = re.search(r"买入|买进|加仓|买|\bbuy\b", t, re.I)
    s = re.search(r"卖出|卖掉|清仓|减仓|卖|\bsell\b", t, re.I)
    if bool(m) == bool(s):
        return None
    action = "BUY" if m else "SELL"
    portfolio = ""
    pm = (re.search(r"在\s*(.+?)\s*(?:里|中|内|组合)", t) or re.search(r"\bin\s+(?:portfolio\s+)?(.+)$", t, re.I)
          or re.search(r"(?:组合|portfolio)\s*[:：]\s*(.+)$", t, re.I))
    if pm:
        portfolio = _clean_portfolio(pm.group(1))
        t = t[:pm.start()] + " " + t[pm.end():]
    shares = amount = ""
    if re.search(r"全部|所有|\ball\b", t, re.I):
        shares = "all"
    sm = re.search(r"(\d+(?:\.\d+)?)\s*(?:股|shares?\b|sh\b)", t, re.I)
    am = (re.search(r"[$＄]\s*(\d[\d,]*(?:\.\d+)?)", t)
          or re.search(r"(\d[\d,]*(?:\.\d+)?)\s*(?:美元|美金|刀|usd\b|dollars?\b)", t, re.I))
    if sm:
        shares = sm.group(1)
    elif am:
        amount = am.group(1).replace(",", "")
    # company: the first ticker-like or English word left after removing the rest
    rest = re.sub(r"买入|买进|加仓|卖出|卖掉|清仓|减仓|买|卖|\bbuy\b|\bsell\b|全部|所有|\ball\b", " ", t, flags=re.I)
    rest = re.sub(r"[$＄]?\s*\d[\d,]*(?:\.\d+)?\s*(?:股|shares?|sh|美元|美金|刀|usd|dollars?)?", " ", rest, flags=re.I)
    for name, ticker in CN_NAMES.items():
        if name in rest:
            return {"action": action, "symbol": ticker, "shares": shares, "amount": amount, "portfolio": portfolio}
    words = re.findall(r"[A-Za-z][A-Za-z0-9.&'-]*", rest)
    words = [w for w in words if w.lower() not in {"of", "the", "in", "at", "for", "please", "now"}]
    if not words:
        return None
    return {"action": action, "symbol": words[0],
            "shares": shares, "amount": amount, "portfolio": portfolio}


ORDER_SCHEMA = {
    "type": "object",
    "properties": {
        "is_order": {"type": "boolean"},
        "action": {"type": "string", "enum": ["BUY", "SELL", ""]},
        "symbol": {"type": "string"},
        "shares": {"type": "string"},
        "amount_usd": {"type": "string"},
        "portfolio": {"type": "string"},
    },
    "required": ["is_order", "action", "symbol", "shares", "amount_usd", "portfolio"],
    "additionalProperties": False,
}


ORDER_PROMPT = ("Extract a stock order from a message written in a student investment club's Telegram group "
                "(Chinese or English). is_order is true only when the message asks to place a buy or sell order now. "
                "symbol: the US ticker (e.g. Apple/苹果 -> AAPL, 英伟达 -> NVDA); keep a non-US ticker with its suffix. "
                "shares: a number, 'all' when the message says all/全部, else empty. amount_usd: a dollar amount as a "
                "plain number, else empty. portfolio: the portfolio name exactly as written, else empty. "
                "Leave a field empty rather than guessing.")


def parse_with_claude(text, e):
    """Claude turns a free-form order ('please buy 100 Apple shares in First Portfolio') into fields;
    None if it is not an order."""
    resp = _claude(e).beta.messages.create(
        model=e.get("CLAUDE_MODEL") or DEFAULT_MODEL,
        max_tokens=2000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": ORDER_SCHEMA}},
        system=ORDER_PROMPT,
        messages=[{"role": "user", "content": text}],
    )
    if resp.stop_reason == "refusal":
        return None
    return _order_from(json.loads(next(b.text for b in resp.content if b.type == "text")))


def _order_from(data):
    data = {k: data.get(k, "") for k in ORDER_SCHEMA["required"]}
    data = {k: (v if k == "is_order" else str(v or "")) for k, v in data.items()}
    if data["is_order"] in ("false", "False"):
        data["is_order"] = False
    if not data["is_order"] or data["action"] not in ("BUY", "SELL") or not data["symbol"].strip():
        return None
    return {"action": data["action"], "symbol": data["symbol"].strip().upper(),
            "shares": data["shares"].strip().lower(), "amount": data["amount_usd"].strip().replace(",", ""),
            "portfolio": _clean_portfolio(data["portfolio"])}


def parse_with_qwen(text, e):
    """Same extraction as parse_with_claude, through Qwen's JSON mode."""
    r = requests.post(QWEN_URL, timeout=60, headers={"Authorization": f"Bearer {e['DASHSCOPE_API_KEY']}"},
                      json={"model": e.get("QWEN_MODEL") or DEFAULT_QWEN_MODEL,
                            "response_format": {"type": "json_object"},
                            "messages": [{"role": "system", "content": ORDER_PROMPT + " Reply with one JSON object "
                                          "with the keys " + ", ".join(ORDER_SCHEMA["required"]) + "; every value "
                                          "a string except is_order (true/false)."},
                                         {"role": "user", "content": text}]})
    if r.status_code != 200:
        raise RuntimeError(f"Qwen HTTP {r.status_code}: {r.text[:300]}")
    return _order_from(json.loads(r.json()["choices"][0]["message"]["content"]))


def parse_order(text, e):
    """Free-form order through the configured models (same order as analysis), then the simple parser."""
    for p in providers(e):
        try:
            order = parse_with_claude(text, e) if p == "claude" else parse_with_qwen(text, e)
            return order  # the model said it is not an order: answer it as a question instead
        except Exception as ex:
            log.warning("%s order parsing failed: %s", p, ex)
    return parse_simple(text)


def fill_defaults(order):
    """'buy apple' alone: default portfolio, and the default amount for a BUY. A SELL still needs a size."""
    s = load_settings()
    if not order["portfolio"]:
        order["portfolio"] = _clean_portfolio(str(s.get("default_portfolio", "")))
    if order["action"] == "BUY" and not (order["shares"] or order["amount"]):
        order["amount"] = str(s.get("tg_default_amount_usd") or "")
    return order


def problem(order):
    if not order["portfolio"]:
        return 'Please name the portfolio, e.g. "/buy AAPL 100 shares in First Portfolio".'
    if not (order["shares"] or order["amount"]):
        return "Please give a number of shares (e.g. 100 shares) or an amount (e.g. $5000)."
    if order["action"] == "BUY" and order["shares"] == "all":
        return 'A buy cannot use "all". Please give a number of shares or an amount.'
    if not NAME_RE.match(order["symbol"]):
        return f'I don\'t recognise the stock "{order['symbol']}". Please use its ticker, e.g. AAPL.'
    return ""


def describe(o):
    size = "all shares" if o["shares"] == "all" else (f"{o['shares']} shares" if o["shares"] else f"${o['amount']}")
    return f"{'BUY' if o['action'] == 'BUY' else 'SELL'} {o['symbol']} {size}, portfolio: {o['portfolio']}"


# ---------- Claude analysis ----------

def _claude(e):
    import anthropic  # imported here so the hub still runs when the package is missing
    return anthropic.Anthropic(api_key=e["ANTHROPIC_API_KEY"], timeout=180.0, max_retries=2)


def context_text():
    """Latest suggestions and the sector map, so Claude knows what the club is looking at."""
    lines = []
    files = sorted(DECISIONS.glob("*.json"))
    dec = read_json(files[-1], {}) if files else {}
    if dec.get("rows"):
        lines.append(f"Latest UKIC Hub reasoning run ({dec.get('london', '')} London, engine {dec.get('engine', '')}):")
        for r in dec["rows"]:
            if r.get("action") in ("BUY", "SELL"):
                lines.append(f"- {r['action']} {r['symbol']} probability {r.get('prob', 0):.0%}"
                             + (f", {r['why']}" if r.get("why") else ""))
    assets = read_json(ASSETS_FILE, {}).get("assets", {})
    if assets:
        lines.append("Watched assets by sector: " + "; ".join(
            f"{sym} ({a.get('sector', '')})" for sym, a in assets.items()))
    return "\n".join(lines)


def analyse(text, quoted, e):
    system = ("You are the analyst of UKIC, a student investment club trading in a stock-picking competition on "
              "UMushroom. Members ask you questions in their Telegram group. Answer in the language of the question, "
              "concisely (it is read on a phone; plain text, no Markdown tables). Use web search for recent news or "
              "prices when it matters and say how fresh the information is. Give your view with reasons and risks; "
              "orders are placed only by members, never by you.\n\n" + context_text())
    content = (f"(Replying to: {quoted})\n\n" if quoted else "") + text
    messages = [{"role": "user", "content": content}]
    client = _claude(e)
    for _ in range(4):  # pause_turn: the server paused a long web search, send it back to continue
        resp = client.beta.messages.create(
            model=e.get("CLAUDE_MODEL") or DEFAULT_MODEL,
            max_tokens=8000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium"},
            system=system,
            tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}],
            messages=messages,
        )
        if resp.stop_reason != "pause_turn":
            break
        messages.append({"role": "assistant", "content": resp.content})
    if resp.stop_reason == "refusal":
        return "Claude declined to answer this question."
    out = "".join(b.text for b in resp.content if b.type == "text").strip()
    return out or "Claude gave no answer."


QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
DEFAULT_QWEN_MODEL = "qwen-plus"


def analyse_qwen(text, quoted, e):
    """Same question through Qwen's OpenAI-compatible endpoint, with its built-in web search."""
    system = ("You are the analyst of UKIC, a student investment club trading in a stock-picking competition on "
              "UMushroom. Members ask you questions in their Telegram group. Answer in the language of the question, "
              "concisely (it is read on a phone; plain text, no Markdown tables). Search the web for recent news or "
              "prices when it matters and say how fresh the information is. Give your view with reasons and risks; "
              "orders are placed only by members, never by you.\n\n" + context_text())
    content = (f"(Replying to: {quoted})\n\n" if quoted else "") + text
    r = requests.post(QWEN_URL, timeout=180, headers={"Authorization": f"Bearer {e['DASHSCOPE_API_KEY']}"},
                      json={"model": e.get("QWEN_MODEL") or DEFAULT_QWEN_MODEL, "enable_search": True,
                            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}]})
    if r.status_code != 200:
        raise RuntimeError(f"Qwen HTTP {r.status_code}: {r.text[:300]}")
    out = (r.json()["choices"][0]["message"].get("content") or "").strip()
    return out or "Qwen gave no answer."


def providers(e):
    """Analysis engines that have a key, in the order they are tried."""
    order = [p for p, key in (("claude", "ANTHROPIC_API_KEY"), ("qwen", "DASHSCOPE_API_KEY")) if e.get(key)]
    if e.get("LLM_PROVIDER", "").lower() == "qwen" and "qwen" in order:
        order.remove("qwen")
        order.insert(0, "qwen")
    return order


def answer_question(text, quoted, e):
    """Ask each configured engine in turn; the next one answers when one fails (no credit, outage)."""
    errors = []
    for p in providers(e):
        try:
            return analyse(text, quoted, e) if p == "claude" else analyse_qwen(text, quoted, e)
        except ImportError:
            errors.append(f"{p}: the anthropic package is missing. Run start_hub.bat again to install it.")
        except Exception as ex:
            log.warning("%s analysis failed: %s", p, ex)
            errors.append(f"{'Claude' if p == 'claude' else 'Qwen'} error: {str(ex)[:300]}")
    return "\n".join(errors)


# ---------- message handling ----------

def _log_order(row):
    with ORDERS_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def handle_callback(cq, e):
    """A button press on an order menu."""
    token = e["TELEGRAM_BOT_TOKEN"]
    chat = (cq.get("message") or {}).get("chat", {})
    uid = str(cq.get("from", {}).get("id", ""))
    if chat.get("type") != "private" and str(chat.get("id")) != e.get("TELEGRAM_CHAT_ID", ""):
        return
    if uid not in allowed_users(e):
        api(token, "answerCallbackQuery", callback_query_id=cq["id"], text="You are not on the allowed list.")
        return

    def submit(order, flow):
        why = problem(order)
        if why:
            return why
        threading.Thread(target=_run_order, args=(token, flow["chat_id"], flow["msg_id"], flow["who"], order),
                         daemon=True).start()
        return ""

    tg_menu.on_callback(api, token, cq, submit)


def _run_order(token, chat_id, msg_id, who, order):
    with _trade_lock:  # one browser order at a time
        say(token, chat_id, f"⏳ Placing order: {describe(order)}", msg_id)
        res = trade(order["action"].lower(), order["symbol"], order["portfolio"], shares=order["shares"],
                    amount=order["amount"], submit=True)
    _log_order({"time": to_london(now_utc()).strftime("%Y-%m-%d %H:%M"), "by": who, **order,
                "ok": res["ok"], "submitted": res["submitted"], "output": res["output"][-1500:]})
    if res["ok"] and res["submitted"] is True:
        say(token, chat_id, f"✅ Submitted: {describe(order)}", msg_id)
    elif res["submitted"] == "unknown":
        say(token, chat_id, f"⚠ Sent but not confirmed. Please check UMushroom: {describe(order)}", msg_id)
    else:
        tail = res["output"].strip().splitlines()[-3:]
        say(token, chat_id, f"❌ Order failed: {describe(order)}\n" + "\n".join(tail), msg_id)


def handle(msg, e, me):
    token = e["TELEGRAM_BOT_TOKEN"]
    chat = msg.get("chat", {})
    chat_id, msg_id = chat.get("id"), msg.get("message_id")
    text = (msg.get("text") or "").strip()
    user = msg.get("from") or {}
    uid = str(user.get("id", ""))
    who = user.get("username") or user.get("first_name") or uid
    if not text or user.get("is_bot") or time.time() - msg.get("date", 0) > STALE_SECONDS:
        return
    private = chat.get("type") == "private"
    if not private and str(chat_id) != e.get("TELEGRAM_CHAT_ID", ""):
        return  # only the club group

    if tg_menu.on_text(api, token, chat_id, uid, text):
        return  # a typed ticker, amount or number of shares for an open order menu

    bot_name = me.get("username", "")
    mentioned = bool(bot_name) and f"@{bot_name}".lower() in text.lower()
    replied = (msg.get("reply_to_message") or {}).get("from", {}).get("id") == me.get("id")
    asked = text.startswith(("/ask", "?", "？"))  # half- or full-width question mark
    key = (chat_id, uid)
    lowered = text.lower().strip(" .。!！")

    # confirmation of a pending order
    if key in _pending and (lowered in YES or lowered in NO):
        order = _pending.pop(key)
        if lowered in NO:
            return say(token, chat_id, "Cancelled.", msg_id)
        if time.time() - order["at"] > CONFIRM_MINUTES * 60:
            return say(token, chat_id, f"More than {CONFIRM_MINUTES} minutes passed, so the order expired. "
                                       "Please send it again.", msg_id)
        order = {k: order[k] for k in ("action", "symbol", "shares", "amount", "portfolio")}
        threading.Thread(target=_run_order, args=(token, chat_id, msg_id, who, order), daemon=True).start()
        return

    clean = re.sub(rf"@{re.escape(bot_name)}", "", text, flags=re.I).strip() if bot_name else text
    clean = re.sub(r"^/ask(@\w+)?\s*|^[?？]\s*", "", clean).strip()
    looks_like_order = (bool(TRADE_WORD.search(clean)) and bool(SIZE_HINT.search(clean))) or \
        bool(re.match(r"^/(buy|sell)\b", clean, re.I))
    addressed = private or mentioned or replied or asked
    if re.fullmatch(r"/?trade", clean.strip(), re.I) and clean.startswith("/"):
        looks_like_order = True  # /trade: handled with the order menu below
    if re.match(r"^/(help|start)\b", clean, re.I) or (mentioned and re.fullmatch(r"(help|帮助|模板|template)?", clean, re.I)):
        return say(token, chat_id, help_text(bot_name), msg_id)
    if addressed and TRADE_WORD.search(clean) and not asked:
        looks_like_order = True  # "@bot buy apple": defaults fill in the size and portfolio
    if not looks_like_order and not addressed:
        return  # members talking to each other

    if uid not in allowed_users(e):
        if uid not in _told_ids:
            _told_ids.add(uid)
            say(token, chat_id, f"Your Telegram ID is {uid} and it is not on the allowed list yet. Ask the admin "
                                "to add it to TELEGRAM_ALLOWED_USERS in news_bot\\.env, then try again.", msg_id)
        return
    _state["last_message"] = to_london(now_utc()).strftime("%Y-%m-%d %H:%M")

    bare = re.fullmatch(r"/?(trade|buy|sell|交易|买|卖)", clean.strip(), re.I)
    if bare and (clean.startswith("/") or addressed):
        word = bare.group(1).lower()
        action = "BUY" if word in ("buy", "买") else "SELL" if word in ("sell", "卖") else ""
        tg_menu.open_menu(api, token, chat_id, uid, who, action, msg_id)
        return

    if looks_like_order:
        order = parse_order(clean, e)
        if order:
            order = fill_defaults(order)
            why = problem(order)
            if why:
                return say(token, chat_id, "Can't place this order: " + why, msg_id)
            _pending[key] = {**order, "at": time.time()}
            return say(token, chat_id, f"Please confirm: {describe(order)}\n"
                                       f"Reply yes to submit or no to cancel (within {CONFIRM_MINUTES} minutes, "
                                       "only you can confirm).", msg_id)
        if re.match(r"^/(buy|sell)\b", clean, re.I):
            return say(token, chat_id, "Write it like this:\n/buy AAPL $5000 in First Portfolio\n"
                                       "/buy NVDA 10 shares in First Portfolio\n/sell TSLA all in First Portfolio\n"
                                       "/help for the full guide.", msg_id)
        if not addressed:
            return

    if not providers(e):
        return say(token, chat_id, "No analysis model is set up yet. Add ANTHROPIC_API_KEY (Claude) or "
                                   "DASHSCOPE_API_KEY (Qwen) to news_bot\\.env.", msg_id)
    quoted = (msg.get("reply_to_message") or {}).get("text", "")[:2000]
    try:
        api(token, "sendChatAction", chat_id=chat_id, action="typing")
    except Exception:
        pass
    say(token, chat_id, answer_question(clean or text, quoted, e), msg_id)


# ---------- polling loop ----------

def loop():
    offset = read_json(OFFSET_FILE, {}).get("offset", 0)
    me, me_token = {}, ""
    while True:
        e = env()
        token = e.get("TELEGRAM_BOT_TOKEN", "")
        if not token:
            _state.update(running=False, error="TELEGRAM_BOT_TOKEN is not set")
            time.sleep(30)
            continue
        try:
            if token != me_token:
                me, me_token = api(token, "getMe"), token
                set_menu(token)
                _state["bot"] = me.get("username", "")
            updates = api(token, "getUpdates", offset=offset, timeout=30, allowed_updates=["message", "callback_query"])
            _state.update(running=True, error="")
            for u in updates:
                offset = u["update_id"] + 1
                write_json(OFFSET_FILE, {"offset": offset})
                try:
                    if u.get("message"):
                        handle(u["message"], e, me)
                    elif u.get("callback_query"):
                        handle_callback(u["callback_query"], e)
                except Exception:
                    log.exception("Telegram command failed")
            for k in [k for k, o in _pending.items() if time.time() - o["at"] > CONFIRM_MINUTES * 60]:
                _pending.pop(k, None)
        except Exception as ex:
            # 409 Conflict: another program is reading the same bot (only one reader is allowed)
            _state.update(running=False, error=str(ex)[:200])
            log.warning("Telegram listener: %s", ex)
            time.sleep(15)


def start():
    threading.Thread(target=loop, name="tg-commands", daemon=True).start()
    log.info("Telegram command listener started")
