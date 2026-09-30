import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  openUmushroom, checkUmushroomLogin, startUmushroomReview,
  getUmushroomReviewStatus, stopUmushroomReview, closeUmushroom, tradeUmushroom,
} from "./umushroom.js";

const server = new McpServer({ name: "umushroom-browser", version: "0.2.0" });

function tool(name, description, action) {
  server.tool(name, description, async () => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await action(), null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });
}

tool("open_umushroom", "Open the https://umushroom.com/ home page in a visible Google Chrome, read Chrome's existing sign-in state and keep the window open; go to My Overview after sign-in.", openUmushroom);
tool("check_umushroom_login", "Check the UMushroom login state in Google Chrome; never reads passwords, cookies or tokens.", checkUmushroomLogin);
tool("start_umushroom_review", "Start a background review: open the https://umushroom.com/ home page in Google Chrome and wait for manual sign-in, then go to My Overview, view each personal portfolio found and test read-only navigation and chart controls. Returns task progress immediately; use get_umushroom_review_status for the results.", startUmushroomReview);
tool("get_umushroom_review_status", "Show the current step of the UMushroom review, portfolio progress, click results and the local report path.", getUmushroomReviewStatus);
tool("stop_umushroom_review", "Stop further UMushroom test steps, keeping the results so far and the Google Chrome window.", stopUmushroomReview);
tool("close_umushroom", "Stop the review and close the Google Chrome window this project opened; Chrome's sign-in is reused next time.", closeUmushroom);

const tradeShape = {
  company: z.string().min(1).describe("Company name or ticker, e.g. Apple or AAPL"),
  portfolio: z.string().optional().describe("Portfolio name (e.g. First Portfolio) or URL; optional for buying (uses the popup's default portfolio), required for selling"),
  portfolioIndex: z.number().int().min(1).optional().describe("Which one to use when several portfolios share a name (starting at 1)"),
  shares: z.union([z.number().positive(), z.literal("all")]).optional().describe("Number of shares; \"all\" sells everything when selling"),
  amount: z.number().positive().optional().describe("Order by amount (portfolio currency); use either this or shares"),
  submit: z.boolean().default(false).describe("false = fill in the form and preview without submitting (default); true = click the final Add/Sell button"),
};

function tradeTool(name, kind, description) {
  server.tool(name, description, tradeShape, async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await tradeUmushroom(kind, args), null, 2) }] };
    } catch (error) {
      const detail = error.result ? "\n" + JSON.stringify(error.result, null, 2) : "";
      return { isError: true, content: [{ type: "text", text: error.message + detail }] };
    }
  });
}

tradeTool("buy_umushroom_stock", "buy", "Buy: buy / add a company's shares in a UMushroom paper portfolio (search the company → Add to portfolio → choose portfolio → enter shares or amount). Preview only by default; submit=true submits.");
tradeTool("sell_umushroom_stock", "sell", "Sell: sell a company's holding in a given UMushroom paper portfolio (portfolio → Investments → Sell → enter shares or amount). Preview only by default; submit=true submits.");

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("UMushroom MCP ready: open_umushroom / start_umushroom_review");

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
