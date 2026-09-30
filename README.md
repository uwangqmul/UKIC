# UMushroom MCP Browser Example

This project uses a signed-in Google Chrome to open [UMushroom My Overview](https://umushroom.com/en/my-overview) without logging in again, and lets you work with your portfolios through MCP tools or the command line.

It offers three kinds of features:

- **Buy / sell**: buy or sell a company's shares (for example Apple) in your paper portfolio. By default it only previews; add `--submit` / `submit: true` to actually place the order.
- **Journal mode**: after you pick a portfolio, it records all holdings with their performance, pending orders, transaction history and the actions made through this project, and shows them live in a web page next to UMushroom.
- **Read-only review**: goes to your **My portfolios** list, opens each portfolio and tests section navigation, chart periods, holding categories, expand/collapse, sorting and history filters. The review never clicks buy, sell, create, edit, delete, share, publish or benchmark changes.

## Project structure

```
With_Nick/
├─ package.json          npm scripts and dependencies
├─ mcp.json              server config used by the MCP Inspector
├─ start-umushroom.cmd   double-click to open UMushroom and the journal page
├─ src/
│  ├─ config.js          local config: environment variables, folders, timeouts (the single place for config)
│  ├─ site.js            site structure: URLs, page selectors, portfolio URL rules (change this when the site is redesigned)
│  ├─ browser.js         browser session (attach to your everyday Chrome / project profile) and shared page helpers
│  ├─ trade.js           buy / sell
│  ├─ journal.js         journal mode: portfolio snapshots (holdings, performance, pending orders, history) and journal storage
│  ├─ dashboard.js       local server for the journal page (http://127.0.0.1:6420/)
│  ├─ autolog.js         journal service: adjusting portfolios from the page, hourly updates
│  ├─ review.js          read-only review
│  ├─ umushroom.js       public entry point (used by both MCP and the CLI)
│  └─ server.js          MCP server, registers 10 tools
├─ web/
│  └─ journal.html       journal page
├─ scripts/
│  ├─ cli.js             command line: login / open / trade / review / log / journal
│  ├─ inspect.js         starts the MCP Inspector
│  └─ explore.js         page-exploration helper (for development)
└─ tests/
   ├─ buy.test.js        buy tests (local mock pages)
   ├─ journal.test.js    journal mode tests (local mock pages)
   ├─ autolog.test.js    journal service tests: adjusting portfolios from the page, hourly updates, API security
   ├─ fixtures/mock-site.js  UMushroom mock site shared by the tests
   ├─ live-buy.test.js   buy test against the real site (skipped by default)
   └─ site.test.js       portfolio URL rule tests
```

At runtime the project creates `.browser-data\` (Chrome profile with your sign-in, never share it), `logs\`, `reports\`, `.explore\` and `.mcp-inspector\`; all of them are in `.gitignore`.

## Usage (quick start)

Run every command in the VS Code terminal.

### Step 0: setup (once)

You need Node.js 22.19 or newer and Google Chrome installed.

```powershell
Set-Location -LiteralPath 'C:\Users\wangzuo\Desktop\project\With_Nick'
npm install
npm run login
```

`npm run login` opens the project's own Chrome profile in normal (non-automated) mode. Sign in to UMushroom there (Google sign-in works), and once you see My Overview, **close that Chrome window**. You won't need to sign in again.

Check that it opens without logging in:

```powershell
$env:MCP_CHROME_MODE='profile'; npm run open
```

If the terminal prints `✅ My Overview opened without logging in.`, it worked; press `Ctrl+C` to stop.

> Before each run, make sure the Chrome window the project opened last time is closed, otherwise you'll be told the profile folder is in use.

### Option 1: command line (simplest)

Preview first (fills in the form without submitting; the terminal prints price, amount and weight):

```powershell
npm run trade -- buy Apple --portfolio "First Portfolio" --shares 1
```

Once it looks right, add `--submit` to actually place the order:

```powershell
# Buy 1 share of Apple
npm run trade -- buy Apple --portfolio "First Portfolio" --shares 1 --submit

# Buy USD 1000 worth
npm run trade -- buy AAPL --portfolio "First Portfolio" --amount 1000 --submit

# Sell 1 share / sell everything
npm run trade -- sell Apple --portfolio "First Portfolio" --shares 1 --submit
npm run trade -- sell Apple --portfolio "First Portfolio" --shares all --submit
```

Arguments:

| Argument | Meaning |
|---|---|
| `buy` / `sell` | buy more / sell |
| company | company name (`Apple`, `Microsoft`) or ticker (`AAPL`, `MSFT`) |
| `--portfolio` | portfolio name, e.g. `"First Portfolio"`; optional for buying (uses the default portfolio), required for selling |
| `--portfolio-index` | which one to use when several portfolios share a name (starting at 1), e.g. two `"My portfolio"`s |
| `--shares` | number of shares; `all` is allowed when selling |
| `--amount` | order by amount instead (use either this or `--shares`) |
| `--submit` | actually submit; without it you only get a preview |

Chrome pops up while it runs so you can watch each step, and closes automatically at the end.

### Option 2: MCP Inspector (call tools by clicking)

```powershell
npm run inspect
```

The Inspector page opens automatically in a separate Chrome window (with a temporary profile, so it doesn't lock your signed-in profile). When the terminal prints "Confirmed the current Google Chrome tab shows the Inspector", it's ready; if an old Inspector is still running, press `Ctrl+C` in the old terminal first.

1. In the Inspector page in Chrome, click **Connect**.
2. Open **Tools** → **List Tools**; you'll see `buy_umushroom_stock` and `sell_umushroom_stock`.
3. Click a tool and fill in the arguments: `company` = `Apple`, `portfolio` = `First Portfolio`, `shares` = `1`; leave `submit` unticked at first (preview only), and tick it once you're sure.
4. Click **Run Tool**; the result appears on the right.

### Option 3: give instructions in plain language in an AI client

Add the MCP server to your client's config (see "Connecting MCP clients" below), then just say: "Buy 1 share of Apple in First Portfolio."

### FAQ

| Symptom | Fix |
|---|---|
| "Chrome is running" / profile in use | Close the Chrome window the project opened and try again |
| Selling says the portfolio has no holding of that stock | A stock you just bought is still a **Pending Order**; you can sell it once it's filled after the market opens |
| Asked to sign in | Run `npm run login` again and sign in |
| Google says "This browser or app may not be secure" | Don't sign in inside an automated window; use `npm run login` instead |
| Error about portfolios with the same name | Add `--portfolio-index 1` or `2` |

## Journal mode

After you pick a portfolio, the program reads everything about it on UMushroom and records it as a **snapshot**, which is shown in a web page in a window next to UMushroom:

- **Overview**: current value (and the change since the last snapshot), cash, invested, performance, risk level, benchmark, Sharpe / Sortino / Info ratio, and a current-value trend across snapshots.
- **Holdings**: each stock's price, performance since it was added, shares, value and weight; price and share changes since the last snapshot, plus new and sold-out positions.
- **Pending orders**: buys / sells placed while the market is closed, filled when it opens.
- **Transaction history**: buys, sells, dividends and cash movements from UMushroom's History.
- **Activity**: every buy / sell made through this project (preview only or submitted).

```powershell
# Take a snapshot of a portfolio and open the journal page next to it (Ctrl+C to stop)
npm run log -- "First Portfolio"

# Only open the journal page to view existing journals
npm run journal
```

The journal page lives at http://127.0.0.1:6420/ and checks for updates every 5 seconds; the top-right corner has a "Red up / green down" color switch. In profile mode, UMushroom and the journal page are arranged automatically as the left and right halves of the screen.

### Adjusting portfolios from the journal page

The journal page isn't only for viewing; you can act from it too (only when it was opened through this project, e.g. by double-clicking `start-umushroom.cmd`):

- **Buy / sell**: in "Adjust portfolio", choose Buy or Sell, enter a company name or ticker and a number of shares or an amount (selling also offers "Sell all"), click **Preview** to see the market price, estimated amount, expected weight and available cash, then click **Confirm** once it looks right. The + / − buttons on each holdings row prefill that stock.
- **Add portfolio**: click **+ Add portfolio** on the left and choose from all portfolios in your My profile; a snapshot is recorded right after adding. Portfolios with the same name are numbered.
- **Update now**: update the current portfolio, or use **Update all now** at the top.
- **Remove from list**: stops showing and auto-updating it; the recorded journal files are kept and you can add it back later.

These actions run in a **background tab** of the UMushroom window, so they don't interrupt the page you're looking at. Only one runs at a time, and the header shows "Running: …". Actions submitted from the page are marked "journal page" in the activity log.

### Hourly updates

With **Hourly auto-update** ticked at the top (on by default), every full hour (xx:00) records a snapshot of each listed portfolio that has "Include in hourly updates" ticked; the header shows the next run time and the last result. You can switch "Include in hourly updates" off per portfolio below its overview.

Hourly updates only run while a process of this project is open: double-click `start-umushroom.cmd` (keep that black window open), `npm run open` / `npm run journal`, or while an MCP server is connected. Hours missed while the computer sleeps or the program is closed are not made up. Settings are saved in `logs\settings.json`.

**Journal bound to UMushroom**: whenever UMushroom is opened through this project (`npm run open`, `npm run trade`, `npm run log`, `npm run umushroom`, or any MCP tool), the journal page pops up next to it automatically. It pops up only once per run and won't reappear after you close it; set `$env:MCP_LOG_OPEN='off'` if you don't want it.

**Double-click to start**: double-click `start-umushroom.cmd` in the project folder to open UMushroom and the journal page without VS Code. You can right-click it → "Send to" → "Desktop (create shortcut)". Closing the black window that appears ends it.

**Buys and sells are journaled automatically**: journal mode is on by default; after each buy or sell (including previews) the portfolio gets a snapshot and an activity entry, and the journal page opens the first time. This adds ten-odd seconds per trade; set `$env:MCP_LOG_MODE='off'` to turn automatic journaling off.

Journals are stored in `logs\<owner>--<portfolio>\`: `latest.json` (latest snapshot), `snapshots.jsonl` (all snapshots) and `events.jsonl` (activity). They're all text files you can open directly.

## Two ways to connect to Chrome

The program picks the connection by `MCP_CHROME_MODE`: `auto` (default: try attaching to your everyday Chrome first, then fall back to the project profile), `attach` (attach only) or `profile` (project profile only). `npm run trade`, `npm run explore` and the live-site test use `profile` by default.

### Project profile (recommended, most reliable)

Uses `.browser-data\umushroom-profile` inside the project. Run `npm run login` once to sign in by hand; after that no sign-in is needed. **Don't sign in inside an automated window**: Google blocks browsers controlled by a program ("This browser or app may not be secure").

### Attaching to your everyday Chrome (needs Chrome 144+)

Since Chrome 136, for security reasons, Chrome no longer lets automation launch the **default user data folder** (`User Data`) with `--remote-debugging-port`, so the old approach of "have Playwright launch your Chrome profile" always fails (that's what `ProcessSingleton` / `Target page, context or browser has been closed` in old reports means). On Windows, cookies also use App-Bound encryption, so copying the profile folder doesn't carry the sign-in over.

The solution is to **connect to the running Chrome**:

1. Open your everyday Chrome normally (signed in to UMushroom).
2. Go to `chrome://inspect/#remote-debugging` and **enable remote debugging** as the page describes (once only).
3. In the VS Code terminal, run:

```powershell
npm run open
```

Chrome asks "Allow remote debugging?"; click **Allow**. The script opens My Overview in a **new tab** in your Chrome and prints the login state; `Ctrl+C` only closes that tab and disconnects, and your Chrome keeps running.

### Environment variables

All are read in `src\config.js`, which documents them in full at the top. The common ones:

| Variable | Purpose |
|---|---|
| `MCP_CHROME_MODE` | `auto` / `attach` / `profile` |
| `MCP_CHROME_CDP_URL` | debugging address to attach to directly, e.g. `http://127.0.0.1:9222` |
| `MCP_CHROME_USER_DATA_DIR` | your everyday Chrome's User Data folder (used to find `DevToolsActivePort`) |
| `MCP_CHROME_FALLBACK_DIR` | project profile folder |
| `MCP_CHROME_EXECUTABLE_PATH` | path to chrome.exe |
| `MCP_SLOW_MO` | milliseconds to slow down each step, default 300 |
| `MCP_LOG_MODE` | `off` turns journal mode off (on by default) |
| `MCP_LOG_OPEN` | `off` stops the journal page from popping up when UMushroom opens |
| `MCP_LOG_PORT` | journal page port, default 6420 |

## Buy / sell page flows

UMushroom portfolios use simulated money (paper portfolios). The flows have been verified on the real site:

- **Buy**: site search for the company → stock page `Add to portfolio` → choose the portfolio → enter shares or amount → `Add`
- **Sell**: open the portfolio → Investments `All` tab → that holding's `Sell` → enter shares → `Sell`
- After submitting, a popup shows "Order placed" and the script clicks `Done`. While the market is closed, orders go into **Pending Orders** and are filled when it opens; a stock you just bought can't be sold until it's filled.

By default it **only previews** (fills in the form and reads back price, amount and weight without submitting); add `--submit` / `submit: true` to actually place the order.

## Read-only review

Opens each personal and team portfolio in My profile one by one, tests section navigation, chart periods, holding categories, expand/collapse, sorting and history filters, and confirms every click took effect. Trending portfolios recommended on Overview are not mixed into the results.

In the terminal, run:

```powershell
npm run umushroom
```

The review continues automatically after sign-in. Pressing `Ctrl+C` in the terminal stops it and closes the Chrome window the project opened.

The JSON and Markdown report of each run is saved in:

```
C:\Users\wangzuo\Desktop\project\With_Nick\reports\umushroom\<run-id>
```

In MCP: `start_umushroom_review` returns immediately; call `get_umushroom_review_status` repeatedly to see progress, failed steps and the report path; `stop_umushroom_review` stops further clicks.

## Connecting MCP clients

Available tools:

| Tool | Purpose |
|---|---|
| `open_umushroom` | open My Overview and check the login state |
| `check_umushroom_login` | check the login state (never reads passwords, cookies or tokens) |
| `buy_umushroom_stock` | buy; arguments `company`, `portfolio`, `portfolioIndex`, `shares` or `amount`, `submit` (default false) |
| `sell_umushroom_stock` | sell; same arguments, `shares` may be `"all"` |
| `start_umushroom_review` | start the read-only review (runs in the background) |
| `get_umushroom_review_status` | review progress and report path |
| `stop_umushroom_review` | stop the review, keeping finished results |
| `log_umushroom_portfolio` | journal mode: snapshot a portfolio and open the journal page next to it; arguments `portfolio`, `portfolioIndex`, `open` |
| `open_umushroom_journal` | open the journal page |
| `close_umushroom` | close the tab / window this project opened (in attach mode your Chrome stays open) |

**MCP Inspector** uses the project's `mcp.json`; just run `npm run inspect`.

**Codex**: add the following to `config.toml`, then reload MCP:

```toml
[mcp_servers.umushroom]
command = "node"
args = ["C:\\Users\\wangzuo\\Desktop\\project\\With_Nick\\src\\server.js"]
env = { MCP_CHROME_MODE = "profile" }
```

`MCP_CHROME_MODE = "profile"` means it always uses the signed-in project Chrome profile.

## Tests

### Buy test cases (local mock, never touches the real site)

`tests\buy.test.js` tests the buy flow against local pages modeled on the real page structure: no sign-in needed and no real orders. It covers:

- The company name `Apple` finds Apple Inc (not Apple Hospitality REIT), and the ticker `AAPL` works too.
- Preview mode places no order; ordering by amount is converted into shares (checks that the page recalculation is triggered correctly).
- After submitting, it reads "Order placed", clicks Done, and sends the right order (stock, portfolio, shares).
- Switching portfolios; same-name portfolios require `portfolioIndex`; a missing portfolio, insufficient cash, bad arguments, ambiguous names and stocks that can't be found all raise errors without ordering.

```powershell
npm test
```

### Journal mode tests (local mock, never touches the real site)

`tests\journal.test.js` uses a mock portfolio page to test snapshot reading (overview, all holdings after expanding, pending orders, transaction history), journal storage, the journal page API and page rendering; `tests\autolog.test.js` uses headless Chrome to test adding portfolios from the journal page, previewing and submitting a buy, switching and running hourly updates, and that the API only accepts requests from the journal page itself. Journals go to a temporary folder; these run as part of `npm test`.

### Live-site buy test (skipped by default)

`tests\live-buy.test.js` uses the signed-in project Chrome profile to run the Apple buy flow on the real site. Close any Chrome window the project opened before running it.

```powershell
# Preview only, no order
$env:UMUSHROOM_LIVE='1'; npm run test:live

# Actually buy 1 share of Apple in the paper portfolio
$env:UMUSHROOM_LIVE='1'; $env:UMUSHROOM_LIVE_SUBMIT='1'; npm run test:live
```

Use `$env:UMUSHROOM_TEST_PORTFOLIO='Second portfolio'` to switch portfolios. When done, run `Remove-Item Env:UMUSHROOM_LIVE_SUBMIT` in the same terminal so you don't place orders by accident later.

## Development: adapting to a site redesign

- Page selectors and URLs all live in `src\site.js`; most redesigns only need changes there.
- `npm run explore` starts the page-exploration helper: it opens the signed-in page, runs the numbered commands in `.explore\cmd-N.json` (click, type, read elements, call project functions, etc.) and writes results and screenshots to `.explore\out-N.json` / `.png`. The command format is described in the comments at the top of `scripts\explore.js`.
- After changes, run `npm test`, then preview on the real site with `npm run trade -- buy Apple --portfolio "First Portfolio" --shares 1`.
