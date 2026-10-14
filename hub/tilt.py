"""
Sector tilt: inside each group, move part of the group's weight to the asset Jev rates most likely to rise.

  base weights  the opening allocation (trader/docs/AGENT_GUIDE.md section 3), hub/data/allocation.json; each group's
                total stays the same, only the split inside the group changes
  Jev score     from the latest reasoning run: the average over "next hours" and "12-24h" of (rise - down);
                ties are broken by Jev's news strength, then by the number of news items
  share         settings "tilt_share" (0-1): that share of the other assets' weight moves to the top pick;
                1 = everything to the top pick, 0 = the base allocation
  cap           settings "tilt_cap_pct" (6 = the competition's 6% per asset): weight above the cap goes to the next
                best asset in the group, and so on
  A group whose best score is not above 0 (nothing likely to rise) keeps its base weights.

Only computes target weights. Orders are placed by a person (dashboard batch orders, "Weight %").
"""
from common import DATA, DECISIONS, load_settings, read_json

ALLOCATION_FILE = DATA / "allocation.json"


def _latest_decision():
    files = sorted(DECISIONS.glob("2*.json"))
    for f in reversed(files):
        d = read_json(f, None)
        if d and d.get("rows"):
            return d
    return None


def _score(row):
    probs = row.get("probs") or {}
    vals = [p.get("rise", 0) - p.get("down", 0) for p in probs.values()]
    return round(sum(vals) / len(vals), 3) if vals else 0.0


def compute(share=None, cap=None, decision=None, min_rise=None):
    """decision: a decision dict (default: the latest run). min_rise: the top pick also needs Jev's rise probability
    (best of the two horizons) at least this high, e.g. the automatic orders' minimum probability."""
    s = load_settings()
    share = float(s.get("tilt_share", 0.5) if share is None else share)
    cap = float(s.get("tilt_cap_pct", 6) if cap is None else cap)
    share = min(max(share, 0.0), 1.0)
    alloc = read_json(ALLOCATION_FILE, {}).get("groups", {})
    dec = decision or _latest_decision()
    rows = {r["symbol"]: r for r in (dec or {}).get("rows", [])}
    groups = []
    for group, base in alloc.items():
        assets = []
        for sym, w in base.items():
            r = rows.get(sym, {})
            assets.append({"symbol": sym, "base": float(w), "score": _score(r) if r else None,
                           "action": r.get("action", ""), "strength": r.get("strength", 0), "news": r.get("news", 0)})
        total = sum(a["base"] for a in assets)
        ranked = sorted(assets, key=lambda a: (-(a["score"] if a["score"] is not None else -9), -a["strength"], -a["news"]))
        best = ranked[0] if ranked else None
        rise = max((p.get("rise", 0) for p in (rows.get(best["symbol"], {}).get("probs") or {}).values()), default=0) if best else 0
        too_weak = min_rise is not None and rise < float(min_rise)
        if not best or best["score"] is None or best["score"] <= 0 or share == 0 or too_weak:
            for a in assets:
                a["target"] = a["base"]
            note = ("no asset likely to rise: base weights kept" if best and (best["score"] or 0) <= 0 else
                    f"top pick below the {float(min_rise):.0%} rise probability: base weights kept" if too_weak else "base weights")
            groups.append({"group": group, "total": round(total, 2), "top": None, "note": note, "assets": assets})
            continue
        # move `share` of every other asset's weight to the top pick
        moved = 0.0
        for a in assets:
            a["target"] = a["base"] if a is best else a["base"] * (1 - share)
            if a is not best:
                moved += a["base"] * share
        best["target"] += moved
        # cap: excess goes to the next best asset below the cap
        leftover = 0.0
        if cap > 0:
            for i, a in enumerate(ranked):
                excess = a["target"] - cap
                if excess <= 1e-9:
                    continue
                a["target"] = cap
                for b in ranked[i + 1:]:
                    room = cap - b["target"]
                    if room > 0:
                        add = min(room, excess)
                        b["target"] += add
                        excess -= add
                    if excess <= 1e-9:
                        break
                if excess > 1e-9:  # every asset in the group is at the cap: the rest stays as cash
                    leftover += excess
        for a in assets:
            a["target"] = round(a["target"], 2)
        note = f"{best['symbol']} has the best Jev score ({best['score']:+.2f})"
        if leftover > 0.005:
            note += f"; {leftover:.2f}% left as cash (every asset is at the {cap:g}% cap)"
        groups.append({"group": group, "total": round(total, 2), "top": best["symbol"], "note": note,
                       "cash": round(leftover, 2), "assets": assets})
    return {"decision": dec and dec.get("id"), "london": dec and dec.get("london"), "share": share, "cap": cap,
            "total": round(sum(a["target"] for g in groups for a in g["assets"]), 2), "groups": groups}
