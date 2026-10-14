// Smoke test: open UMushroom My Overview with your signed-in Chrome and print the login state.
// Usage: npm run open     (press Ctrl+C to stop; in attach mode only the tab this script opened is closed)
import { openUmushroom, closeUmushroom } from "../src/umushroom.js";

console.log("Connecting to Google Chrome and opening https://umushroom.com/en/my-overview ...");
console.log('If Chrome asks "Allow remote debugging?", click "Allow".');
try {
  const result = await openUmushroom();
  console.log(JSON.stringify(result, null, 2));
  console.log(result.session?.mode === "attach"
    ? "Mode: attached to your everyday Chrome."
    : "Mode: project Chrome profile (not attached to your everyday Chrome). To sign in here, run npm run login first.");
  console.log(result.login.state === "logged_in"
    ? "✅ My Overview opened without logging in. Press Ctrl+C to stop."
    : "⚠️ The page opened but the login state could not be confirmed; see login.message above. Press Ctrl+C to stop.");
} catch (error) {
  console.error("❌ Failed to open:\n" + error.message);
  process.exitCode = 1;
}

async function shutdown() {
  await closeUmushroom().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
if (process.exitCode) await shutdown();
else setInterval(() => {}, 1 << 30);
