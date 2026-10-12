# Stock News Bot (Stocks_bot)

Collects news on the 39 assets you follow (market news, official product launches, military/government contracts), uses Jev to judge whether each item is good or bad news, pushes it to Telegram, and builds a local dashboard with candlestick charts.

It runs on your own computer: as long as the computer is on, online and the window is open, it checks every 20 minutes.

---

## Daily use

**Double-click `start_stock_bot.bat`**. It will:

1. Check dependencies and the Telegram setup
2. Fetch all news → filter and de-duplicate → Jev verdicts → push to Telegram
3. Build the dashboard and open it in the browser
4. Repeat every 20 minutes until you close the window

If Telegram is not set up yet (or unreachable), news is still collected and the messages are sent once it works.

To start automatically at login: double-click `install_autostart.bat` once; from then on it starts in the background (minimised) every time you log in to Windows. Undo with `remove_autostart.bat`.

To just see the dashboard: double-click `open_dashboard.bat` (it refreshes the data first).

---

## Features

### 1. News sources

| Source | Content | Coverage |
|---|---|---|
| Google News search | Market news, product launches, contracts | Every company |
| Google News contract search | Military/government contracts (Pentagon, Army, Navy, Air Force, etc.) | LMT, NOC, GD, PLTR, SpaceX |
| Yahoo Finance | Company news | US-listed companies |
| Official newsroom RSS | Official launches and announcements | Apple, NVIDIA, Microsoft, Meta, Google, Cisco, Cloudflare, Lockheed Martin |
| US Department of Defense daily contract announcements | All defence contracts; the paragraphs naming the company are extracted | All companies |

All are free public RSS feeds; no account needed.

### 2. Filtering and de-duplication

- English keywords match **whole words, case-sensitive**, to avoid false matches (e.g. "artificial intelligence" doesn't count as Intel, "10 micron" doesn't count as Micron).
- Companies can have exclusion words, e.g. Corning excludes "Owens Corning" (a different company).
- The same story from several sources is pushed once; pushed items are recorded in `alerts.db`, so a restart doesn't push them again.
- Only news published in the last 3 days is considered.

### 3. Push rules

- At most 5 items per company per round, official releases and contracts first.
- When a round has more than 5, they are combined into a **digest grouped by company**; headlines link straight to the article.
- A newly added company only gets its latest item pushed the first time; the rest are marked as read so the chat isn't flooded.
- Failed pushes (e.g. no internet) are kept and retried next round.

Tags: 🏢 Official (official release)　🛡️ Contract/Defense　📰 News

Messages, the dashboard and code comments are all in English.

### 4. Jev verdicts

Each item to be pushed first goes to [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) (TypeSafe's System One model), which answers three questions:

| Question | Result |
|---|---|
| What is the likely short-term effect on the share price? | 📈 Bullish / 📉 Bearish / ➖ Neutral + confidence (%) |
| How big is the effect? | Low / Med / High (❗ means high) |
| Is the story mainly about this company? | Main topic / Partly / In passing |

A message shows it as `🤖 Jev: 📈 Bullish 81% | Impact High`; in a digest each headline has a mark like `📈81%❗`, and each company heading a count like `📈3 📉1`.

> ⚠️ Jev judges whether a story leans positive or negative. **It is not a price forecast and not investment advice.** Prices often already reflect the news by the time it is published, and headlines often describe a move that has already happened. The hit rate on the dashboard shows how it actually performs on your stocks; give it a few weeks before drawing conclusions.

### 5. Dashboard (dashboard.html)

- **Left list**: latest price, change, news count and bullish/bearish counts for the 39 assets; the thin bar is Jev's net leaning over the last 3 days. Sort by Jev leaning / change / news count / ticker, and search.
- **Candlestick chart**: one year of daily candles, switchable to 1 month / 3 months / 6 months / 1 year. Arrows mark days with bullish (below) or bearish (above) news; click a candle to filter that day's news.
- **News list**: last 14 days, filterable by bullish / bearish / official / contract. **Open an item** to see Jev's direction, impact and relevance, the actual move "one day later" and "to date" and whether it matched Jev, and a "Read article" button.
- **Hit rate at the top**: how often Jev's direction matched the next day's actual move. The base is the first close after publication (the earliest price you could buy at after seeing the news); only bullish/bearish verdicts with a move over 0.3% count.
- **Up/down colours**: red up / green down by default; switch with one click at the top right.

Prices come from Yahoo Finance (free). When the symbol is not a Yahoo ticker, `price_symbol` in `config.json` gives it (`HY9H.F`, `GOLD.AS`, `DTLA.L`).

---

## First-time setup (skip if already done)

### Telegram

1. In Telegram, message @BotFather and send `/newbot` to create a bot (the current one is **@wz_stock_alert_bot**).
2. Double-click `setup_telegram.bat`, paste the bot token when asked, then send `/start` to the bot.
3. The program reads the chat ID, saves it to `.env` and sends a test message.

### Push to a group (to share with classmates)

Messages currently go to the **UKIC Stock Alert** Telegram group (members: you, Nick and the Stock Alert bot).

To switch to another group: create the group and add @wz_stock_alert_bot → double-click `use_group.bat` → restart `start_stock_bot.bat`. To go back to a private chat: copy the value of `TELEGRAM_PRIVATE_CHAT_ID` in `.env` into `TELEGRAM_CHAT_ID`.

### Jev

1. Sign up at <https://console.typesafe.ai/> and create an API key.
2. Double-click `setup_jev.bat` and paste the key when asked. The program checks it with a test story before saving.

Without Jev everything else works as usual, just without bullish/bearish verdicts.

---

## Changing the stocks you follow

Edit `stocks` in `config.json`, one block per company, for example:

```json
{
  "symbol": "TSLA",
  "name": "Tesla",
  "keywords": ["Tesla", "TSLA", "Elon Musk"],
  "query": "Tesla OR TSLA",
  "official": ["https://example.com/official-newsroom-rss"],
  "contracts": false,
  "exclude": ["words that should not match"]
}
```

| Field | Meaning |
|---|---|
| `symbol` | Ticker, also used for prices unless `price_symbol` is set |
| `name` | Display name; also tells Jev which company this is |
| `keywords` | One of these must appear in the story (whole word, case-sensitive; Chinese matches as a substring) |
| `query` | Google News search terms |
| `official` | Optional: official sources. Each entry is a feed address, or an object: `{"url": …, "type": "json"}` for investor-site JSON press-release lists, `"ua": "feedreader"` for feeds that only answer feed readers, `{"search": "site:…"}` for a Google News search of the company's own news pages, and `"fallback": {…}` read only when the main source fails |
| `contracts` | Optional: `true` also searches military/government contracts |
| `exclude` | Optional: a headline containing these words is excluded |
| `yahoo` | Optional: `false` skips Yahoo company news (non-US or unlisted) |
| `suffix` | Optional: replaces `google_suffix` for this asset (gold and Treasury news rarely say "stock" or "shares") |
| `price_symbol` | Optional: Yahoo ticker for the dashboard chart when it differs from `symbol` |

Other settings: `check_interval_minutes` (check interval), `max_items_per_stock_per_run` (items per company per round), `digest_threshold` (switch to a digest above this many), `max_age_days` (only news from the last N days).

Save and you're done: the running bot reads the new settings in its next round.

---

## Files

| File | Purpose |
|---|---|
| `start_stock_bot.bat` | **Use this every day**: runs everything in a loop |
| `app.py` | Main program: loops "collect → Jev → push → dashboard" |
| `news.py` | News collection, filtering, de-duplication and pushing |
| `jev.py` | Jev verdicts |
| `dashboard.py` / `dashboard_template.html` | Builds the dashboard |
| `telegram_bot.py` | Telegram sending |
| `config.json` | Followed stocks and settings |
| `.env` | **Bot token, chat ID, Jev key and other keys (never share)** |
| `alerts.db` | News records, push status, Jev results |
| `stock_alert.log` | Run log |
| `dashboard.html` | The generated dashboard page |
| `run_news.bat` | Runs one round only (collect + push + dashboard) |
| `open_dashboard.bat` | Refreshes and opens the dashboard |
| `setup_telegram.bat` / `setup_jev.bat` | First-time setup |
| `use_group.bat` | Switches the push target to the Telegram group the bot is in |
| `install_autostart.bat` / `remove_autostart.bat` | Start at login / undo |

---

## Costs

- Telegram bot, all news sources, Yahoo prices: **free**
- Jev: $0.042 per million input tokens, output free; a few hundred stories a day cost less than 1 cent
- The computer's electricity and internet

---

## FAQ

**No Telegram messages**　Check the window or `stock_alert.log` for errors. `Unauthorized` means the token is wrong: delete everything after `TELEGRAM_BOT_TOKEN=` in `.env` and run `setup_telegram.bat` again.

**"The bot is already running"**　A window is already running (perhaps the minimised one started at login); there is no need to start another.

**A source is unavailable**　The log says "source unavailable"; other sources are not affected.

**Dashboard charts don't show**　The chart library and fonts load from the internet; make sure you're online and refresh the page.

**Too many messages**　Lower `max_items_per_stock_per_run` or raise `check_interval_minutes`.

**Jev verdicts fail**　Check the key is valid; you can run `setup_jev.bat` again.

---

## Security

- `.env` holds your bot token and keys. Treat them like passwords: never upload or share them (`.gitignore` already excludes it).
- If a key or token was ever sent in a chat or elsewhere, regenerate it: for Telegram, send `/revoke` to @BotFather; for Jev, delete the old key in the console and create a new one; for Claude or Qwen, delete the key in its console. Then clear the matching value in `.env` and run the matching setup again.
