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
      JSON.stringify(
        { nextId: 1, records: {}, pendingReverts: [], toolState: {}, admins: [] },
        null,
        2
      )
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
    d.toolState ??= {};
    d.admins ??= [];
    return d;
  } catch {
    return { nextId: 1, records: {}, pendingReverts: [], toolState: {}, admins: [] };
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

// Tool/team suspensions for a user that are still active (not reverted, not expired).
// expiresAt is an absolute unix-seconds timestamp the game sent when the ban was issued,
// so a ban keeps counting down while the player is offline.
export function getActiveBans(userId) {
  const d = read();
  const now = Date.now() / 1000;
  const uid = Number(userId);
  return Object.values(d.records)
    .filter(
      (r) =>
        (r.type === "tool" || r.type === "team") &&
        !r.reverted &&
        Number(r.targetUserId) === uid &&
        typeof r.expiresAt === "number" &&
        r.expiresAt > now
    )
    .map((r) => ({ id: r.id, type: r.type, expiresAt: r.expiresAt }));
}

// ---------------------------------------------------------------------------
// Officer tool-state: strikes + a ban from using the punishment tool itself.
// Keyed by Roblox userId. banUntil: null = no ban, -1 = permanent, or a future
// unix-seconds timestamp = timed suspension. 3 strikes also blocks the tool.
// ---------------------------------------------------------------------------
function blankTool(username) {
  return { strikes: 0, banUntil: null, username: username || null };
}

// Computed status the game + UI consume.
export function getToolStatus(userId) {
  const t = read().toolState[String(userId)] || blankTool();
  const now = Date.now() / 1000;
  let banUntil = t.banUntil;
  if (typeof banUntil === "number" && banUntil > 0 && banUntil <= now) banUntil = null; // expired

  const banned = banUntil === -1;
  const timedSuspended = typeof banUntil === "number" && banUntil > now;
  const strikeSuspended = (t.strikes || 0) >= 3;

  let state = "ok";
  let detail = "";
  let remaining = 0;
  if (banned) {
    state = "banned";
    detail = "permanent";
  } else if (timedSuspended) {
    state = "suspended";
    detail = "timed";
    remaining = Math.max(0, Math.floor(banUntil - now));
  } else if (strikeSuspended) {
    state = "suspended";
    detail = "strikes";
  }
  return {
    usable: state === "ok",
    state,
    detail,
    remaining,
    strikes: t.strikes || 0,
    username: t.username || null,
  };
}

export function setToolBan(userId, banUntil, username) {
  const d = read();
  const key = String(userId);
  const t = d.toolState[key] || blankTool(username);
  t.banUntil = banUntil; // -1 permanent or a future timestamp
  if (username) t.username = username;
  d.toolState[key] = t;
  write(d);
  return t;
}

// Lift any tool ban, and clear a maxed-out (3) strike suspension by resetting to 0.
export function clearToolBlock(userId) {
  const d = read();
  const key = String(userId);
  const t = d.toolState[key] || blankTool();
  t.banUntil = null;
  if ((t.strikes || 0) >= 3) t.strikes = 0;
  d.toolState[key] = t;
  write(d);
  return t;
}

export function addStrike(userId, username) {
  const d = read();
  const key = String(userId);
  const t = d.toolState[key] || blankTool(username);
  t.strikes = Math.min(3, (t.strikes || 0) + 1);
  if (username) t.username = username;
  d.toolState[key] = t;
  write(d);
  return t.strikes;
}

export function removeStrike(userId) {
  const d = read();
  const key = String(userId);
  const t = d.toolState[key] || blankTool();
  t.strikes = Math.max(0, (t.strikes || 0) - 1);
  d.toolState[key] = t;
  write(d);
  return t.strikes;
}

// ---- Bot command admins (Discord user IDs allowed to run commands) ----
export function isAdmin(discordId) {
  return read().admins.includes(String(discordId));
}
export function addAdmin(discordId) {
  const d = read();
  const id = String(discordId);
  if (!d.admins.includes(id)) {
    d.admins.push(id);
    write(d);
  }
}
export function removeAdmin(discordId) {
  const d = read();
  d.admins = d.admins.filter((x) => x !== String(discordId));
  write(d);
}
export function listAdmins() {
  return read().admins;
}
