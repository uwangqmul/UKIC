// =============================================================================
// Order locks: never order the same stock twice when it is unclear whether an earlier order went through
// -----------------------------------------------------------------------------
// Just before the final Add / Sell click a "submitting" lock is written for the stock; it is removed once the site
// confirms the order (or the click provably never happened). If the confirmation never arrives, or the process stops
// between the click and the confirmation, the lock stays ("unconfirmed" / "submitting") and every further submit for
// that stock is refused until someone has checked Pending Orders / History on UMushroom and cleared the lock:
//   npm run unlock              list the locks
//   npm run unlock -- <key>     clear one lock (key = the stock's equity address slug, e.g. aapl-apple)
//   npm run unlock -- all       clear every lock
// Previews (submit=false) are never blocked, they place no order.
// Writes are serialised within one process (all trading runs in one process: the MCP server, or one npm run command).
// Storage: logs\order-locks.json  { <key>: { state, side, stock, portfolio, shares, amount, at, reason? } }
// =============================================================================
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "./config.js";

const lockFile = () => join(PATHS.logs, "order-locks.json");
let writeQueue = Promise.resolve(); // serialise writes so concurrent changes do not overwrite each other

/**
 * Read all locks ({} if the file does not exist). A file that cannot be parsed throws instead of reading as "no locks":
 * failing open would silently unlock every stock. `npm run unlock -- all` resets such a file.
 */
export async function readLocks() {
  let text;
  try { text = await readFile(lockFile(), "utf8"); } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  try {
    const locks = JSON.parse(text || "{}");
    if (locks && typeof locks === "object" && !Array.isArray(locks)) return locks;
  } catch { /* reported below */ }
  throw Object.assign(new Error(`The order lock file ${lockFile()} is damaged, so no order is submitted. ` +
    "Check it (or Pending Orders / History on UMushroom), then reset it with: npm run unlock -- all"), { code: "ORDER_LOCKED" });
}

/** Change the locks: mutate(locks) edits the object in place; it is then written back. reset=true starts from {} (used by unlock all). */
function updateLocks(mutate, { reset = false } = {}) {
  const run = writeQueue.then(async () => {
    const locks = reset ? {} : await readLocks();
    const result = await mutate(locks);
    await mkdir(PATHS.logs, { recursive: true });
    // Write a temp file and rename it over the lock file, so a crash mid-write never leaves a half-written (damaged) file
    const temp = `${lockFile()}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(locks, null, 2), "utf8");
    try { await rename(temp, lockFile()); } catch {
      // Windows can refuse the rename briefly (e.g. antivirus holding the file); fall back to writing in place
      await writeFile(lockFile(), JSON.stringify(locks, null, 2), "utf8");
      await unlink(temp).catch(() => {});
    }
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

/** The error shown when a stock is locked. */
function lockedError(key, lock) {
  return Object.assign(new Error(
    `Not submitted: the earlier ${lock.side ?? "order"} of ${lock.stock ?? key} (${lock.at}) was never confirmed by UMushroom, ` +
    `so it may already have been placed. New orders for this stock are blocked so it is not ordered twice. ` +
    `Check Pending Orders / History of the portfolio on UMushroom, then clear the lock with: npm run unlock -- ${key}`),
  { code: "ORDER_LOCKED", lock: { key, ...lock } });
}

/** Throw if the stock has an unresolved order. */
export async function assertUnlocked(key) {
  const lock = (await readLocks())[key];
  if (lock) throw lockedError(key, lock);
}

/** Right before the final click: check the stock is not locked and record the order as "submitting" (one atomic step). */
export function beginOrder(order) {
  return updateLocks((locks) => {
    if (locks[order.key]) throw lockedError(order.key, locks[order.key]);
    const { key, ...info } = order;
    locks[key] = { state: "submitting", ...info, at: new Date().toISOString() };
  });
}

/** The site confirmed the order, or the click never happened: remove the lock. */
export function finishOrder(key) {
  return updateLocks((locks) => { delete locks[key]; });
}

/** No confirmation after the click: keep the stock locked until someone checks it. */
export function markUnconfirmed(key, reason) {
  return updateLocks((locks) => {
    locks[key] = { ...locks[key], state: "unconfirmed", reason, unconfirmedAt: new Date().toISOString() };
  });
}

/** Clear one lock, or all of them with "all" (which also resets a damaged lock file); returns the keys that were cleared. */
export async function clearLocks(key) {
  if (key === "all") {
    const before = await readLocks().catch(() => ({ "(damaged lock file)": {} }));
    await updateLocks(() => {}, { reset: true });
    return Object.keys(before);
  }
  return updateLocks((locks) => {
    const keys = Object.keys(locks).filter((k) => k === key);
    for (const k of keys) delete locks[k];
    return keys;
  });
}

/** The guard passed to buyStock / sellStock (options.guard) by every entry point that can submit orders. */
export const orderGuard = Object.freeze({ assertUnlocked, beginOrder, finishOrder, markUnconfirmed });
