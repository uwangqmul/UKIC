---
name: umushroom-jev-brief
description: For the UMushroom investment competition only. Read the latest news brief for our chosen assets, reason about short-term price moves with Jev's probabilities, and write BUY/SELL/HOLD suggestions that we place by hand.
---

# UMushroom competition: news brief for Jev

## 1. What this skill is for and how to use it
- Use it only for the UMushroom investment competition (paper portfolio, team of You Wang and Nick).
- Its job is to extract and prepare information for Jev's reasoning, then turn Jev's probabilities into suggestions.
- Orders are placed by hand from the dashboard (http://127.0.0.1:6400/, "Orders" tab). Never place orders yourself.
- Everything lives in the `UKIC_Hub` folder:
  - `hub/data/briefs/<id>.md` and `.json`: the latest news per asset (written by the pipeline)
  - `hub/data/decisions/<id>.json`: Jev's probabilities and the pipeline's suggestions
  - `hub/data/assets.json`: which assets we trade, their sectors, and the immediate/delayed keyword rules

## 2. Assets, sectors and timing
- Trade only assets with `"trade": true` in `hub/data/assets.json` (31 tech, semiconductor and defence names; SpaceX and the Fidelity ETF are watch-only).
- Sectors: Semiconductors, Optical & components, Hardware, Cloud & software, Internet & platforms, Defence & space.
- Separate two kinds of news:
  - **immediate**: moves the price within hours (earnings, guidance, upgrades/downgrades, M&A, lawsuits, outages, export bans).
  - **delayed**: shows up after 12-24 hours (contracts, product launches, partnerships, regulatory proposals, capacity plans).
- An order placed overnight is only filled when the market opens, so overnight suggestions are for the next open.

## 3. Reasoning and the format given to Jev
- Per asset, give Jev a short state: company, ticker, sector, then up to 8 headlines, newest first, each as
  `- (<hours> ago, <immediate|delayed>, <news|official|contract>) <headline>`.
- Ask Jev only keyword questions so it stays cheap: "price rise" / "price down" / "no clear move",
  once for the next few hours and once for the next 12-24 hours, plus a 0-2 strength score.
- Ignore items that only mention the company in passing, and headlines that just describe a move that already happened.
- Sector news (e.g. a chip export ban) affects every asset in that sector: mention it under each one.

## 4. Feed Jev automatically
- `python hub/pipeline.py intraday` builds the brief, asks Jev and writes the decision file.
- The hub's schedule does this by itself (London time): 06:00 morning run, every 30 min from 09:00 to 30 min before the US close, night runs that only collect news.

## 5. Get Jev's reasoning and apply it
- Suggestion rules (editable in Settings): BUY if P(price rise) >= 60% and beats P(price down) by 15 points; SELL the reverse; otherwise HOLD.
- For each BUY/SELL, write one line: ticker, action, probability, horizon (next hours or 12-24h), the headline that drives it, and the main risk.
- Send the summary to Telegram; we read it and place orders by hand on UMushroom.
