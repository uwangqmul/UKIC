---
name: umushroom-jev-brief
description: Team UKIC, UMushroom investment competition only. Use when reviewing the hub's news briefs and Jev's probabilities, turning them into BUY/SELL/HOLD suggestions that follow the portfolio rules, or drafting an entry for the team's daily strategy log. Never places orders.
---

# UMushroom competition: news brief, Jev and trade suggestions

## 1. What this skill is for
- Only for the UMushroom investment competition: team UKIC, a separate 100,000 GBP portfolio, from 12 Oct 2026.
  Score is about 50% returns and 50% daily activities. **The daily activities are done by hand by the team, not by you.**
- **Jev** is TypeSafe "System One" (`TYPESAFE_API_KEY` in `news_bot/.env`). It returns probabilities only. It does not
  know our holdings, cash or rules: that part is your job.
- Your job: read the brief, check Jev's probabilities against the headlines, write suggestions that follow the portfolio
  rules (section 6), and draft the strategy-log entry for each change (section 8).
- **You never place orders.** The team places them: from the dashboard (http://127.0.0.1:6400/, "Orders" tab, single
  or batch orders, preview first), or with the Telegram `/trade` menu or `/buy` and `/sell` (allowed users only,
  confirmed). The hub can also order by itself if automatic ordering is switched on (off by default).
- Files (repo folder, called `UKIC_Hub` on the team's PC):
  - `hub/data/briefs/<id>.md` and `.json`: the news per asset, written by each run (`<id>` = `YYYYMMDD-HHMM`, London time)
  - `hub/data/decisions/<id>.json`: Jev's probabilities and the pipeline's suggestions
  - `hub/data/decisions/<id>-claude.json`: your review (the dashboard shows it as engine "claude")
  - `hub/data/assets.json`: group, UMushroom page link and the immediate/delayed keyword rules per asset
  - `news_bot/config.json`: the news settings per asset (keywords, searches, official feeds)
  - `trader/docs/AGENT_GUIDE.md`: the full research (assets, rules, sources, calendar)

## 2. Assets, groups and timing
- 39 assets in 9 groups, all tradable (`hub/data/assets.json`):
  - Chips: NVDA, AMD, INTC, TSM, AVGO
  - Memory & equipment: MU, HY9H (SK hynix), ASML
  - Optical & networking: LITE, GLW, CSCO
  - Servers: DELL, HPE
  - Software & cloud: MSFT, ORCL, IBM, NET, CRWD, PLTR
  - Platforms: AAPL, META, GOOGL, AMZN
  - Mobility & space: UBER, TSLA, SPCX (SpaceX)
  - Defense: GD, NOC, LMT, RTX
  - Hedges: WMT, PG, JNJ, LLY, JPM, XOM, NFLX, GOLD (Amundi Physical Gold ETC), DTLA (iShares $ Treasury Bond 20+yr)
- Order identifiers: for HY9H, ASML, GOLD, DTLA, LITE, NET and META the hub opens the exact UMushroom page
  (`"umushroom"` in `assets.json`); everything else is ordered by ticker. Use GOOGL, never "Alphabet".
  **Never** leveraged or inverse products.
- Two kinds of news (keyword rules in `assets.json`; anything that matches no keyword is "delayed"):
  - **immediate**: moves the price within hours (results, guidance, upgrades/downgrades, M&A, lawsuits, fines, outages,
    export bans, tariffs).
  - **delayed**: shows up over 12-24 hours (contracts, launches, partnerships, regulatory proposals, capacity plans).
- Market hours, London time: US 14:30-21:00 (13:30-20:00 from 25 Oct to 1 Nov 2026), Europe 08:00-16:30.
  An order placed while the market is closed fills at the next open. On 12 Oct the gold, DTLA and SK hynix orders
  showed "Tomorrow" while ASML filled at once: always check the order status. Pending orders cannot be sold.
  The hub has no holiday calendar.
- Results usually come out after the close or before the open, so **reading the news correctly matters more than
  speed**. First reactions can reverse (Cisco: +8% after hours on 12 Aug 2026, -8.9% the next day).

## 3. What Jev receives and answers
- The hub calls Jev once per asset that has news, with **headlines only** (no summaries, sources or links):
  ```
  Company: <name> (ticker <SYMBOL>), sector <group>
  Recent news, newest first:
  - (<age>h ago, <immediate|delayed>, <news|official|contract>) <headline>
  ```
  At most 8 headlines from the last 24 hours. Repeated headlines and passing mentions (Jev relevance below 0.3) are
  removed first. Gold and DTLA appear as "Gold" and "US long-term Treasuries".
- Jev answers **rise / down / flat** probabilities for **the next few hours** and for **the next 12-24 hours**,
  plus a **strength score from 0 to 2**.
- What you must check yourself (the code does not):
  - Headlines that only describe a move that already happened are not new signals.
  - Group-wide news (a chip export ban, a defence budget) affects every asset in that group: apply it to all of them.
- If Jev cannot be reached, the decision file says `"engine": "article-average"` (an average of the per-headline labels
  stored by the news bot). Trust it less and say so.

## 4. When the pipeline runs
- The news bot collects headlines every 20 minutes; the hub turns them into a brief, asks Jev and writes the
  decision file. Both run on the team's Windows PC (started with `start_hub.bat`).
- Schedule (London time, editable in the dashboard Settings):
  - 06:00 morning run: always sent to Telegram.
  - every 30 minutes from 09:00 to 30 minutes before the US close (last run 20:30; 19:30 from 25 Oct to
    1 Nov 2026), weekdays only. Sent to Telegram only when there is at least one BUY or SELL.
  - 00:00 and 03:00: news collection only, no Jev (these also run at weekends).
  - Telegram reminders 5 minutes before the European and US opens.
- Runs missed while the PC was asleep or the hub was closed are skipped, not caught up.
- Manual run: `python hub/pipeline.py manual` (or "Run reasoning now" on the dashboard).
  Send a decision file to Telegram: `python hub/pipeline.py telegram <file>`.
- After each run, if automatic ordering is switched on, the hub may place orders by itself within its limits
  (Jev probability at least 80%, at most 2 orders per run and 6 per day). It is off by default.

## 5. Turning Jev's probabilities into suggestions
- Pipeline rule (dashboard Settings): **BUY** if P(rise) >= 70% and beats P(down) by at least 15 points; **SELL** the
  reverse; otherwise **HOLD**. The stronger of the two horizons wins. Strength is shown but not used.
- Before agreeing with a BUY or SELL, check:
  1. Is the headline really about this asset, and is it new?
  2. Source: "official" (company release) can be acted on. "news" (Google News, Yahoo) must be confirmed by an
     official source or a second outlet first. Never act on social media alone. A feed that returned nothing does
     not mean there was no news.
  3. Timing: immediate news during market hours matters now; anything else is for the next open.
  4. Portfolio fit (section 6): size, group limit, and which position pays for it.
- For each BUY/SELL you keep, write one line: ticker, action, probability, horizon (hours or 12-24h), the headline and
  its source, the main risk, the size in % of the portfolio, and for a BUY what to sell to fund it.
- Save your review to `hub/data/decisions/<id>-claude.json`: same structure as the decision file, `"engine": "claude"`,
  and a one-sentence `why` on each BUY/SELL row. Never edit the pipeline's own decision file.

## 6. Portfolio rules (check every suggestion)
- Opening allocation (12 Oct 2026, fully invested): 80% AI value chain, 20% hedges. The details and reasons are in the
  strategy log (section 8).
- **At most 6% in one asset and 20% in one group.** 1% of the portfolio was about 1,000 GBP at the start
  (about USD 1,300 in Oct 2026).
- **Hedges never below 15%**, normally 20%. On broad bad news (chip export curbs, tariff threats, a market-wide
  sell-off) move towards **about 40%** hedges, trimming chips and mobility first.
- **Never borrow.** UMushroom offers a 10% credit margin: "Cash available to buy" must never go below zero.
  We hold almost no cash, so **every BUY needs a SELL or trim to pay for it**: suggest both together.
- No leveraged or inverse products, ever.

## 7. Order safety (tell the team when it applies)
- "Sent but not confirmed" (⚠, `submitted: "unknown"`, `ORDER_UNCONFIRMED`, also after a timeout): **do not retry**.
  Check the portfolio on UMushroom first. The trader locks that asset; after checking, clear the lock in `trader/`
  with `npm run unlock -- <key>` (the key is shown in the error message; `npm run unlock` lists all locks).
- Orders run one at a time (dashboard, batch, Telegram, automatic): a second order waits.
- Preview before submitting. A batch submit asks for the portfolio name to be typed again.
- To sell a whole position use "all". ETFs (gold, DTLA) are counted in units.
- An ambiguous name is refused: use the symbols from section 2.

## 8. Daily strategy log
- Every step we take is documented in the team's strategy log (shared Google Doc):
  https://docs.google.com/document/d/1gjE9GZbHy7OWNu3dEwcQyO3rNqhgC053tbWeQPNFGKU/edit?usp=sharing
  The team also posts each entry under the portfolio's "Strategy" tab on UMushroom. The portfolio "Description" is a
  fixed text and does not change.
- For every change you suggest, draft the entry in plain text (UMushroom posts cannot show tables) and save the drafts
  to `hub/data/decisions/<id>-log.txt`:
  ```
  Step N (date): short title
  What we did: bought or sold what, how much, at what price.
  Why: the news or event behind it, and its source.
  Effect on the portfolio: new weights of the affected group and the hedges.
  What we are watching next: the next event that could change the decision.
  ```
- A team member adds it to the log and posts it once the order has really been placed.
