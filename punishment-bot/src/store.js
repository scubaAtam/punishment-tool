// Tiny JSON-file store for the pending-revert queue.
// Roblox is the source of truth for the punishment records themselves (it keeps them
// in a DataStore). The bot only needs to durably remember which reverts are waiting
// for the game to pick up. Point DATA_DIR at a Railway Volume so this survives redeploys.

import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FILE = path.join(DATA_DIR, "store.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ pendingReverts: [] }, null, 2));
  }
}

function read() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { pendingReverts: [] };
  }
}

function write(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// Add a revert to the queue (idempotent on id).
export function queueRevert(id, meta) {
  const d = read();
  if (!d.pendingReverts.find((r) => r.id === id)) {
    d.pendingReverts.push({ id, meta, queuedAt: Date.now() });
    write(d);
    return true; // newly queued
  }
  return false; // already pending
}

export function getPending() {
  return read().pendingReverts;
}

// Remove reverts the game has confirmed it applied.
export function ackReverts(ids) {
  const d = read();
  d.pendingReverts = d.pendingReverts.filter((r) => !ids.includes(r.id));
  write(d);
}
