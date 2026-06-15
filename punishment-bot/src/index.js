import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import {
  addRecord,
  getRecord,
  markReverted,
  queueRevert,
  getPending,
  ackReverts,
  getActiveBans,
  getToolStatus,
  setToolBan,
  clearToolBlock,
  addStrike,
  removeStrike,
  isAdmin,
  addAdmin,
  removeAdmin,
  listAdmins,
} from "./store.js";

const { DISCORD_TOKEN, GUILD_ID, LOG_CHANNEL_ID, SHARED_SECRET, PORT = 3000 } =
  process.env;

// The one Discord user who can manage who else may use the bot.
const OWNER_ID = "723121883272183858";

// ----------------------------------------------------------------------------
// Discord client
// ----------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const TYPE_COLORS = {
  citation: 0xe0a21a,
  warn: 0xe0a21a,
  kick: 0xd83c3c,
  tool: 0x5865f2,
  team: 0x5865f2,
};
const DEFAULT_COLOR = 0x2b2d31;

// ----------------------------------------------------------------------------
// Slash commands
// ----------------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName("revert")
    .setDescription("Revert a punishment by its number.")
    .addIntegerOption((o) =>
      o.setName("number").setDescription("The punishment number from the log embed").setRequired(true).setMinValue(1)
    )
    .addStringOption((o) => o.setName("reason").setDescription("Why you're reverting it"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("rublex")
    .setDescription("Give or remove rublex from a Roblox user (applies in-game).")
    .addStringOption((o) => o.setName("user").setDescription("Roblox username").setRequired(true))
    .addStringOption((o) =>
      o.setName("action").setDescription("add or remove").setRequired(true).addChoices(
        { name: "add", value: "add" },
        { name: "remove", value: "remove" }
      )
    )
    .addIntegerOption((o) => o.setName("amount").setDescription("How much rublex").setRequired(true).setMinValue(1))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("tban")
    .setDescription("Ban a Roblox user from using the punishment tool.")
    .addStringOption((o) => o.setName("user").setDescription("Roblox username").setRequired(true))
    .addStringOption((o) => o.setName("duration").setDescription("Optional e.g. 2h, 30m, 7d (blank = permanent)"))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("tpardon")
    .setDescription("Lift a tool ban / strike suspension (resets 3 strikes to 0).")
    .addStringOption((o) => o.setName("user").setDescription("Roblox username").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("strike")
    .setDescription("Give a Roblox user one tool strike (3 = suspended).")
    .addStringOption((o) => o.setName("user").setDescription("Roblox username").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("unstrike")
    .setDescription("Remove one tool strike from a Roblox user.")
    .addStringOption((o) => o.setName("user").setDescription("Roblox username").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("toolstatus")
    .setDescription("Check a Roblox user's tool access + strikes.")
    .addStringOption((o) => o.setName("user").setDescription("Roblox username").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("adminadd")
    .setDescription("(Owner only) Let a Discord user run the bot commands.")
    .addStringOption((o) => o.setName("discorduserid").setDescription("Discord user ID").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("adminremove")
    .setDescription("(Owner only) Revoke a Discord user's bot access.")
    .addStringOption((o) => o.setName("discorduserid").setDescription("Discord user ID").setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName("admins")
    .setDescription("(Owner only) List who can use the bot commands.")
    .toJSON(),
];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
async function postToLog(payload) {
  if (!LOG_CHANNEL_ID) return;
  const channel = await client.channels.fetch(LOG_CHANNEL_ID);
  return channel.send(payload);
}

function actionEmbed(title, color, fields, footer) {
  const e = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp(Date.now());
  if (fields) e.addFields(fields);
  if (footer) e.setFooter({ text: footer });
  return e;
}

// Resolve a Roblox username to { id, name } using the public Roblox API.
async function resolveRobloxUser(name) {
  try {
    const r = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const u = j?.data?.[0];
    return u ? { id: u.id, name: u.name } : null;
  } catch {
    return null;
  }
}

// For a deferred interaction: resolve the "user" option or editReply an error.
async function resolveOrFail(i, raw) {
  const name = String(raw || "").trim();
  const u = await resolveRobloxUser(name);
  if (!u) {
    await i.editReply(`❓ Couldn't find a Roblox user named **${name}**.`);
    return null;
  }
  return u;
}

// "2h" / "30m" / "7d" / "90s" / "45" (default seconds) -> seconds, or null.
function parseDuration(s) {
  const m = String(s || "").trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || "s").toLowerCase()];
  return n * mult;
}

function humanizeSecs(secs) {
  secs = Math.floor(secs);
  const d = Math.floor(secs / 86400);
  secs %= 86400;
  const h = Math.floor(secs / 3600);
  secs %= 3600;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const parts = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  if (s && !d && !h) parts.push(s + "s");
  return parts.length ? parts.join(" ") : "0s";
}

function canUseCommands(i) {
  return i.user.id === OWNER_ID || isAdmin(i.user.id);
}

// ----------------------------------------------------------------------------
// Command handlers
// ----------------------------------------------------------------------------
async function handleRevert(i) {
  const number = i.options.getInteger("number");
  const reason = i.options.getString("reason") ?? "No reason given";
  const record = getRecord(number);
  if (!record) {
    return i.reply({ content: `❓ No punishment **#${number}** found.`, flags: MessageFlags.Ephemeral });
  }
  if (record.reverted) {
    return i.reply({ content: `ℹ️ Punishment **#${number}** was already reverted.`, flags: MessageFlags.Ephemeral });
  }
  markReverted(number, { by: i.user.tag, byId: i.user.id, reason });

  if (record.type === "citation") {
    queueRevert({ id: record.id, type: "citation", targetUserId: record.targetUserId, amount: record.amount || 0 });
    return i.reply(
      `↩️ Reverting citation **#${number}** for **${record.targetName}** — refunding **${record.amount} rublex** in-game (live if online, otherwise next join).\nReason: ${reason}`
    );
  }
  if (record.type === "tool" || record.type === "team") {
    queueRevert({ id: record.id, type: record.type, targetUserId: record.targetUserId });
    return i.reply(
      `↩️ Reverting the **${record.type} suspension #${number}** for **${record.targetName}** — lifted in-game (live if online; otherwise not re-applied next join).\nReason: ${reason}`
    );
  }
  return i.reply(
    `↩️ Marked punishment **#${number}** (${record.type}) as reverted. (No in-game action applies to this type.)\nReason: ${reason}`
  );
}

async function handleRublex(i) {
  await i.deferReply();
  const u = await resolveOrFail(i, i.options.getString("user"));
  if (!u) return;
  const action = i.options.getString("action");
  const amount = i.options.getInteger("amount");
  const delta = action === "remove" ? -amount : amount;
  const id = addRecord({
    type: "rublex",
    officerName: i.user.tag,
    officerUserId: null,
    targetName: u.name,
    targetUserId: u.id,
    amount: delta,
    detail: `${action === "remove" ? "Removed" : "Added"} ${amount} rublex (by ${i.user.tag})`,
  });
  queueRevert({ id, type: "rublex", targetUserId: u.id, amount: delta });
  await postToLog({
    embeds: [
      actionEmbed(`💸 Rublex #${id} — ${action.toUpperCase()}`, 0x2ecc71, [
        { name: "User", value: `${u.name} (\`${u.id}\`)`, inline: true },
        { name: "Amount", value: `${delta > 0 ? "+" : ""}${delta} rublex`, inline: true },
        { name: "By", value: i.user.tag },
      ]),
    ],
  });
  await i.editReply(
    `💸 ${action === "remove" ? "Removing" : "Adding"} **${amount} rublex** ${action === "remove" ? "from" : "to"} **${u.name}** — applied in-game (live if online, otherwise next join).`
  );
}

async function handleTban(i) {
  await i.deferReply();
  const u = await resolveOrFail(i, i.options.getString("user"));
  if (!u) return;
  const durStr = i.options.getString("duration");
  let banUntil = -1;
  let label = "permanently";
  if (durStr) {
    const secs = parseDuration(durStr);
    if (!secs) {
      await i.editReply("⚠️ Bad duration — use like `2h`, `30m`, `7d`, or `90s`.");
      return;
    }
    banUntil = Math.floor(Date.now() / 1000) + secs;
    label = `for ${humanizeSecs(secs)}`;
  }
  setToolBan(u.id, banUntil, u.name);
  const id = addRecord({
    type: "tban",
    officerName: i.user.tag,
    targetName: u.name,
    targetUserId: u.id,
    detail: `Tool-banned ${label} (by ${i.user.tag})`,
  });
  await postToLog({
    embeds: [
      actionEmbed(
        `⛔ Tool Ban #${id}`,
        0xe67e22,
        [
          { name: "User", value: `${u.name} (\`${u.id}\`)`, inline: true },
          { name: "Length", value: durStr ? humanizeSecs(parseDuration(durStr)) : "permanent", inline: true },
          { name: "By", value: i.user.tag },
        ],
        `Lift with /tpardon ${u.name}`
      ),
    ],
  });
  await i.editReply(`⛔ **${u.name}** is now banned from the punishment tool ${label}. Lift it with \`/tpardon\`.`);
}

async function handleTpardon(i) {
  await i.deferReply();
  const u = await resolveOrFail(i, i.options.getString("user"));
  if (!u) return;
  const before = getToolStatus(u.id);
  if (before.usable) {
    await i.editReply(`ℹ️ **${u.name}** isn't banned or suspended — nothing to pardon. (Strikes: ${before.strikes}/3)`);
    return;
  }
  clearToolBlock(u.id);
  const note = before.detail === "strikes" ? " and reset their strikes to 0" : "";
  const id = addRecord({
    type: "tpardon",
    officerName: i.user.tag,
    targetName: u.name,
    targetUserId: u.id,
    detail: `Pardoned (was ${before.state})${note} (by ${i.user.tag})`,
  });
  await postToLog({
    embeds: [
      actionEmbed(`✅ Tool Pardon #${id}`, 0x2ecc71, [
        { name: "User", value: `${u.name} (\`${u.id}\`)`, inline: true },
        { name: "By", value: i.user.tag, inline: true },
      ]),
    ],
  });
  await i.editReply(`✅ Pardoned **${u.name}** — lifted their tool ${before.state}${note}. They can use the tool again.`);
}

async function handleStrike(i) {
  await i.deferReply();
  const u = await resolveOrFail(i, i.options.getString("user"));
  if (!u) return;
  const n = addStrike(u.id, u.name);
  const id = addRecord({
    type: "strike",
    officerName: i.user.tag,
    targetName: u.name,
    targetUserId: u.id,
    detail: `Strike ${n}/3 (by ${i.user.tag})`,
  });
  await postToLog({
    embeds: [
      actionEmbed(`⚠️ Strike #${id} — ${n}/3`, 0xf1c40f, [
        { name: "User", value: `${u.name} (\`${u.id}\`)`, inline: true },
        { name: "Strikes", value: `${n}/3`, inline: true },
        { name: "By", value: i.user.tag },
      ]),
    ],
  });
  await i.editReply(`⚠️ **${u.name}** now has **${n}/3** strikes${n >= 3 ? " — they're tool-suspended until `/tpardon`." : "."}`);
}

async function handleUnstrike(i) {
  await i.deferReply();
  const u = await resolveOrFail(i, i.options.getString("user"));
  if (!u) return;
  const n = removeStrike(u.id);
  const id = addRecord({
    type: "unstrike",
    officerName: i.user.tag,
    targetName: u.name,
    targetUserId: u.id,
    detail: `Strike removed -> ${n}/3 (by ${i.user.tag})`,
  });
  await postToLog({
    embeds: [
      actionEmbed(`➖ Strike removed #${id} — ${n}/3`, 0xf1c40f, [
        { name: "User", value: `${u.name} (\`${u.id}\`)`, inline: true },
        { name: "Strikes", value: `${n}/3`, inline: true },
        { name: "By", value: i.user.tag },
      ]),
    ],
  });
  await i.editReply(`➖ Removed a strike from **${u.name}** — now **${n}/3**.`);
}

async function handleToolStatus(i) {
  await i.deferReply();
  const u = await resolveOrFail(i, i.options.getString("user"));
  if (!u) return;
  const st = getToolStatus(u.id);
  let line;
  if (st.usable) line = "✅ can use the tool";
  else if (st.state === "banned") line = "⛔ tool banned (permanent)";
  else if (st.detail === "timed") line = `⛔ tool suspended — ${humanizeSecs(st.remaining)} left`;
  else line = "⛔ tool suspended (3 strikes)";
  await i.editReply(`**${u.name}** (\`${u.id}\`)\n${line}\nStrikes: **${st.strikes}/3**`);
}

// ----------------------------------------------------------------------------
// Interaction routing
// ----------------------------------------------------------------------------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  const name = i.commandName;
  try {
    // Owner-only: managing who can use the bot.
    if (name === "adminadd" || name === "adminremove" || name === "admins") {
      if (i.user.id !== OWNER_ID) {
        return i.reply({ content: "❌ Only the bot owner can manage admins.", flags: MessageFlags.Ephemeral });
      }
      if (name === "admins") {
        const list = listAdmins();
        return i.reply({
          content: list.length
            ? `**Bot admins:**\n${list.map((id) => `• <@${id}> (\`${id}\`)`).join("\n")}\n(Owner <@${OWNER_ID}> always has access.)`
            : `No extra admins yet. Only the owner <@${OWNER_ID}> can use the commands. Add one with \`/adminadd\`.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const id = i.options.getString("discorduserid").trim();
      if (!/^\d{5,20}$/.test(id)) {
        return i.reply({ content: "⚠️ That doesn't look like a Discord user ID (numbers only).", flags: MessageFlags.Ephemeral });
      }
      if (name === "adminadd") {
        addAdmin(id);
        return i.reply(`✅ <@${id}> (\`${id}\`) can now use the bot commands.`);
      }
      removeAdmin(id);
      return i.reply(`✅ Removed <@${id}> (\`${id}\`) from the bot admins.`);
    }

    // Everything else needs command access.
    if (!canUseCommands(i)) {
      return i.reply({
        content: "❌ You don't have access to this bot. Ask the owner to `/adminadd` your Discord ID.",
        flags: MessageFlags.Ephemeral,
      });
    }

    switch (name) {
      case "revert": await handleRevert(i); break;
      case "rublex": await handleRublex(i); break;
      case "tban": await handleTban(i); break;
      case "tpardon": await handleTpardon(i); break;
      case "strike": await handleStrike(i); break;
      case "unstrike": await handleUnstrike(i); break;
      case "toolstatus": await handleToolStatus(i); break;
    }
  } catch (e) {
    console.error(`command ${name} error:`, e);
    const msg = "⚠️ Something went wrong running that command.";
    if (i.deferred) i.editReply(msg).catch(() => {});
    else if (!i.replied) i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    if (GUILD_ID) await c.application.commands.set(commands, GUILD_ID);
    else await c.application.commands.set(commands);
    console.log(`Registered ${commands.length} slash commands.`);
  } catch (e) {
    console.error("Failed to register commands:", e);
  }
});

client.login(DISCORD_TOKEN);

// ----------------------------------------------------------------------------
// Web server — the Roblox game talks to this
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json());

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!SHARED_SECRET || token !== SHARED_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/", (_req, res) => res.send("Punishment bot is running."));

// Roblox -> bot: a punishment happened. Assign a number, store it, post an embed.
app.post("/log", auth, async (req, res) => {
  const p = req.body || {};
  try {
    const id = addRecord({
      type: p.type,
      officerName: p.officerName,
      officerUserId: p.officerUserId,
      targetName: p.targetName,
      targetUserId: p.targetUserId,
      amount: p.amount,
      detail: p.detail,
      expiresAt: p.expiresAt,
    });

    const embed = new EmbedBuilder()
      .setTitle(`📋 Punishment #${id} — ${String(p.type || "action").toUpperCase()}`)
      .setColor(TYPE_COLORS[p.type] ?? DEFAULT_COLOR)
      .addFields(
        { name: "Officer", value: `${p.officerName} (\`${p.officerUserId}\`)`, inline: true },
        { name: "Target", value: `${p.targetName} (\`${p.targetUserId}\`)`, inline: true },
        { name: "Details", value: p.detail ? String(p.detail) : "—" }
      )
      .setFooter({ text: `Use /revert ${id} to undo this` })
      .setTimestamp(p.timestamp ? Number(p.timestamp) * 1000 : Date.now());

    await postToLog({ embeds: [embed] });
    res.json({ ok: true, id });
  } catch (e) {
    console.error("/log error:", e);
    res.status(500).json({ error: "failed to log" });
  }
});

// Roblox -> bot: which in-game actions (reverts, rublex grants) are waiting?
app.get("/pending", auth, (_req, res) => {
  res.json({ pending: getPending() });
});

// Roblox -> bot (on join): which tool/team suspensions are still active for this user?
app.get("/active", auth, (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ active: [] });
  res.json({ active: getActiveBans(userId) });
});

// Roblox -> bot: an officer's tool access + strikes (read on equip / poll).
app.get("/toolstate", auth, (req, res) => {
  res.json(getToolStatus(req.query.userId || 0));
});

// Roblox -> bot: these queued action ids were applied in-game; clear them.
app.post("/ack", auth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  ackReverts(ids);
  if (ids.length) {
    try {
      await postToLog(`✅ In-game action applied for ${ids.map((n) => `#${n}`).join(", ")}.`);
    } catch {
      /* non-fatal */
    }
  }
  res.json({ ok: true, acked: ids });
});

app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
