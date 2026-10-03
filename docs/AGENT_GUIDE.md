# UKIC agent guide: assets, news sources and trading rules

This guide is written for the trading agent (and for whoever sets it up). It sums up what was decided and built before the
competition, so the agent can read one file and know **what it may trade, where its news comes from, and which rules to follow**.
Everything here was researched and checked on **2 Oct 2026**.

Related files:

| File | What it is |
|---|---|
| `docs/news-sources.json` | Machine-readable list of the 40 assets: UMushroom identifier, SEC CIK, newswire, feeds, what news to expect. Plus the shared sources. **Read this file for data**; this guide explains it. |
| `docs/news-sources.pdf` | The same research as a readable document, with dated past examples for every source. |
| `scripts/check-feeds.js` (`npm run check-feeds`) | Fetches every source once and reports which ones work from this machine. |
| `README.md` | How the order tools work (buy/sell, previews, order locks, unlock). |

---

## 1. Competition facts

- **Practice:** 5–11 Oct 2026. The agent watches the news and records what it *would* have done. **Competition:** from **12 Oct 2026**.
- **Portfolio:** a **separate portfolio with 100,000 GBP**. The base currency is GBP; most assets are priced in USD, so the GBP/USD rate also moves the value.
- **Scoring:** about **50% returns** and **50% completing daily activities**. The **daily activities are done manually by the team, not by the agent**: the agent only manages the portfolio. Since returns are only half the score, steady, deliberate trades beat wild bets.
- **Order timing:** an order placed while the market is closed waits and **fills at the next open**. Most scheduled news (results) comes out after the close or before the open, so for those **interpreting the news correctly matters more than speed**. Seconds matter only for news during trading hours (policy, scoops, outages).
- **Reactions can reverse.** For example, Cisco rose 8% after hours on 12 Aug 2026 and closed **−8.9%** the next day. Do not chase the first after-hours move.

## 2. The 40 assets

Order stocks by **ticker**. Order the two funds by **ISIN** (two different gold products share the ticker `GOLD`). Use **GOOGL**,
never "Alphabet" (the order code refuses it as ambiguous: there are two share classes).

| Group | Asset | Order with | SEC CIK |
|---|---|---|---|
| Chips | NVIDIA | `NVDA` | 1045810 |
| Chips | AMD | `AMD` | 2488 |
| Chips | Intel | `INTC` | 50863 |
| Chips | Taiwan Semiconductor (ADR) | `TSM` | 1046179 |
| Chips | Broadcom | `AVGO` | 1730168 |
| Memory & equipment | Micron | `MU` | 723125 |
| Memory & equipment | SanDisk | `SNDK` | 2023554 |
| Memory & equipment | SK Hynix | listed as Equity on UMushroom (check the ticker it shows; US ADR is SKHY) | 2120882 |
| Memory & equipment | ASML | `ASML` | 937966 |
| Optical & networking | Lumentum | `LITE` | 1633978 |
| Optical & networking | Corning | `GLW` | 24741 |
| Optical & networking | Cisco | `CSCO` | 858877 |
| Servers | Dell | `DELL` | 1571996 |
| Servers | Hewlett Packard Enterprise | `HPE` | 1645590 |
| Software & cloud | Microsoft | `MSFT` | 789019 |
| Software & cloud | Oracle | `ORCL` | 1341439 |
| Software & cloud | IBM | `IBM` | 51143 |
| Software & cloud | Cloudflare | `NET` | 1477333 |
| Software & cloud | CrowdStrike | `CRWD` | 1535527 |
| Software & cloud | Palantir | `PLTR` | 1321655 |
| Platforms | Apple | `AAPL` | 320193 |
| Platforms | Meta | `META` | 1326801 |
| Platforms | Alphabet Class A | `GOOGL` | 1652044 |
| Platforms | Amazon | `AMZN` | 1018724 |
| Mobility & space | Uber | `UBER` | 1543151 |
| Mobility & space | Tesla | `TSLA` | 1318605 |
| Mobility & space | SpaceX | `SPCX` | 1181412 |
| Defense | General Dynamics | `GD` | 40533 |
| Defense | Northrop Grumman | `NOC` | 1133421 |
| Defense | Lockheed Martin | `LMT` | 936468 |
| Defense | RTX | `RTX` | 101829 |
| Hedge | Walmart | `WMT` | 104169 |
| Hedge | Procter & Gamble | `PG` | 80424 |
| Hedge | Johnson & Johnson | `JNJ` | 200406 |
| Hedge | Eli Lilly | `LLY` | 59478 |
| Hedge | JPMorgan Chase | `JPM` | 19617 |
| Hedge | Exxon Mobil | `XOM` | **2115436** (new since 1 Jul 2026; the old 34088 no longer has the stock's filings) |
| Hedge | Netflix | `NFLX` | 1065280 |
| Hedge | Amundi Physical Gold ETC C (ETF page `/en/etf/amundi-physical-gold-etc-c-2`) | `FR0013416716` | none (fund) |
| Hedge | iShares $ Treasury Bond 20+yr UCITS ETF USD (Acc), "DTLA" | `IE00BFM6TC58` | none (fund) |

CIKs come from the SEC's official ticker list (`sec.gov/files/company_tickers.json`, 2 Oct 2026).

**Removed** from the first draft: Coherent, Atlassian, MongoDB (overlapping), Samsung (still watched as a **news signal only**: its
results move MU and SK Hynix) and a Fidelity fund.

**Never buy** the leveraged or options products that appear in the same searches ("Leverage Shares 3x Long/Short …",
"IncomeShares … Options ETP"). They are not the asset and lose value over time.

## 3. Portfolio rules

1. **Hedges + cash ≥ 15–20%** of the portfolio at all times. The hedges are the last 9 rows above (WMT, PG, JNJ, LLY, JPM, XOM, NFLX, gold, Treasuries).
2. **Risk-off:** on broad bad news (US export curbs on chips, tariff threats, a market-wide sell-off) move towards **~40%** hedges + cash.
3. **Concentration:** at most **25% in one group** and **8–10% in one asset**. The 27 tech names move together on AI news; treat them as one big risk.
4. **Never borrow.** UMushroom offers a 10% credit margin: "Cash available to buy" must **never go below zero**.
5. What each hedge protects against:
   - AI or tech sell-off: WMT, PG, JNJ (people keep buying groceries and medicine).
   - Market panic: gold and long Treasuries (usually rise when stocks crash). **Exception:** in an inflation shock (as in 2022) bonds fall together with stocks.
   - Rising interest rates: JPM. Oil spikes and wars: XOM (and the defense names).
   - LLY and NFLX move on their own business, not on AI spending.

## 4. Placing orders safely (what the code does)

- `company` can be a ticker, an exact company name, an **ISIN**, or a UMushroom page address (`/en/equity/...` for stocks, `/en/etf/...` for ETFs). **Funds (type "Fund") cannot be traded**, only Equity and ETF.
- Anything ambiguous is **refused** with a list of candidates instead of guessed: pick the right ticker/ISIN from that list.
- The order form must show the chosen instrument, or nothing is submitted.
- Always **preview first**, then submit.
- **`ORDER_UNCONFIRMED` means the order MAY have been placed. Never retry it.** That stock (or ETF, key `etf:<slug>`) is locked until a human checks Pending Orders / History on UMushroom and runs `npm run unlock -- <key>`. Other assets are not affected.
- Sell: `shares: "all"` sells what is available. ETFs are counted in "units"; the code handles that.

## 5. News sources: how to use them

### Tiers (in `news-sources.json`)
- **Tier 1, official** (the company, a regulator, a court): can be acted on.
- **Tier 2, reputable aggregator** (Alpaca/Benzinga, TrendForce, live prices): act, then confirm with tier 1.
- **Tier 3, unconfirmed** (Truth Social copies, posts on X): **never trade on tier 3 alone**; wait for tier 1 or 2.

### Where news comes from, fastest first
1. **Alpaca news stream (Benzinga)**, `wss://stream.data.alpaca.markets/v1beta1/news`: the main live feed, tagged by ticker, usually seconds after release. Needs a free Alpaca account. It has been known to miss some company press releases, so also read 2 and 3.
2. **Company feeds** (`assets[].feeds`): the press release itself. Every RSS feed listed returned 200 on 2 Oct, **except** that `investor.nvidia.com` refused this machine later (NVIDIA's newsroom feed carries the same releases).
3. **SEC filings** for every stock: `https://data.sec.gov/submissions/CIK{10-digit CIK}.json`. 8-K items: 2.02 results, 1.01 major agreements, 5.02 executive changes, 1.05 cyber incidents; foreign companies (TSM, ASML, SK Hynix) file 6-K. The SEC requires a User-Agent with a contact e-mail and at most 10 requests per second. JPM files dozens of other documents a day: keep only 8-K.
4. **Shared sources** (`shared[]`): Federal Register (export controls and tariffs, a day before publication), White House actions, Fed / BLS data, defense contract awards (~17:00 ET daily), FDA, Medicare pricing, oil inventories (Wednesdays 10:30 ET), Treasury yield curves, outage status pages, court dockets, Waymo.

**Ten companies have no working feed of their own** (TSM, AVGO, MU, ORCL, PLTR, UBER, TSLA, SPCX, GD, JPM): they depend on the Alpaca stream plus SEC filings. Walmart's newsroom is an HTML page that must be polled.

### Do not use as news sources
Yahoo Finance and Google News feeds, Seeking Alpha, Motley Fool: late, mostly rewrites, and they make old news look new.
(Yahoo's chart API is fine for **prices** only: oil `CL=F`, gold `GC=F`, `GBPUSD=X`.)

### Things that will trip up a parser or a naive reading
- **Exxon's CIK changed** (see the table). A watcher using 34088 misses every XOM filing.
- **Microsoft reports two new business segments from this quarter** ("Agents and Infra", "Devices and Consumer"); comparisons with the old segment names break.
- **ASML no longer reports quarterly orders** (since 2026). Watch its sales outlook instead.
- **Lilly's feed** only answers the User-Agent `Feedly/1.0`. Several investor sites (Corning, P&G, J&J, Netflix) are read through a JSON endpoint (`/feed/PressRelease.svc/GetPressReleaseList`), because their RSS is blocked.
- **Status pages list planned maintenance** with future dates; filter for real outages.
- **Federal Register:** the agency filter is ignored on the public-inspection endpoint; filter the results yourself.
- **OPEC+ is now 7 countries** (the UAE left on 1 May 2026); decisions usually come on Sundays and move oil at the Monday open.
- Some investor sites block scripts from some IP addresses; a feed that worked yesterday can return 403 today. Treat a blocked feed as "no news from this source", not as "no news".

## 6. Calendar, 12 Oct – 30 Nov 2026 (ET)

✓ = announced by the company or agency. ? = estimated from last year (companies announce their date 1–4 weeks ahead in the same feeds).

| Date | Event |
|---|---|
| Before the start | Tesla Q3 deliveries 2 Oct (486,532, above the ~461k forecast) · OPEC+ 4 Oct · Samsung early results evening of 7 Oct · TSMC September sales 8 Oct |
| Every business day | Defense contract awards ~17:00 · memory spot prices (DRAMeXchange) ~06:10 · oil inventories Wednesdays 10:30 |
| 12–15 Oct | OCP Global Summit (data-centre hardware) ✓ |
| 13 Oct | **JPM, JNJ results** before the open ✓ |
| 14 Oct | **CPI 08:30** ✓ · ASML before the open ? |
| 15 Oct | PPI 08:30 ✓ · **TSMC Q3 results 02:00** ✓ |
| 20 Oct | **NOC, RTX** before the open ✓ · **NFLX** after the close ✓ |
| 21 Oct | **IBM, TSLA** after the close ✓ |
| 22 Oct | **LMT, PG** before the open ✓ · Intel ~22–23 ? |
| 27 Oct | **Corning** call 08:30 ✓ · SK Hynix ~27–28 ? |
| 28 Oct | **Fed rate decision 14:00** ✓ · MSFT, GOOGL, META ~28 ? |
| 29 Oct | GDP + PCE inflation 08:30 ✓ · **SanDisk** after the close ✓ · **LLY** call 10:00 ✓ (release usually ~06:45) · AAPL, AMZN ~29 ? |
| 30 Oct | Employment costs ✓ · XOM ~30 ? · GD, NET late Oct ? |
| 2–6 Nov | **US midterm elections 3 Nov** ✓ (reaction at the 4 Nov open) · **jobs report 6 Nov** ✓ · PLTR, UBER, AMD, SPCX, LITE ? |
| 10–13 Nov | CPI 10th ✓ · TSMC October sales 10th ✓ · PPI 13th ✓ · Cisco ~12th ? |
| 14–17 Nov | ObesityWeek (LLY obesity-drug data, often outside market hours) ✓ |
| 18–25 Nov | NVIDIA ~18–19 ? · **WMT 19th** ✓ · GDP second estimate + PCE 25th ✓ · Dell ~25 ? |
| After 30 Nov | ORCL, CRWD, MU, HPE, AVGO results (December) · government funding expires 11 Dec |

## 7. Setup on the Windows machine (once)

1. `npm test`: all tests should pass.
2. `$env:UMUSHROOM_LIVE='1'; npm run test:live`: previews an Apple buy and a gold-ETC buy by ISIN on the real site (**no order is placed**). Confirms the ETF form is read correctly.
3. Create a free Alpaca account (paper trading is enough) for the news stream.
4. Check every source from this machine:
   ```powershell
   $env:FEED_CONTACT='ukic-agent@yourdomain.com'   # dedicated address, required by SEC/BLS; not a personal one
   $env:ALPACA_KEY_ID='...'; $env:ALPACA_SECRET_KEY='...'
   npm run check-feeds
   ```
   It prints OK / BLOCKED / MISSING / WRONG_TYPE / ERROR per source (with the latest item date) and saves `reports/feed-check.json`.
   Read-only: it never posts or orders anything. Sources that are BLOCKED here: rely on the Alpaca stream and SEC filings for those companies.
5. Search UMushroom once for SK Hynix and note the ticker it shows.

## 8. Still open

- **Alpaca free tier:** that it still includes the live news stream in 2026 is unconfirmed; step 4 above confirms it.
- **SEC access** could not be tested from the research machine (its DNS could not resolve sec.gov); step 4 above tests it.
- Dates marked ? above will be announced by the companies during October.
