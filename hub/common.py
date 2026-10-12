"""
Shared paths, settings, logging and London/New York time helpers for the hub.

Folder layout (all relative, so the whole UKIC_Hub folder can be moved):
  UKIC_Hub/
    trader/    UMushroom buy/sell + portfolio journal (Node, from Nick_fixed)
    news_bot/  news collection + Jev + Telegram (Python, from Stocks_bot)
    hub/       this dashboard, the schedule and the reasoning pipeline
"""
import json
import logging
import sys
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HUB = Path(__file__).resolve().parent
ROOT = HUB.parent
TRADER = ROOT / "trader"
NEWS_BOT = ROOT / "news_bot"
DATA = HUB / "data"
BRIEFS = DATA / "briefs"
DECISIONS = DATA / "decisions"
SKILL = HUB / "skill"
WEB = HUB / "web"
SETTINGS_FILE = DATA / "settings.json"
ASSETS_FILE = DATA / "assets.json"
LOG_FILE = DATA / "hub.log"

for d in (DATA, BRIEFS, DECISIONS):
    d.mkdir(parents=True, exist_ok=True)

# news_bot modules (telegram_bot, jev) are imported from there and read news_bot/.env
if str(NEWS_BOT) not in sys.path:
    sys.path.insert(0, str(NEWS_BOT))
try:  # Telegram and Jev keys live in news_bot/.env
    from dotenv import load_dotenv
    load_dotenv(NEWS_BOT / ".env", override=True)
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler()],
)
log = logging.getLogger("hub")

DEFAULT_SETTINGS = {
    "market_mode": "eu_us",          # eu_us = 09:00 to US close - 30 min; us = US open to US close
    "eu_start": "09:00",             # London time, used in eu_us mode
    "eu_us_end_before_us_close_min": 30,
    "interval_min": 30,              # intraday reasoning interval: 30 or 60
    "weekdays_only": True,
    "morning_run": "06:00",          # full reasoning, result on Telegram before 07:00
    "night_runs": ["00:00", "03:00"],  # collect only: build the brief, no reasoning
    "telegram_morning": True,
    "telegram_intraday": "actionable",  # all / actionable / off
    "reminders": True,               # Telegram reminder before each market opens
    "reminder_before_min": 5,
    "lookback_hours": 24,            # news window for each brief
    "buy_threshold": 0.60,           # Jev probability of "price rise" needed for a BUY suggestion
    "sell_threshold": 0.60,          # Jev probability of "price down" needed for a SELL suggestion
    "min_margin": 0.15,              # rise vs down must differ by at least this much
    "default_portfolio": "First Portfolio",
    "tg_portfolios": ["First Portfolio", "JEVsimu"],  # portfolios offered by the Telegram order menu (/trade)
    "tg_amounts": [1000, 2500, 5000, 10000],          # amount buttons (USD) in the Telegram order menu
    "tg_default_amount_usd": 10000,  # Telegram "buy apple" with no shares or amount uses this; portfolio = default_portfolio
    # automatic orders (autotrade.py); auto_mode is changed only from the Orders tab and starts off
    "auto_mode": "off",              # off / dry_run / live
    "auto_portfolio": "",            # competition portfolio name on UMushroom
    "auto_practice_portfolio": "",   # practice portfolio: dry runs submit real orders here, never in the competition
    "auto_min_prob": 0.70,
    "auto_amount_usd": 10000,
    "auto_sell": "all",
    "auto_max_per_run": 2,
    "auto_max_per_day": 6,
    "auto_cooldown_hours": 24,
    "auto_us_only": True,
    "auto_run_kinds": ["morning", "intraday"],
    "auto_headless": False,          # True = no Chrome window during automatic orders
    "scheduler_enabled": True,
}

_lock = threading.Lock()


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path, data):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_settings():
    with _lock:
        s = dict(DEFAULT_SETTINGS)
        s.update(read_json(SETTINGS_FILE, {}))
        return s


def save_settings(update):
    with _lock:
        s = dict(DEFAULT_SETTINGS)
        s.update(read_json(SETTINGS_FILE, {}))
        for k, v in update.items():
            if k in DEFAULT_SETTINGS:
                s[k] = v
        write_json(SETTINGS_FILE, s)
        return s


# ---------- Time zones without tzdata (Windows Python has no IANA database by default) ----------
def _last_sunday(year, month):
    d = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def _nth_sunday(year, month, n):
    d = date(year, month, 1)
    d += timedelta(days=(6 - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def uk_offset(utc):
    """UK: BST (UTC+1) from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October."""
    y = utc.year
    start = datetime.combine(_last_sunday(y, 3), datetime.min.time(), timezone.utc) + timedelta(hours=1)
    end = datetime.combine(_last_sunday(y, 10), datetime.min.time(), timezone.utc) + timedelta(hours=1)
    return timedelta(hours=1) if start <= utc < end else timedelta(0)


def us_offset(utc):
    """US Eastern: EDT (UTC-4) from 2:00 local on the 2nd Sunday of March to 2:00 local on the 1st Sunday of November."""
    y = utc.year
    start = datetime.combine(_nth_sunday(y, 3, 2), datetime.min.time(), timezone.utc) + timedelta(hours=7)
    end = datetime.combine(_nth_sunday(y, 11, 1), datetime.min.time(), timezone.utc) + timedelta(hours=6)
    return timedelta(hours=-4) if start <= utc < end else timedelta(hours=-5)


def now_utc():
    return datetime.now(timezone.utc)


def to_london(utc):
    return (utc + uk_offset(utc)).replace(tzinfo=None)


def london_to_utc(local):
    """Naive London wall time -> aware UTC."""
    guess = local.replace(tzinfo=timezone.utc)
    return guess - uk_offset(guess - timedelta(hours=1))


def us_session_london(day):
    """US regular session (09:30-16:00 New York) for a London date, as naive London times."""
    noon = datetime(day.year, day.month, day.day, 12, tzinfo=timezone.utc)
    ny_open_utc = datetime(day.year, day.month, day.day, 9, 30, tzinfo=timezone.utc) - us_offset(noon)
    ny_close_utc = datetime(day.year, day.month, day.day, 16, 0, tzinfo=timezone.utc) - us_offset(noon)
    return to_london(ny_open_utc), to_london(ny_close_utc)


def hhmm(text, day):
    h, m = (int(x) for x in text.split(":"))
    return datetime(day.year, day.month, day.day, h, m)


def market_window(day, settings):
    """(start, end) of the intraday reasoning window, naive London time."""
    us_open, us_close = us_session_london(day)
    if settings["market_mode"] == "us":
        return us_open, us_close
    return hhmm(settings["eu_start"], day), us_close - timedelta(minutes=settings["eu_us_end_before_us_close_min"])


def clock_info(settings=None):
    settings = settings or load_settings()
    utc = now_utc()
    ldn = to_london(utc)
    us_open, us_close = us_session_london(ldn.date())
    start, end = market_window(ldn.date(), settings)
    weekday = ldn.weekday() < 5
    normal_gap = timedelta(hours=5)  # London is normally 5 hours ahead of New York
    gap = uk_offset(utc) - us_offset(utc)
    note = ""
    if gap != normal_gap:
        note = (f"UK and US clocks are {gap.seconds // 3600}h apart this week instead of 5h: "
                f"US market is {us_open:%H:%M}-{us_close:%H:%M} London time.")
    return {
        "london": ldn.strftime("%Y-%m-%d %H:%M:%S"),
        "london_tz": "BST" if uk_offset(utc) else "GMT",
        "new_york": (utc + us_offset(utc)).strftime("%H:%M"),
        "us_open": us_open.strftime("%H:%M"),
        "us_close": us_close.strftime("%H:%M"),
        "us_open_now": weekday and us_open <= ldn < us_close,
        "eu_open_now": weekday and hhmm("08:00", ldn) <= ldn < hhmm("16:30", ldn),
        "window": f"{start:%H:%M}-{end:%H:%M}",
        "in_window": weekday and start <= ldn < end,
        "dst_note": note,
    }
