"""
One-step Telegram setup:
  1. Paste your Bot Token and verify it
  2. Send /start to the bot; the Chat ID is detected automatically
  3. Save to .env and send a test message
"""
import os
import sys
import time
from pathlib import Path

import requests

ENV_PATH = Path(__file__).with_name(".env")


def read_env():
    values = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip()
    return values


def write_env(values):
    lines = ["# This file holds credentials. Do not upload it or share it with anyone."]
    lines += [f"{k}={v}" for k, v in values.items()]
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def api(token, method, **params):
    r = requests.post(f"https://api.telegram.org/bot{token}/{method}", json=params, timeout=40)
    return r.json()


def main():
    env = read_env()
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    configured_before = bool(token and env.get("TELEGRAM_CHAT_ID"))

    # 1. Token
    while True:
        if not token:
            print("\nPaste the Bot Token from BotFather (right-click in this window to paste), then press Enter:")
            token = input("> ").strip()
        try:
            me = api(token, "getMe")
        except requests.RequestException as e:
            print(f"\nCannot reach Telegram: {e}\nCheck that api.telegram.org is reachable and try again.")
            sys.exit(1)
        if me.get("ok"):
            bot = me["result"]
            print(f"\n✓ Token is valid. Bot: @{bot['username']}")
            break
        print("✗ Invalid token, please paste it again.")
        token = ""

    env["TELEGRAM_BOT_TOKEN"] = token
    write_env(env)

    # 2. Chat ID
    chat_id = env.get("TELEGRAM_CHAT_ID", "")
    if not chat_id:
        api(token, "deleteWebhook")
        print(f"\nNow open https://t.me/{bot['username']} in Telegram and tap Start (or send /start)")
        print("Waiting (up to 3 minutes)...")
        deadline = time.time() + 180
        while time.time() < deadline and not chat_id:
            data = api(token, "getUpdates", timeout=25)
            for upd in data.get("result", []):
                msg = upd.get("message") or {}
                if msg.get("chat", {}).get("type") == "private":
                    chat_id = str(msg["chat"]["id"])
                    print(f"✓ Got a message from {msg['chat'].get('first_name', '')}. Chat ID: {chat_id}")
        if not chat_id:
            print("✗ No message received within 3 minutes. Please run this again.")
            sys.exit(1)
        env["TELEGRAM_CHAT_ID"] = chat_id
        write_env(env)

    # 3. Test message (--quiet: skip it if already configured)
    if "--quiet" in sys.argv and configured_before:
        return
    res = api(token, "sendMessage", chat_id=chat_id, text="✅ Stock alert test message")
    if res.get("ok"):
        print("\n✓ Test message sent. Check Telegram. Setup complete!")
    else:
        print(f"\n✗ Send failed: {res.get('description')}")
        sys.exit(1)


if __name__ == "__main__":
    main()
