"""
Calls the trader (Node, UMushroom) from Python: `npm run trade -- <buy|sell> <company> ...` inside trader/.
Used by the dashboard's Orders tab, batch.py, tg_commands.py and autotrade.py.
"""
import os
import re
import subprocess
import sys
import threading

from common import ASSETS_FILE, TRADER, log, read_json

NAME_RE = re.compile(r"^[\w .&'-]{1,60}$")
NPM = "npm.cmd" if sys.platform == "win32" else "npm"
# An exact UMushroom security page; the trader opens it directly instead of searching
PAGE_RE = re.compile(r"^https://umushroom\.com/en/(equity|etf)/[a-z0-9][a-z0-9._-]{0,80}$")
# One order at a time: the dashboard, batch orders, Telegram and automatic orders all drive the same project Chrome
_one_at_a_time = threading.Lock()


def page_for(company):
    """A ticker that matches several securities on UMushroom (e.g. NET: Cloudflare and Netcall) is replaced by the
    exact page set as "umushroom" for it in hub/data/assets.json; anything else is returned unchanged."""
    page = read_json(ASSETS_FILE, {}).get("assets", {}).get(company.upper(), {}).get("umushroom", "")
    return page if PAGE_RE.match(page) else company


def trade(action, company, portfolio="", shares="", amount="", submit=False, headless=False):
    """Returns {ok, submitted, output}. submitted: True / False / "unknown" (sent but not confirmed: trader locks the stock)."""
    company, portfolio = str(company).strip(), str(portfolio).strip()
    shares, amount = str(shares or "").strip(), str(amount or "").strip()
    company = page_for(company)
    if action not in ("buy", "sell") or not (NAME_RE.match(company) or PAGE_RE.match(company)):
        return {"ok": False, "submitted": False, "output": "Invalid action or company"}
    args = [NPM, "run", "trade", "--", action, company]
    if portfolio:
        if not NAME_RE.match(portfolio):
            return {"ok": False, "submitted": False, "output": "Invalid portfolio name"}
        args += ["--portfolio", portfolio]
    if shares:
        if not (re.fullmatch(r"\d+(\.\d+)?", shares) or (shares == "all" and action == "sell")):
            return {"ok": False, "submitted": False, "output": "Invalid shares"}
        args += ["--shares", shares]
    elif amount:
        if not re.fullmatch(r"\d+(\.\d+)?", amount):
            return {"ok": False, "submitted": False, "output": "Invalid amount"}
        args += ["--amount", amount]
    else:
        return {"ok": False, "submitted": False, "output": "Give shares or amount"}
    if submit is True:
        args.append("--submit")
    env = dict(os.environ)
    if headless:
        env["MCP_HEADLESS"] = "true"
    log.info("Trade: %s", " ".join(args[4:]))
    try:
        with _one_at_a_time:
            p = subprocess.run(args, cwd=TRADER, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=240, env=env)
    except subprocess.TimeoutExpired as e:
        # The order may already have been sent when the time ran out: never report it as "not submitted"
        out = "\n".join(x if isinstance(x, str) else (x or b"").decode("utf-8", "replace") for x in (e.stdout, e.stderr))
        log.warning("Trade timed out after 240 s (submit %s)", submit is True)
        return {"ok": False, "submitted": "unknown" if submit is True else False,
                "output": (out.strip() + "\nTimed out after 240 s. Check UMushroom before trying again.").strip()[-6000:]}
    except Exception as e:
        return {"ok": False, "submitted": False, "output": str(e)}
    out = (p.stdout + "\n" + p.stderr).strip()
    if re.search(r'"submitted":\s*"unknown"', out):
        submitted = "unknown"
    elif re.search(r'"submitted":\s*true', out):
        submitted = True
    else:
        submitted = False
    log.info("Trade finished (exit %s, submitted %s)", p.returncode, submitted)
    return {"ok": p.returncode == 0, "submitted": submitted, "output": out[-6000:]}


def holdings(portfolio):
    """Tickers held in a portfolio according to the trader's latest journal snapshot (None if no journal)."""
    for latest in (TRADER / "logs").glob("*/latest.json"):
        snap = read_json(latest, {})
        if snap.get("portfolio", {}).get("name", "").strip().lower() == portfolio.strip().lower():
            held = set()
            for h in snap.get("holdings", []):
                m = re.search(r"/equity/([a-z0-9.]+)-", h.get("href", ""))
                if m:
                    held.add(m.group(1).upper())
            return {"tickers": held, "taken_at": snap.get("takenAt", "")}
    return None
