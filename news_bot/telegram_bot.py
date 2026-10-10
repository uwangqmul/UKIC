"""
Telegram sending module.

Usage:
  python telegram_bot.py chatid   # show Chat IDs (send /start to the bot in Telegram first)
  python telegram_bot.py test     # send a test message
"""
import os
import sys
import time

import requests
from dotenv import load_dotenv

load_dotenv(override=True)

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
API = f"https://api.telegram.org/bot{TOKEN}"


def _require_token():
    if not TOKEN:
        sys.exit("TELEGRAM_BOT_TOKEN is missing: run setup_telegram.bat (or copy .env.example to .env and fill it in)")


def get_chat_ids():
    """Read the bot's recent updates and return {chat_id: name}."""
    _require_token()
    r = requests.get(f"{API}/getUpdates", timeout=20)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"getUpdates failed: {data.get('description')}")
    chats = {}
    for update in data["result"]:
        msg = update.get("message") or update.get("channel_post") or {}
        chat = msg.get("chat")
        if chat:
            chats[chat["id"]] = (
                chat.get("username") or chat.get("title") or chat.get("first_name") or ""
            )
    return chats


def send_message(text, chat_id=None, retries=3, html=False, preview=True):
    """Send one message; network errors and Telegram rate limits are retried automatically."""
    _require_token()
    chat_id = chat_id or CHAT_ID
    if not chat_id:
        raise ValueError("TELEGRAM_CHAT_ID is missing: run setup_telegram.bat first")

    payload = {"chat_id": chat_id, "text": text}
    if html:
        payload["parse_mode"] = "HTML"
    if not preview:
        payload["link_preview_options"] = {"is_disabled": True}

    for attempt in range(1, retries + 1):
        try:
            r = requests.post(f"{API}/sendMessage", json=payload, timeout=20)
            data = r.json()
            if data.get("ok"):
                return data["result"]
            if r.status_code == 429:  # rate limited: wait as long as Telegram asks
                wait = data.get("parameters", {}).get("retry_after", 5)
                time.sleep(wait)
                continue
            if 400 <= r.status_code < 500:  # wrong token, wrong chat ID, etc. - retrying will not help
                raise RuntimeError(f"Telegram rejected the request: {data.get('description')}")
        except requests.RequestException:
            if attempt == retries:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("Send failed after all retries")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "test"
    if cmd == "chatid":
        chats = get_chat_ids()
        if not chats:
            print("No messages found. Open your bot in Telegram, send /start, then run this again.")
        for cid, name in chats.items():
            print(f"Chat ID: {cid}   ({name})")
    else:
        send_message("✅ Stock alert test message")
        print("Sent. Check Telegram.")
