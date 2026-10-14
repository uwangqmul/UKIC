"""
Send notifications to the Telegram group the bot is in:
find the group the bot was added to -> save it as TELEGRAM_CHAT_ID in .env -> post a test message.
(The previous private chat ID is kept as TELEGRAM_PRIVATE_CHAT_ID; copy it back to switch to private chat.)
"""
import sys

import requests

from setup_telegram import api, read_env, write_env


def main():
    env = read_env()
    token = env.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        sys.exit("No Bot Token configured yet. Run setup_telegram.bat first.")

    groups = {}
    for upd in api(token, "getUpdates", allowed_updates=["message", "my_chat_member"]).get("result", []):
        for key in ("my_chat_member", "message"):
            chat = (upd.get(key) or {}).get("chat") or {}
            if chat.get("type") in ("group", "supergroup"):
                groups[chat["id"]] = chat.get("title", "")

    if not groups:
        sys.exit("No group found. Add the bot to a group, send /start@<bot username> in the group, then run this again.")

    print("Groups the bot is in:")
    for cid, title in groups.items():
        print(f"  {title} ({cid})")
    chat_id, title = list(groups.items())[-1]  # the most recently joined group
    if len(groups) > 1:
        print(f"More than one group found; using the most recent: {title}")

    res = api(token, "sendMessage", chat_id=chat_id,
              text="✅ Stock Alert is now connected to this group. Stock news and Jev judgements will be posted here.")
    if not res.get("ok"):
        sys.exit(f"Could not post to the group: {res.get('description')}")

    if env.get("TELEGRAM_CHAT_ID") and "TELEGRAM_PRIVATE_CHAT_ID" not in env:
        env["TELEGRAM_PRIVATE_CHAT_ID"] = env["TELEGRAM_CHAT_ID"]
    env["TELEGRAM_CHAT_ID"] = str(chat_id)
    write_env(env)
    print(f"\n✓ Notifications now go to the group: {title}. Restart start_stock_bot.bat to apply.")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        sys.exit(f"Cannot reach Telegram: {e}")
