// =============================================================================
// Page explore helper (for development, npm run explore)
// -----------------------------------------------------------------------------
// Opens a logged-in UMushroom page, then runs the commands in .explore\cmd-<n>.json in numeric order
// and writes the results to .explore\out-<n>.json (plus a screenshot out-<n>.png). Used to re-analyse pages after a site redesign.
// Command file format: { "actions": [ ... ], "stopOnError": true, "screenshot": true, "fullPage": false }
// Supported actions: goto / click / hover / fill / type / press / wait / waitFor / dump / text / html /
//            eval / count / call (call a project module function fn(page, ...args), e.g.
//            {"call":{"module":"src/trade.js","fn":"buyStock","args":[{...}]}};
//            add "page": false for functions that do not take a page, e.g. logPortfolio in umushroom.js)
// Exit: write a command file containing {"exit":true}, or press Ctrl+C.
// =============================================================================
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.MCP_CHROME_MODE ||= "profile"; // must be set before src/ is loaded
process.env.MCP_LOG_OPEN ||= "off";     // do not pop up the journal page while exploring
const { PATHS } = await import("../src/config.js");
const { OVERVIEW_URL } = await import("../src/site.js");
const { ensureUmushroomPage, closeUmushroomSession } = await import("../src/browser.js");

process.once("SIGINT", async () => { await closeUmushroomSession(); process.exit(0); });

const DIR = PATHS.explore;
await mkdir(DIR, { recursive: true });
// start from the first number without a result, so a restart continues where it left off
let n = 1;
while (existsSync(join(DIR, `out-${n}.json`))) n += 1;

const page = await ensureUmushroomPage({ navigate: true, url: OVERVIEW_URL });
await writeFile(join(DIR, "ready.json"), JSON.stringify({ ready: true, next: n, url: page.url(), at: new Date().toISOString() }));
console.log(`Explore helper ready, waiting for .explore/cmd-${n}.json ...`);

/** Turn a command target (CSS string or {role/text/label/placeholder/selector, within, nth}) into a locator. */
function locate(target) {
  if (typeof target === "string") return page.locator(target);
  let loc;
  if (target.role) loc = page.getByRole(target.role, { name: target.name, exact: target.exact ?? false });
  else if (target.text) loc = page.getByText(target.text, { exact: target.exact ?? false });
  else if (target.label) loc = page.getByLabel(target.label, { exact: target.exact ?? false });
  else if (target.placeholder) loc = page.getByPlaceholder(target.placeholder);
  else loc = page.locator(target.selector);
  if (target.within) loc = page.locator(target.within).locator(loc);
  return target.nth !== undefined ? loc.nth(target.nth) : loc.first();
}

/** List every visible interactive element inside scope (tag, text, attributes, position) to analyse page structure. */
async function dump(scope = "body") {
  return page.locator(scope).first().evaluate((root) => {
    const out = [];
    const sel = 'a,button,input,select,textarea,[role="button"],[role="tab"],[role="dialog"],[role="option"],[role="menuitem"],[contenteditable="true"]';
    for (const el of root.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!r.width || !r.height || style.visibility === "hidden" || style.display === "none") continue;
      out.push({
        tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || undefined,
        text: (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80) || undefined,
        aria: el.getAttribute("aria-label") || undefined, type: el.getAttribute("type") || undefined,
        name: el.getAttribute("name") || undefined, placeholder: el.getAttribute("placeholder") || undefined,
        href: el.getAttribute("href") || undefined, cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0, 100) || undefined,
        disabled: el.disabled || el.getAttribute("aria-disabled") === "true" || undefined,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      });
    }
    return out;
  });
}

/** Run one action and return its result. */
async function run(action) {
  if (action.goto) { await page.goto(action.goto, { waitUntil: "domcontentloaded", timeout: 45_000 }); return page.url(); }
  if (action.click) { await locate(action.click).click({ timeout: action.timeout ?? 8000 }); return "clicked"; }
  if (action.hover) { await locate(action.hover).hover(); return "hovered"; }
  if (action.fill) { await locate(action.fill.target).fill(String(action.fill.value)); return "filled"; }
  if (action.type) { await locate(action.type.target).pressSequentially(String(action.type.value), { delay: 60 }); return "typed"; }
  if (action.press) { await page.keyboard.press(action.press); return "pressed"; }
  if (action.wait) { await page.waitForTimeout(action.wait); return "waited"; }
  if (action.waitFor) { await locate(action.waitFor).waitFor({ state: action.state ?? "visible", timeout: action.timeout ?? 15000 }); return "appeared"; }
  if (action.dump) return dump(action.dump === true ? "body" : action.dump);
  if (action.text) return (await page.locator(action.text === true ? "body" : action.text).first().innerText()).slice(0, action.max ?? 6000);
  if (action.html) return (await page.locator(action.html).first().evaluate((e) => e.outerHTML)).slice(0, action.max ?? 8000);
  if (action.eval) return page.evaluate(action.eval);
  if (action.call) {
    // load the project module dynamically (with a timestamp to bypass the cache) and call fn(page, ...args)
    const mod = await import(new URL(`../${action.call.module}?t=${Date.now()}`, import.meta.url));
    const args = action.call.args ?? [];
    return action.call.page === false ? mod[action.call.fn](...args) : mod[action.call.fn](page, ...args);
  }
  if (action.count) return page.locator(action.count).count();
  throw new Error("Unknown action: " + JSON.stringify(action));
}

/** Main loop: poll for the next command file, run it, then write the result and screenshot. */
async function loop() {
  for (;;) {
    const cmdFile = join(DIR, `cmd-${n}.json`);
    if (!existsSync(cmdFile)) { await new Promise((r) => setTimeout(r, 700)); continue; }
    let cmd;
    try { cmd = JSON.parse(await readFile(cmdFile, "utf8")); } catch { await new Promise((r) => setTimeout(r, 300)); continue; }
    if (cmd.exit) break;
    const results = [];
    for (const action of cmd.actions ?? []) {
      try { results.push({ action, ok: true, result: await run(action) }); }
      catch (error) { results.push({ action, ok: false, error: String(error.message).split("\n").slice(0, 3).join(" | ") }); if (cmd.stopOnError !== false) break; }
    }
    await page.waitForTimeout(cmd.settle ?? 800);
    if (cmd.screenshot !== false) await page.screenshot({ path: join(DIR, `out-${n}.png`), fullPage: !!cmd.fullPage }).catch(() => {});
    await writeFile(join(DIR, `out-${n}.json`), JSON.stringify({ n, url: page.url(), title: await page.title(), results }, null, 2));
    console.log(`Finished command ${n}`);
    n += 1;
  }
}

try { await loop(); } finally {
  await rm(join(DIR, "ready.json"), { force: true });
  await closeUmushroomSession();
  console.log("Explore helper exited.");
}
