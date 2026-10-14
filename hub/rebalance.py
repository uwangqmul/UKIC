"""
Rebalance plan: what to sell and buy so a portfolio matches target weights (e.g. the sector tilt).

  current   the portfolio's latest journal snapshot (trader/logs/*/latest.json, written by the read-only
            `npm run log -- <portfolio>`): settled holdings with their weights and shares, plus pending orders
  sells     current - target >= min_change: sell that share of the holding (all of it when the target is 0);
            pending orders cannot be sold, so only settled weight counts here
  buys      target - (settled + pending) >= min_change: buy the difference, by weight (UMushroom works out the amount)
  order     sells first, so the buys are paid with cash and never need borrowing

Holdings that are not one of our assets are reported and left alone. Nothing here places orders.
"""
import re
from datetime import datetime, timezone

from common import ASSETS_FILE, NEWS_BOT, TRADER, read_json

SLUG = re.compile(r"/(?:equity|etf)/([^/?#]+)", re.I)
# UMushroom pages of the funds (ordered by ISIN, so assets.json does not hold their page)
FUND_SLUGS = {"amundi-physical-gold-etc-c-2": "GOLD", "ishares-treasury-bond-20-yr-ucits-etf-usd-acc": "DTLA"}


def pct(s):
    m = re.search(r"-?[\d,]*\.?\d+", str(s or ""))
    return float(m.group(0).replace(",", "")) if m else 0.0


def snapshot(portfolio):
    """The newest journal snapshot of a portfolio (by name, case-insensitive), or None."""
    best = None
    for f in (TRADER / "logs").glob("*/latest.json"):
        s = read_json(f, None)
        if s and str(s.get("portfolio", {}).get("name", "")).strip().lower() == portfolio.strip().lower():
            if not best or s.get("takenAt", "") > best.get("takenAt", ""):
                best = s
    return best


def age_hours(snap):
    try:
        taken = datetime.fromisoformat(snap["takenAt"].replace("Z", "+00:00"))
        return round((datetime.now(timezone.utc) - taken).total_seconds() / 3600, 1)
    except Exception:
        return None


def _matcher():
    assets = read_json(ASSETS_FILE, {}).get("assets", {})
    names = {s["symbol"]: s["name"].lower() for s in read_json(NEWS_BOT / "config.json", {}).get("stocks", [])}
    by_slug = dict(FUND_SLUGS)
    for sym, meta in assets.items():
        m = SLUG.search(str(meta.get("umushroom", "")))
        if m:
            by_slug[m.group(1).lower()] = sym

    def symbol_of(row):
        m = SLUG.search(row.get("href", ""))
        slug = m.group(1).lower() if m else ""
        if slug in by_slug:
            return by_slug[slug]
        prefix = slug.split("-")[0].upper()
        if prefix in assets:
            return prefix
        name = str(row.get("name", "")).lower()
        for sym, n in names.items():  # whole-word start: "SK hynix Inc" -> SK hynix, never "Intel" -> "Intelligent"
            if sym in assets and n and re.match(re.escape(n) + r"(?![a-z0-9])", name):
                return sym
        return None
    return symbol_of


def current(snap):
    """{symbol: {"weight", "pending", "shares", "name"}} and the holdings that are not ours."""
    symbol_of = _matcher()
    cur, unknown = {}, []
    for h in snap.get("holdings", []):
        sym = symbol_of(h)
        if not sym:
            unknown.append({"name": h.get("name", ""), "href": h.get("href", ""), "weight": pct(h.get("weight")),
                            "shares": pct(h.get("shares"))})
            continue
        c = cur.setdefault(sym, {"weight": 0.0, "pending": 0.0, "shares": 0.0, "name": h.get("name", "")})
        c["weight"] += pct(h.get("weight"))
        c["shares"] += pct(h.get("shares"))
    for p in snap.get("pending", []):
        sym = symbol_of(p)
        if sym:
            cur.setdefault(sym, {"weight": 0.0, "pending": 0.0, "shares": 0.0, "name": p.get("name", "")})["pending"] += \
                pct(p.get("expectedWeight") or p.get("weight"))
    return cur, unknown


def plan(portfolio, targets, min_change=0.5, no_buy=(), sell_others=True):
    """targets: {symbol: % of the portfolio}. Returns the sells and buys that bring the portfolio to the targets.
    no_buy: symbols never bought (e.g. the ones Jev currently rates SELL); they are listed under "blocked"."""
    snap = snapshot(portfolio)
    if not snap:
        return {"ok": False, "error": f'No holdings snapshot of "{portfolio}" yet: click "Refresh holdings" first.'}
    cur, unknown = current(snap)
    # The snapshot must hold the whole portfolio: if its rows add up to much less than the invested share, the list was
    # cut short (e.g. "See All" not expanded) and a plan would buy everything again
    summary = snap.get("summary", {})
    invested = pct(summary.get("investedShare")) if summary.get("investedShare") else 100 - pct(summary.get("cashShare"))
    read = sum(pct(h.get("weight")) for h in snap.get("holdings", []))
    if invested - read > 2:
        return {"ok": False, "incomplete": True,
                "error": f'The holdings snapshot of "{portfolio}" is incomplete: its rows add up to {read:.1f}% but '
                         f'{invested:.1f}% is invested. Click "Refresh holdings" again; no plan until it reads the whole list.'}
    sells, buys, kept, blocked = [], [], [], []
    for sym in sorted(set(targets) | set(cur)):
        c = cur.get(sym, {"weight": 0.0, "pending": 0.0, "shares": 0.0, "name": ""})
        target = float(targets.get(sym, c["weight"] + c["pending"]))  # not in the targets: leave as it is
        have = c["weight"] + c["pending"]
        row = {"symbol": sym, "name": c["name"], "current": round(c["weight"], 2), "pending": round(c["pending"], 2),
               "target": round(target, 2)}
        if c["weight"] - target >= min_change and c["shares"] > 0:
            cut = c["weight"] - max(target - c["pending"], 0)
            if target <= 0 and c["pending"] <= 0:
                sells.append({**row, "shares": "all", "change": round(-c["weight"], 2)})
            else:
                shares = round(c["shares"] * min(1.0, cut / c["weight"]), 4)
                if shares > 0:
                    sells.append({**row, "shares": f"{shares:g}", "change": round(-cut, 2)})
        elif target - have >= min_change and sym in no_buy:
            blocked.append({**row, "why": "Jev rates it SELL: not bought now"})
        elif target - have >= min_change:
            buys.append({**row, "weight": round(target - have, 2), "change": round(target - have, 2)})
        else:
            kept.append(row)
    # not one of our 40 assets: sell all of it (sell_others), so the portfolio only holds the list
    for u in unknown:
        if sell_others and u["href"].startswith("/en/") and u["shares"] > 0:
            sells.append({"symbol": "https://umushroom.com" + u["href"], "name": u["name"], "current": round(u["weight"], 2),
                          "pending": 0.0, "target": 0.0, "shares": "all", "change": round(-u["weight"], 2), "other": True})
    sells.sort(key=lambda r: r["change"])
    buys.sort(key=lambda r: -r["change"])
    return {"ok": True, "portfolio": portfolio, "snapshot_at": snap.get("takenAt"), "age_hours": age_hours(snap),
            "value": snap.get("summary", {}).get("currentValue"), "cash": snap.get("summary", {}).get("cashShare"),
            "sells": sells, "buys": buys, "kept": kept, "blocked": blocked, "unknown": [u["name"] for u in unknown],
            "min_change": min_change}


def by_sector(p, groups):
    """Order the plan sector by sector: in each sector its sells first, then its buys, then the next sector
    (the sectors that change most go first). groups: tilt.compute()["groups"]. Returns [("SELL"|"BUY", row, group)].
    Selling inside a sector frees about what that sector then buys, so every sector gets its buys done."""
    sector = {a["symbol"]: g["group"] for g in groups for a in g["assets"]}
    names = [g["group"] for g in groups] + ["Other"]
    steps = {n: [] for n in names}
    for side, rows in (("SELL", p["sells"]), ("BUY", p["buys"])):
        for r in rows:
            steps[sector.get(r["symbol"], "Other")].append((side, r))
    size = lambda n: sum(abs(r["change"]) for _, r in steps[n])
    # holdings that are not on the list are sold first (that frees cash for everything else)
    order = ["Other"] + sorted((n for n in names if n != "Other"), key=lambda n: -size(n))
    return [(side, r, n if n != "Other" else "Not on the list") for n in order for side, r in steps[n]]


def plan_lines(p, groups=None):
    """The plan as batch-order lines (sector by sector, each sector's sells before its buys)."""
    steps = by_sector(p, groups) if groups else [("SELL", r, "") for r in p["sells"]] + [("BUY", r, "") for r in p["buys"]]
    return [f"sell {r['symbol']}, {r['shares']}" + ("" if r["shares"] == "all" else " shares") if side == "SELL"
            else f"{r['symbol']}, {r['weight']}%" for side, r, _ in steps]
