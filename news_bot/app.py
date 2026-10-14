"""
Stock News Bot - runs everything in one go.

Each round: collect news for all companies -> filter and de-duplicate -> Jev judgement
-> send to Telegram -> update the dashboard.
Repeats every 20 minutes by default (check_interval_minutes in config.json) while the window is open.

Usage: double-click start_stock_bot.bat (or python app.py)
       python app.py --once   run a single round
"""
import importlib
import socket
import sys
import time
import traceback
import webbrowser
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
LOCK_PORT = 47321  # a local port used to prevent running two copies


def single_instance():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", LOCK_PORT))
        return s
    except OSError:
        return None


def run_cycle(first):
    import telegram_bot
    import news
    import dashboard
    import jev
    # Reload every round so edits to config.json or .env apply without a restart
    importlib.reload(telegram_bot)
    importlib.reload(jev)
    importlib.reload(news)
    importlib.reload(dashboard)

    sent = news.run_once()
    dashboard.main()
    if first:
        webbrowser.open((BASE / "dashboard.html").as_uri())
    return sent, news.CONFIG.get("check_interval_minutes", 20)


def main():
    once = "--once" in sys.argv
    lock = single_instance()
    if lock is None:
        print("The bot is already running in another window. Opening the dashboard only.")
        webbrowser.open((BASE / "dashboard.html").as_uri())
        time.sleep(3)
        return

    print("=" * 56)
    print(" Stock News Bot started")
    print(" The dashboard opens after the first round; close this window to stop")
    print("=" * 56)

    try:
        from telegram_bot import send_message
        send_message("🟢 Stock News Bot started. New items will be posted after each check.")
    except Exception as e:
        print(f"Could not send the Telegram start-up message: {e}")

    first = True
    while True:
        started = datetime.now()
        interval = 20
        print(f"\n[{started:%H:%M:%S}] Checking...")
        try:
            sent, interval = run_cycle(first)
            print(f"[{datetime.now():%H:%M:%S}] Done: sent {sent} messages, dashboard updated")
        except KeyboardInterrupt:
            raise
        except Exception:
            print("This round failed (the next round will retry automatically):")
            traceback.print_exc()
        first = False
        if once:
            break
        next_run = time.time() + interval * 60
        print(f"Next round: {datetime.fromtimestamp(next_run):%H:%M} (every {interval} minutes)")
        while time.time() < next_run:
            time.sleep(5)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
