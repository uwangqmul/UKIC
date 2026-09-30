# UMushroom MCP Browser Example

This MCP example connects to your signed-in Google Chrome, opens [My Overview](https://umushroom.com/en/my-overview) directly (no sign-in needed), and returns observable read-only review results to the MCP client.

It offers two kinds of features:

- **Buy / sell**: buy or sell a company's shares (for example Apple) in your paper portfolio. By default it only previews; add `--submit` / `submit: true` to actually place the order.
- **Read-only review**: goes to your **My portfolios** list, opens each portfolio and tests section navigation, chart periods, holding categories, expand/collapse, sorting and history filters. The review never clicks buy, sell, create, edit, delete, share, publish or benchmark changes.

## Usage (quick start)

Run every command in the VS Code terminal.

### Step 0: setup (once)

```powershell
Set-Location -LiteralPath 'C:\Users\wangzuo\Desktop\project\With_Nick'
npm install
npm run login
```

`npm run login` opens the project's own Chrome profile in normal mode. Sign in to UMushroom there (Google sign-in works), and once you see My Overview, **close that Chrome window**. You won't need to sign in again.

Check that it opens without signing in:

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

1. In the Inspector page in Chrome, click **Connect**.
2. Open **Tools** → **List Tools**; you'll see `buy_umushroom_stock` and `sell_umushroom_stock`.
3. Click a tool and fill in the arguments: `company` = `Apple`, `portfolio` = `First Portfolio`, `shares` = `1`; leave `submit` unticked at first (preview only), and tick it once you're sure.
4. Click **Run Tool**; the result appears on the right.

### Option 3: give instructions in plain language in an AI client

Add the MCP server to your client's config (see "Connecting to Codex" below), then just say: "Buy 1 share of Apple in First Portfolio."

### FAQ

| Symptom | Fix |
|---|---|
| "Chrome is running" / profile in use | Close the Chrome window the project opened and try again |
| Selling says the portfolio has no holding of that stock | A stock you just bought is still a **Pending Order**; you can sell it once it's filled after the market opens |
| Asked to sign in | Run `npm run login` again and sign in |
| Google says "This browser or app may not be secure" | Don't sign in inside an automated window; use `npm run login` instead |
| Error about portfolios with the same name | Add `--portfolio-index 1` or `2` |


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

### Live-site buy test (skipped by default)

`tests\live-buy.test.js` uses the signed-in project Chrome profile to run the Apple buy flow on the real site. Close any Chrome window the project opened before running it.

```powershell
# Preview only, no order
$env:UMUSHROOM_LIVE='1'; npm run test:live

# Actually buy 1 share of Apple in the paper portfolio
$env:UMUSHROOM_LIVE='1'; $env:UMUSHROOM_LIVE_SUBMIT='1'; npm run test:live
```

Use `$env:UMUSHROOM_TEST_PORTFOLIO='Second portfolio'` to switch portfolios. When done, run `Remove-Item Env:UMUSHROOM_LIVE_SUBMIT` in the same terminal so you don't place orders by accident later.

## Installation

You need Node.js 22.19 or newer and Google Chrome installed.

```powershell
Set-Location -LiteralPath 'C:\Users\wangzuo\Desktop\project\With_Nick'
npm install
```

## Starting the Inspector

```powershell
Set-Location -LiteralPath 'C:\Users\wangzuo\Desktop\project\With_Nick'
npm run inspect
```

The Inspector control page opens automatically in Google Chrome. Each start uses a new, separate Chrome profile folder inside the project, so it doesn't lock your signed-in profile; the server name in the connection config is `umushroom`, and Tools shows:

If an old Inspector is still running, press `Ctrl+C` in the old terminal first, then start this command only once; the script picks a free local port automatically.

The launcher uses Chrome's local debugging interface to confirm the current tab has navigated to the Inspector; opening is complete only when the terminal prints "Confirmed the current Google Chrome tab shows the Inspector".

- `open_umushroom`: open My Overview directly and check the login state.
- `check_umushroom_login`: check the login state without reading passwords, cookies or tokens.
- `start_umushroom_review`: after sign-in, review each personal portfolio in the background.
- `get_umushroom_review_status`: progress, click results and report path.
- `stop_umushroom_review`: stop further clicks and keep the finished results.
- `close_umushroom`: close the tab this project opened (in attach mode your Chrome stays open).

`start_umushroom_review` is a background task: it returns the start status first; once the Chrome window opens it waits for sign-in and continues the click review automatically. Wait a moment, then call `get_umushroom_review_status` to see live progress, failed steps and the report path.

## No sign-in: attach to your signed-in everyday Chrome (recommended)

Since Chrome 136, for security reasons, Chrome no longer lets automation launch the **default user data folder** (`User Data`) with `--remote-debugging-port`, so the old approach of "have Playwright launch your Chrome profile" always fails (that's what `ProcessSingleton` / `Target page, context or browser has been closed` in the reports means). On Windows, cookies also use App-Bound encryption, so copying the profile folder doesn't carry the sign-in over.

The current approach is to **connect to the running Chrome** (needs Chrome 144+):

1. Open your everyday Chrome normally (signed in to UMushroom).
2. Go to `chrome://inspect/#remote-debugging` and **enable remote debugging** as the page describes (once only).
3. In the VS Code terminal, run:

```powershell
npm run open
```

Chrome asks "Allow remote debugging?"; click **Allow**. The script opens My Overview in a **new tab** in your Chrome and prints the login state; `Ctrl+C` only closes that tab and disconnects, and your Chrome keeps running.

Fallback: if no Chrome to attach to is found, the project's own profile `.browser-data\umushroom-profile` is used. **Don't sign in inside an automated window**: Google blocks browsers controlled by a program ("This browser or app may not be secure"). Run this once first:

```powershell
npm run login
```

It opens the project profile in normal-mode Chrome; sign in to UMushroom there (Google sign-in works), then close the window. After that, `$env:MCP_CHROME_MODE='profile'; npm run open` works without signing in.

Optional environment variables:

- `MCP_CHROME_MODE`: `auto` (default, attach first then fall back) / `attach` (attach only) / `profile` (project profile only).
- `MCP_CHROME_CDP_URL`: debugging address to use directly, e.g. `http://127.0.0.1:9222`.
- `MCP_CHROME_USER_DATA_DIR`: your everyday Chrome's User Data folder (used to find `DevToolsActivePort`).
- `MCP_SLOW_MO`: milliseconds to slow down each step, default 300.

## Buy / sell page flows

UMushroom portfolios use simulated money (paper portfolios). The flows have been verified on the real site:

- **Buy**: site search for the company → stock page `Add to portfolio` → choose the portfolio → enter shares or amount → `Add`
- **Sell**: open the portfolio → Investments `All` tab → that holding's `Sell` → enter shares → `Sell`
- After submitting, a popup shows "Order placed" and the script clicks `Done`. While the market is closed, orders go into **Pending Orders** and are filled when it opens; a stock you just bought can't be sold until it's filled.

By default it **only previews** (fills in the form and reads back price, amount and weight without submitting); add `--submit` to actually place the order. See "Usage" above for the commands.

MCP tools: `buy_umushroom_stock`, `sell_umushroom_stock`, with arguments `company`, `portfolio`, `portfolioIndex` (for same-name portfolios), `shares` or `amount`, and `submit` (default false).

`npm run explore` is a page-exploration helper for development (reads commands from `.explore\cmd-N.json` and writes the results).

## Read-only review (run directly)

To start the background review from the terminal without the Inspector:

```powershell
Set-Location -LiteralPath 'C:\Users\wangzuo\Desktop\project\With_Nick'
npm run umushroom
```

The review continues automatically after sign-in. Pressing `Ctrl+C` in the terminal stops it and closes the Chrome window the project opened.

The JSON and Markdown report of each run is saved in:

```
C:\Users\wangzuo\Desktop\project\With_Nick\reports\umushroom\<run-id>
```

`reports`, Chrome automation data, Inspector local state and the dependency folders are all in `.gitignore`.

## Connecting to Codex

Add the following to your MCP config file, then reload MCP:

```toml
[mcp_servers.umushroom]
command = "node"
args = ["C:\\Users\\wangzuo\\Desktop\\project\\With_Nick\\src\\server.js"]
env = { MCP_CHROME_MODE = "profile" }
```

`MCP_CHROME_MODE = "profile"` means it always uses the signed-in project Chrome profile. Available tools: `open_umushroom`, `buy_umushroom_stock`, `sell_umushroom_stock`, `start_umushroom_review`, etc.

After calling `start_umushroom_review`, call `get_umushroom_review_status` repeatedly to see progress. The review only recognizes personal and team portfolios in My Profile and doesn't mix the Trending portfolios recommended on Overview into the results.
