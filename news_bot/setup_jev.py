"""
One-step Jev setup: paste your TypeSafe API key -> test call -> save to .env
Get a key at https://console.typesafe.ai/
"""
import os
import sys

from setup_telegram import read_env, write_env


def main():
    try:
        from typesafe_sdk import Choice, TypeSafeClient
    except ImportError:
        sys.exit("typesafe-sdk is not installed (it needs Python 3.10 or newer).")

    env = read_env()
    key = env.get("TYPESAFE_API_KEY", "")
    while True:
        if not key:
            print("\nPaste your TypeSafe API key (right-click in this window to paste), then press Enter:")
            key = input("> ").strip()
        os.environ["TYPESAFE_API_KEY"] = key
        try:
            r = TypeSafeClient().system_one(
                "Company: Lockheed Martin (ticker LMT)\nHeadline: Lockheed Martin awarded $2 billion Army missile contract",
                {"direction": Choice(
                    instructions="What is the most likely short-term effect of this news on the stock price?",
                    criteria={"up": "Positive", "down": "Negative", "neutral": "No effect"})},
                timeout=30,
            )
            d = r.choices["direction"]
            print(f"\n✓ Key is valid. Model: {r.model}")
            print(f"  Test headline: Lockheed Martin awarded $2B Army missile contract -> "
                  f"{d.choice} ({d.probabilities.get(d.choice, 0):.0%})")
            break
        except Exception as e:
            print(f"✗ Call failed: {str(e)[:200]}")
            key = ""

    env["TYPESAFE_API_KEY"] = key
    write_env(env)
    print("\n✓ Saved to .env. Every notification will now include a Jev judgement.")


if __name__ == "__main__":
    main()
