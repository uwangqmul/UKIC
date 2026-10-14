"""
News judgement with Jev (TypeSafe System One): bullish / bearish / neutral + impact.

Requires: pip install typesafe-sdk and TYPESAFE_API_KEY in .env (run setup_jev.bat).
Without a key or the SDK, judgement is skipped and notifications are sent as usual.

Note: this judges the likely direction of a news item's effect on the share price.
It is not a price prediction and not investment advice.
"""
import logging
import os

log = logging.getLogger("news")

try:
    from typesafe_sdk import Choice, Noul, Score, TypeSafeClient
except ImportError:  # SDK not installed
    TypeSafeClient = None

_client = None

LABELS = {"up": "📈 Bullish", "down": "📉 Bearish", "neutral": "➖ Neutral"}
ICONS = {"up": "📈", "down": "📉", "neutral": "➖"}


def enabled():
    return TypeSafeClient is not None and bool(os.getenv("TYPESAFE_API_KEY", "").strip())


def _get_client():
    global _client
    if _client is None:
        _client = TypeSafeClient()
    return _client


def questions(company):
    return {
        "direction": Choice(
            instructions=f"What is the most likely short-term effect of this news on {company}'s stock price?",
            criteria={
                "up": "Positive for the company: beats earnings, raises guidance, wins a contract or big order, "
                      "strong product launch, analyst upgrade, major partnership, buyback",
                "down": "Negative for the company: misses earnings, cuts guidance, lawsuit or fine, analyst downgrade, "
                        "loses a contract, recall, outage, security breach, regulatory or export restrictions",
                "neutral": "Little or no expected price effect: routine announcement, marketing, minor update, "
                           "general market commentary, only mentions the company in passing",
            },
        ),
        "impact": Score(
            instructions=f"How much could this news move {company}'s stock price?",
            criteria=[
                "Routine or minor news that is unlikely to move the stock",
                "Notable news that could move the stock a little",
                "Major news such as an earnings surprise, a very large contract, M&A, or a major regulatory decision",
            ],
        ),
        "relevant": Noul(instructions=f"Is this news mainly about {company} itself?"),
    }


def analyze(company, symbol, title, summary="", source=""):
    """Return {label, prob, impact, relevant}, or None on failure."""
    if not enabled():
        return None
    state = f"Company: {company} (ticker {symbol})\nHeadline: {title}\nSource: {source}"
    if summary:
        state += f"\nSummary: {summary}"
    try:
        r = _get_client().system_one(state, questions(company), timeout=20)
        d, s, n = r.choices["direction"], r.scores["impact"], r.nouls["relevant"]
        return {
            "label": d.choice,
            "prob": float(d.probabilities.get(d.choice, d.confidence)),
            "impact": float(s.score),  # 0 = low ... 2 = high
            "relevant": float(n.noul),
        }
    except Exception as e:
        log.warning("Jev judgement failed (%s): %s", symbol, str(e)[:150])
        return None


def impact_text(score):
    return "Low" if score < 0.67 else ("Med" if score < 1.34 else "High")


def line(j):
    """Judgement line for a single-item notification."""
    if not j or not j.get("label"):
        return ""
    text = f"🤖 Jev: {LABELS.get(j['label'], j['label'])} {j['prob']:.0%} | Impact {impact_text(j['impact'])}"
    if j["relevant"] < 0.4:
        text += " (only mentioned in passing)"
    return text


def badge(j):
    """Short marker after each headline in a digest."""
    if not j or not j.get("label"):
        return ""
    mark = ICONS.get(j["label"], "")
    return f" {mark}{j['prob']:.0%}" + ("❗" if j["impact"] >= 1.34 else "")
