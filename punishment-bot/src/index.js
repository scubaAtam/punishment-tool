import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import {
  addRecord,
  getRecord,
  markReverted,
  queueRevert,
  getPending,
  ackReverts,
} from "./store.js";

const {
  DISCORD_TOKEN,
  GUILD_ID,
  LOG_CHANNEL_ID,
  REVERT_ROLE_ID,
  SHARED_SECRET,
  PORT = 3000,
} = process.env;

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

const revertCommand = new SlashCommandBuilder()
  .setName("revert")
  .setDescription("Revert a punishment by its number.")
  .addIntegerOption((o) =>
    o
      .setName("number")
      .setDescription("The punishment number from the log embed")
      .setRequired(true)
      .setMinValue(1)
  )
  .addStringOption((o) =>
    o.setName("reason").setDescription("Why you're reverting it")
  )
  .toJSON();

async function postToLog(payload) {
  if (!LOG_CHANNEL_ID) return;
  const channel = await client.channels.fetch(LOG_CHANNEL_ID);
  return channel.send(payload);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    if (GUILD_ID) await c.application.commands.set([revertCommand], GUILD_ID);
    else await c.application.commands.set([revertCommand]);
    console.log("Slash command /revert registered.");
  } catch (e) {
    console.error("Failed to register commands:", e);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== "revert") return;

  // Permission: server admins, anyone with Kick Members, or the configured role.
  const roleId = (REVERT_ROLE_ID || "").trim();
  const hasRole = roleId ? i.member.roles.cache.has(roleId) : false;
  const isMod =
    i.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    i.memberPermissions?.has(PermissionFlagsBits.KickMembers) ||
    false;

  if (!hasRole && !isMod) {
    console.log(
      `[revert] DENIED ${i.user.tag} — their role IDs: [${[...i.member.roles.cache.keys()].join(", ")}] | configured REVERT_ROLE_ID: "${roleId}"`
    );
    return i.reply({
      content: "❌ You don't have permission to revert punishments.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const number = i.options.getInteger("number");
  const reason = i.options.getString("reason") ?? "No reason given";

  const record = getRecord(number);
  if (!record) {
    return i.reply({
      content: `❓ No punishment **#${number}** found.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (record.reverted) {
    return i.reply({
      content: `ℹ️ Punishment **#${number}** was already reverted.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  markReverted(number, { by: i.user.tag, byId: i.user.id, reason });

  if (record.type === "citation") {
    queueRevert({
      id: record.id,
      targetUserId: record.targetUserId,
      amount: record.amount || 0,
    });
    await i.reply(
      `↩️ Reverting citation **#${number}** for **${record.targetName}** — refunding **${record.amount} rublex** in-game (live if they're online, otherwise next time they join).\nReason: ${reason}`
    );
  } else {
    await i.reply(
      `↩️ Marked punishment **#${number}** (${record.type}) as reverted. (No in-game refund applies to this type.)\nReason: ${reason}`
    );
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

// Roblox -> bot: which citation reverts are waiting to be applied in-game?
app.get("/pending", auth, (_req, res) => {
  res.json({ pending: getPending() });
});

// Roblox -> bot: these revert ids were applied in-game; clear them.
app.post("/ack", auth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  ackReverts(ids);
  if (ids.length) {
    try {
      await postToLog(`✅ In-game refund applied for ${ids.map((n) => `#${n}`).join(", ")}.`);
    } catch {
      /* non-fatal */
    }
  }
  res.json({ ok: true, acked: ids });
});

app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));
