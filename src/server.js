// =============================================================================
// MCP server (stdio)
// -----------------------------------------------------------------------------
// Registers the functions of umushroom.js as MCP tools (10 in total) for clients such as the Inspector, Codex or Claude.
// Start: npm start (usually launched automatically by the MCP client from mcp.json / config.toml).
// Note: stdout is reserved for the MCP protocol, so logs must go to stderr (console.error).
// =============================================================================
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  openUmushroom, checkUmushroomLogin, startUmushroomReview,
  getUmushroomReviewStatus, stopUmushroomReview, closeUmushroom, tradeUmushroom,
  logPortfolio, openJournal,
} from "./umushroom.js";

const server = new McpServer({ name: "umushroom-browser", version: "0.2.0" });

/**
 * Register a tool: the return value is formatted as JSON text; on error, isError and the message are returned
 * (trade errors also include the preview data already read, error.result, to help diagnose).
 * shape is the zod definition of the parameters; omit it for tools without parameters.
 */
function register(name, description, run, shape) {
  const handler = async (...callArgs) => {
    try {
      const result = await (shape ? run(callArgs[0]) : run());
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const detail = error.result ? "\n" + JSON.stringify(error.result, null, 2) : "";
      return { isError: true, content: [{ type: "text", text: error.message + detail }] };
    }
  };
  if (shape) server.tool(name, description, shape, handler);
  else server.tool(name, description, handler);
}

// ---- Open and login ----
register("open_umushroom", "Open UMushroom My Overview in a visible Google Chrome using its existing login and keep the window open; reports the login state.", openUmushroom);
register("check_umushroom_login", "Check the UMushroom login state in Google Chrome; never reads passwords, cookies or tokens.", checkUmushroomLogin);

// ---- Read-only review ----
register("start_umushroom_review", "Start a background review: open UMushroom in Google Chrome and wait for a manual login if needed, go to My Overview, then open each personal portfolio found and test the read-only navigation and chart controls. Returns progress immediately; use get_umushroom_review_status for results.", startUmushroomReview);
register("get_umushroom_review_status", "Show the current step, portfolio progress, click results and local report paths of the UMushroom review.", getUmushroomReviewStatus);
register("stop_umushroom_review", "Stop the remaining UMushroom review steps, keeping the results so far and the Google Chrome window.", stopUmushroomReview);
register("close_umushroom", "Stop the review and close the Google Chrome window opened by this project; the Chrome login is kept for next time.", closeUmushroom);

// ---- Buy / sell (both tools share the same parameters) ----
const tradeShape = {
  company: z.string().min(1).describe("Company name or ticker, e.g. Apple or AAPL"),
  portfolio: z.string().optional().describe("Portfolio name (e.g. First Portfolio) or URL; optional for buy (uses the popup's default portfolio), required for sell"),
  portfolioIndex: z.number().int().min(1).optional().describe("Which portfolio to use when several share the same name (1-based)"),
  shares: z.union([z.number().positive(), z.literal("all")]).optional().describe("Number of shares; for sell, \"all\" sells everything"),
  amount: z.number().positive().optional().describe("Order by amount (in the portfolio currency) instead of shares"),
  submit: z.boolean().default(false).describe("false = fill the form and preview only (default); true = click the final Add/Sell button"),
};
register("buy_umushroom_stock", "Buy: add shares of a company to a UMushroom paper portfolio (search the company -> Add to portfolio -> choose portfolio -> shares or amount). Preview only by default; submit=true places the order.",
  (args) => tradeUmushroom("buy", args), tradeShape);
register("sell_umushroom_stock", "Sell: sell a company's holding in a UMushroom paper portfolio (portfolio -> Investments -> Sell -> shares or amount). Preview only by default; submit=true places the order.",
  (args) => tradeUmushroom("sell", args), tradeShape);

// ---- Journal mode ----
register("log_umushroom_portfolio", "Journal mode: read all holdings and their changes, pending orders, transaction history and summary metrics of a portfolio, save them as a snapshot, and open the journal page in a window beside UMushroom.",
  (args) => logPortfolio(args), {
    portfolio: z.string().min(1).describe("Portfolio name (e.g. First Portfolio) or URL"),
    portfolioIndex: z.number().int().min(1).optional().describe("Which portfolio to use when several share the same name (1-based)"),
    open: z.boolean().default(true).describe("Whether to open the journal page beside UMushroom (default: yes)"),
  });
register("open_umushroom_journal", "Open the portfolio journal page in a new window beside UMushroom (holdings, changes, pending orders, history and activity of every recorded portfolio).", openJournal);

// ---- Start-up and shutdown ----
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("UMushroom MCP ready: open_umushroom / start_umushroom_review");

// When the client disconnects (stdin ends) or an exit signal arrives, close the browser first, then exit.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeUmushroom().catch(() => {});
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
