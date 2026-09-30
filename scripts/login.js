// One-time sign-in: opens the project profile in Google Chrome in "normal mode" (without any automation flags)
// so you can sign in to UMushroom by hand (including "Sign in with Google").
// Google blocks sign-in in browsers controlled by automation ("This browser or app may not be secure"),
// so this step must be done in this normal window; afterwards npm run open reuses the same profile without signing in again.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_PROFILE_DIR, OVERVIEW_URL } from "../src/umushroom-session.js";

function findChrome() {
  const configured = process.env.MCP_CHROME_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;
  return [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((base) => join(base, "Google", "Chrome", "Application", "chrome.exe"))
    .find(existsSync);
}

const chrome = findChrome();
if (!chrome) {
  console.error("Google Chrome not found; please set MCP_CHROME_EXECUTABLE_PATH.");
  process.exit(1);
}

const child = spawn(chrome, [
  `--user-data-dir=${FALLBACK_PROFILE_DIR}`,
  "--no-first-run",
  "--no-default-browser-check",
  OVERVIEW_URL,
], { stdio: "ignore", windowsHide: false });

console.log(`Opened Chrome in normal mode (profile folder: ${FALLBACK_PROFILE_DIR}).`);
console.log("Sign in to UMushroom in this window, and once you see My Overview, [close this Chrome window].");
console.log("After the window is closed, run: $env:MCP_CHROME_MODE='profile'; npm run open");
child.on("exit", () => {
  console.log("The sign-in window was closed; the sign-in is saved in the project profile.");
});
