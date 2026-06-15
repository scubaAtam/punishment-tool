// Durable store for punishment records + the pending-revert queue.
// The bot is the source of truth: it assigns each punishment its number, keeps the
// record, and (for citations) queues a refund for the game to pick up.
// Point DATA_DIR at a Railway Volume so this survives redeploys.

import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FILE = path.join(DATA_DIR, "store.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(
      FILE,
      JSON.stringify({ nextId: 1, records: {}, pendingReverts: [] }, null, 2)
    );
  }
}

function read() {
  ensure();
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    d.nextId ??= 1;
    d.records ??= {};
    d.pendingReverts ??= [];
    return d;
  } catch {
    return { nextId: 1, records: {}, pendingReverts: [] };
  }
}

function write(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// Store a new punishment, return its assigned number.
export function addRecord(record) {
  const d = read();
  const id = d.nextId;
  d.nextId = id + 1;
  d.records[String(id)] = { ...record, id, reverted: false, createdAt: Date.now() };
  write(d);
  return id;
}

export function getRecord(id) {
  return read().records[String(id)] || null;
}

// Mark a record reverted. Returns the record, or null if it doesn't exist.
export function markReverted(id, meta) {
  const d = read();
  const r = d.records[String(id)];
  if (!r) return null;
  r.reverted = true;
  r.revertMeta = meta;
  write(d);
  return r;
}

// Queue an in-game revert (used for citations, which need a rublex refund).
export function queueRevert(entry) {
  const d = read();
  if (!d.pendingReverts.find((x) => x.id === entry.id)) {
    d.pendingReverts.push({ ...entry, queuedAt: Date.now() });
    write(d);
  }
}

export function getPending() {
  return read().pendingReverts;
}

export function ackReverts(ids) {
  const d = read();
  d.pendingReverts = d.pendingReverts.filter((r) => !ids.includes(r.id));
  write(d);
}
