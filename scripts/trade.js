// Command-line buy / sell (UMushroom paper portfolios). Preview only by default; add --submit to submit.
// Example: npm run trade -- buy Apple --portfolio "First Portfolio" --shares 1
//     npm run trade -- sell Apple --portfolio "First Portfolio" --shares all --submit
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    portfolio: { type: "string" }, "portfolio-index": { type: "string" },
    shares: { type: "string" }, amount: { type: "string" }, submit: { type: "boolean", default: false },
  },
});
const [kind, ...rest] = positionals;
const company = rest.join(" ");
if (!["buy", "sell"].includes(kind) || !company) {
  console.error('Usage: npm run trade -- <buy|sell> <company> [--portfolio name] [--shares N|all | --amount N] [--submit]');
  process.exit(1);
}
process.env.MCP_CHROME_MODE ||= "profile";
const { tradeUmushroom, closeUmushroom } = await import("../src/umushroom.js");
const options = {
  company, portfolio: values.portfolio, submit: values.submit,
  portfolioIndex: values["portfolio-index"] ? Number(values["portfolio-index"]) : undefined,
  shares: values.shares === "all" ? "all" : values.shares ? Number(values.shares) : undefined,
  amount: values.amount ? Number(values.amount) : undefined,
};
try {
  console.log(JSON.stringify(await tradeUmushroom(kind, options), null, 2));
  console.log(options.submit ? "✅ Submitted." : "ℹ️ Preview only, nothing submitted; add --submit once everything looks right.");
} catch (error) {
  console.error("❌ " + error.message);
  if (error.result) console.error(JSON.stringify(error.result, null, 2));
  process.exitCode = 1;
} finally {
  await closeUmushroom().catch(() => {});
}
