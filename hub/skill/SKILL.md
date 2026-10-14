---
name: umushroom-jev-brief
description: UKIC team, UMushroom investment competition only. Use when reviewing the hub's news briefs and Jev's probabilities, turning them into BUY/SELL/HOLD suggestions that respect the portfolio rules, or drafting an entry for the team's daily strategy log. Never places orders.
---

# UMushroom competition: news brief, Jev and trade suggestions

## 1. What this skill is for
- Only for the UMushroom investment competition: team UKIC, a separate **100,000 GBP** portfolio, from **12 Oct 2026**.
  Score is about 50% returns and 50% daily activities. **The daily activities are done by hand by the team, not by you.**
  Returns are only half the score: steady, explained trades beat wild bets.
- Your job: read the brief, check Jev's probabilities against the headlines, write suggestions that fit the portfolio rules
  (section 6), and draft the strategy-log entry for any change (section 8).
- **Jev** is not a person: it is TypeSafe "System One" (`TYPESAFE_API_KEY` in `news_bot/.env`). It returns probabilities
  only. It does not know our holdings, cash or rules. That part is your job.
- **You never place orders.** Orders are placed by the team: from the dashboard (http://127.0.0.1:6400/, "Orders" tab,
  preview first, then submit) or with the Telegram `/buy` and `/sell` commands (allow-listed users, confirmed with "yes").
  The hub can also order by itself (`auto_mode`), which is **off** unless the team switched it on in the Orders tab.
- Files (repo folder, called `UKIC_Hub` on the team's PC):
  - `hub/data/briefs/<id>.md` and `.json`: the news per asset, written by each run (`<id>` = `YYYYMMDD-HHMM`, London time)
  - `hub/data/decisions/<id>.json`: Jev's probabilities and the pipeline's suggestions
  - `hub/data/decisions/<id>-claude.json`: your review (the dashboard shows it as engine "claude")
  - `hub/data/assets.json`: group, trade flag, UMushroom identifier and the immediate/delayed keyword rules
  - `news_bot/config.json`: the news searches and official feeds per asset (a new asset needs an entry in both files)
  - `trader/docs/AGENT_GUIDE.md` and `trader/docs/news-sources.json`: the full research (assets, rules, sources, calendar)

## 2. Assets, groups and timing
- 40 assets in 9 groups. Trade only those with `"trade": true` in `hub/data/assets.json`.
  - Chips: NVDA, AMD, INTC, TSM, AVGO
  - Memory & equipment: MU, SKHY (SK hynix), ASML, SNDK (SanDisk)
  - Optical & networking: LITE, GLW, CSCO
  - Servers: DELL, HPE
  - Software & cloud: MSFT, ORCL, IBM, NET, CRWD, PLTR
  - Platforms: AAPL, META, GOOGL, AMZN
  - Mobility & space: UBER, TSLA, SPCX (SpaceX)
  - Defense: GD, NOC, LMT, RTX
  - Hedges: WMT, PG, JNJ, LLY, JPM, XOM, NFLX, GOLD (Amundi Physical Gold ETC), DTLA (iShares $ Treasury Bond 20+yr)
- **SanDisk is watch-only:** it is not on UMushroom (only a 3x leveraged product, which we never buy). Use its news as a
  signal for MU and SK hynix.
- What to type on UMushroom (`assets.json` "umushroom"; the hub converts it automatically):
  GOLD = ISIN `FR0013416716` (the ticker GOLD is shared by two products), DTLA = `IE00BFM6TC58`,
  ASML = `NL0010273215` (Amsterdam, EUR). Use `GOOGL`, never "Alphabet" (two share classes, refused as ambiguous).
  SK hynix: the team holds the EUR listing; order it by its page address.
- Two kinds of news (keyword rules in `assets.json`, matched at the start of words; anything else is "delayed"):
  - **immediate**: moves the price within hours (results, guidance, upgrades/downgrades, M&A, lawsuits, fines, outages, export bans, tariffs).
  - **delayed**: shows up over 12-24 hours (contracts, launches, partnerships, regulatory proposals, capacity plans).
- Market hours, London time: US 14:30-21:00 (13:30-20:00 from 25 Oct to 1 Nov 2026), Europe 08:00-16:30.
  An order placed while the market is closed fills at the next open: overnight suggestions are for the next open.
  Orders for the European listings (gold, DTLA, ASML, SK hynix) often show "Tomorrow" on UMushroom.
  Pending orders cannot be sold until they fill. The hub has no holiday calendar.
- Results usually come out after the close or before the open, so **reading the news correctly matters more than speed**.
  First after-hours reactions can reverse (Cisco: +8% after hours on 12 Aug 2026, -8.9% the next day).

## 3. What Jev receives and answers
- One call per asset that has news (`hub/pipeline.py`, `jev_asset`). Jev sees only headlines, not summaries or links:
  ```
  Company: <name> (ticker <SYMBOL>), sector <group>
  Recent news, newest first:
  - (<age>h ago, <immediate|delayed>, <news|official|contract>) <headline>
  ```
  At most 8 headlines from the last 24 hours. Items Jev judged as only mentioning the company in passing (relevance
  below 0.3) and repeated headlines are removed first.
- Questions: "rise" / "down" / "flat" for **the next few hours** (`hours`) and for **the next 12-24 hours** (`day`),
  plus a strength score from 0 to 2.
- If Jev cannot be reached, the decision file says `"engine": "article-average"`: an average of the per-headline labels
  stored by the news bot. Trust it less and say so in your review.
- Sector news is **not** copied to the other assets by the code. If a headline affects a whole group (a chip export ban,
  a defence budget), apply it to every asset in that group yourself.

## 4. When it runs
- The hub runs `python hub/pipeline.py <kind>` on its own schedule (London time):
  - 06:00 morning run, sent to Telegram
  - every 30 minutes from 09:00 to 30 minutes before the US close (last run 20:30; 19:30 from 25 Oct to 1 Nov), weekdays.
    Sent to Telegram only when there is at least one BUY or SELL.
  - 00:00 and 03:00: news collection only, no Jev
  - Telegram reminders 5 minutes before the European and US opens
- Manual run: `python hub/pipeline.py manual`. Send a decision file to Telegram: `python hub/pipeline.py telegram <file>`.

## 5. Turning Jev's probabilities into suggestions
- Pipeline rule (editable in the dashboard Settings): **BUY** if P(rise) >= 60% and beats P(down) by at least 15 points,
  **SELL** the reverse, otherwise **HOLD**; the stronger of the two horizons wins. Strength is shown but not used.
- Before agreeing with a BUY or SELL, check:
  1. Is the headline really about this asset, and is it new? A headline that describes a move that already happened is not a signal.
  2. Source: `official` (company release, filing) can be acted on. `news` (Google News, Yahoo) must be confirmed by an
     official source or a second outlet first. Never act on social media posts alone. A feed that returned nothing does
     not mean there was no news.
  3. Timing: immediate news during market hours matters now; anything else is for the next open.
  4. Portfolio fit (section 6): size, group limit, and what we sell to pay for it.
- For each BUY/SELL you keep, write one line: ticker, action, probability, horizon (hours or 12-24h), the headline and its
  source, the main risk, the suggested size in % of the portfolio, and what to sell to fund it (for a BUY).
- Write your review to `hub/data/decisions/<id>-claude.json` (same structure as the decision file, `engine` = "claude",
  a one-sentence `why` on each BUY/SELL row). Never edit the pipeline's own decision file.

## 6. Portfolio rules (check every suggestion against these)
- The opening allocation (12 Oct 2026) is in the strategy log (section 8): 80% AI value chain, 20% hedges, no cash.
- **At most 6% in one asset and 20% in one group.** 1% of the portfolio is about 1,000 GBP (about USD 1,300 in Oct 2026).
- **Hedges never below 15%**; normally 20%. On broad bad news (chip export curbs, tariff threats, a market-wide
  sell-off) move towards **about 40%** hedges, trimming chips and mobility first.
- **Never borrow.** UMushroom offers a 10% credit margin: "Cash available to buy" must never go below zero.
  We keep almost no cash, so **every BUY needs a SELL or trim** to pay for it. Suggest both together.
- No leveraged or inverse products, ever.
- The Telegram and auto-order default size is set in dashboard Settings (`tg_default_amount_usd`, `auto_amount_usd`);
  keep it at or below one position size (about 3%).

## 7. Order safety (for the team; tell them when it applies)
- If an order comes back "sent but not confirmed" (`submitted: "unknown"`, `ORDER_UNCONFIRMED`): **do not retry**.
  Check the UMushroom portfolio. The trader locks that asset until someone runs `npm run unlock -- <key>` in `trader/`
  after checking.
- To sell a whole position use "all". ETFs are counted in units.

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
