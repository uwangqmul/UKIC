import { startUmushroomReview, getUmushroomReviewStatus, closeUmushroom } from "../src/umushroom.js";

console.log("Opening the https://umushroom.com/ home page with your signed-in Google Chrome; the first time, confirm your region and sign in.");
console.log("After sign-in the portfolios are checked automatically, slowed down step by step. Press Ctrl+C to stop and close the Chrome window.");
startUmushroomReview();
let previous = "";
const timer = setInterval(() => {
  const status = getUmushroomReviewStatus();
  const message = `[${status.status}] ${status.currentStep}`;
  if (message !== previous) { console.log(message); previous = message; }
  if (!["starting", "waiting_login", "running"].includes(status.status) && (status.summaryPath || status.reportError)) {
    clearInterval(timer);
    console.log(JSON.stringify(status, null, 2));
    console.log("This review has stopped; the Google Chrome window stays open for you to look at. Press Ctrl+C to exit.");
  }
}, 1500);

async function shutdown() {
  clearInterval(timer);
  await closeUmushroom();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
