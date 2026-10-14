"""
Schedule (London time, winter/summer time handled automatically):
  - morning run      settings.morning_run (default 06:00): full reasoning, Telegram before 07:00
  - intraday runs    every interval_min inside the market window
                     eu_us: eu_start (09:00) to US close - 30 min  (20:30, or 19:30 in the week of 25 Oct-1 Nov)
                     us:    US open to US close                    (14:30-21:00, or 13:30-20:00 that week)
  - night runs       settings.night_runs: collect only, no reasoning
  - reminders        Telegram reminder N minutes before each market opens, to open UMushroom and place orders
"""
import threading
import time
import traceback
from datetime import datetime, timedelta

import pipeline
from common import hhmm, load_settings, log, market_window, now_utc, to_london, us_session_london

state = {"running": None, "last": None, "last_error": None, "history": []}
_run_lock = threading.Lock()


def day_slots(day, s):
    """[(london datetime, kind)] for one London date."""
    slots = []
    weekday = day.weekday() < 5
    if weekday or not s["weekdays_only"]:
        slots.append((hhmm(s["morning_run"], day), "morning"))
        start, end = market_window(day, s)
        t = start
        while t <= end:
            slots.append((t, "intraday"))
            t += timedelta(minutes=int(s["interval_min"]))
        if s["reminders"]:
            before = timedelta(minutes=int(s["reminder_before_min"]))
            if s["market_mode"] == "eu_us":
                slots.append((start - before, "reminder_eu"))
            slots.append((us_session_london(day)[0] - before, "reminder_us"))
    for n in s["night_runs"]:
        slots.append((hhmm(n, day), "night"))
    # the morning run replaces a night run at the same minute
    taken = {t for t, k in slots if k == "morning"}
    slots = [(t, k) for t, k in slots if not (k == "night" and t in taken)]
    return sorted(set(slots))


def upcoming(n=8):
    s = load_settings()
    now = to_london(now_utc())
    out = []
    for d in range(3):
        day = (now + timedelta(days=d)).date()
        out += [(t, k) for t, k in day_slots(day, s) if t > now]
    return [{"time": t.strftime("%a %H:%M"), "kind": k} for t, k in out[:n]]


def run_now(kind):
    if not _run_lock.acquire(blocking=False):
        return False
    def work():
        state["running"] = {"kind": kind, "since": to_london(now_utc()).strftime("%H:%M:%S")}
        try:
            res = pipeline.run(kind)
            state["last"] = {"kind": kind, "at": to_london(now_utc()).strftime("%Y-%m-%d %H:%M"), **res}
            state["last_error"] = None
        except Exception:
            state["last_error"] = traceback.format_exc()[-800:]
            log.error("Run %s failed:\n%s", kind, state["last_error"])
        finally:
            state["history"] = ([state["last"]] + state["history"])[:20] if state["last"] else state["history"]
            state["running"] = None
            _run_lock.release()
    threading.Thread(target=work, daemon=True).start()
    return True


def reminder(kind):
    us_open = us_session_london(to_london(now_utc()).date())[0]
    text = ("⏰ European session starting: open UMushroom and check the latest suggestions."
            if kind == "reminder_eu" else
            f"⏰ US market opens at {us_open:%H:%M} London: open UMushroom and place today's orders.")
    pipeline.notify(text + "\nDashboard: http://127.0.0.1:6400/")


def loop():
    last = to_london(now_utc())
    log.info("Scheduler started")
    while True:
        time.sleep(20)
        try:
            s = load_settings()
            now = to_london(now_utc())
            if s["scheduler_enabled"]:
                due = [k for t, k in day_slots(now.date(), s) + day_slots(last.date(), s) if last < t <= now]
                for k in dict.fromkeys(due):
                    log.info("Scheduled: %s", k)
                    if k.startswith("reminder"):
                        reminder(k)
                    elif not run_now(k):
                        log.info("Skipped %s: previous run still going", k)
            last = now
        except Exception:
            log.error("Scheduler error:\n%s", traceback.format_exc())


def start():
    threading.Thread(target=loop, daemon=True).start()
