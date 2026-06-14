# Punishment Bot

Discord bot for the Roblox "punishment tool". It:

- receives punishment logs from the Roblox game and posts them as embeds in a channel, and
- accepts `/revert <number>` in Discord and queues the revert for the game to apply.

The Roblox game talks to this bot over HTTP (it sends logs and polls for pending reverts),
so the bot just needs to run 24/7 with a public URL.

---

## What you need (IDs & secrets)

| Variable | Where to get it |
| --- | --- |
| `DISCORD_TOKEN` | Developer Portal → your app → **Bot** → Reset Token |
| `CLIENT_ID` | Developer Portal → **General Information** → Application ID |
| `GUILD_ID` | Right-click your server → Copy ID (Developer Mode on) |
| `LOG_CHANNEL_ID` | Right-click the log channel → Copy ID |
| `REVERT_ROLE_ID` | Right-click the officer/admin role → Copy ID (optional but recommended) |
| `SHARED_SECRET` | Invent a long random string. Roblox will send this same value. |

---

## Deploy on Railway (no terminal needed)

1. Put this folder on GitHub (create a repo at github.com, then upload these files —
   you can drag the whole folder into the web uploader).
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** → pick the repo.
3. Open the service → **Variables** → add every variable from `.env.example`
   (except `PORT`, which Railway sets for you).
4. **Storage**: add a **Volume**, mount path `/data`, then set variable `DATA_DIR=/data`
   so the revert queue survives redeploys.
5. **Settings → Networking → Generate Domain**. Copy that `https://…up.railway.app` URL —
   that's what Roblox will call.
6. Wait for the deploy to go green. In the logs you should see
   `Logged in as <bot>` and `Web server listening on port …`.

Visiting the domain in a browser should show **"Punishment bot is running."**

---

## Test it before wiring Roblox

- In Discord, type `/revert 1` → the bot should reply that it queued the revert.
- Fake a log post (replace URL + secret):

  ```
  curl -X POST https://YOUR-APP.up.railway.app/log \
    -H "Authorization: Bearer YOUR_SHARED_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"id":1,"type":"citation","officerName":"Vlad","officerUserId":1,"targetName":"Bob","targetUserId":2,"detail":"250 rublex — test"}'
  ```

  → an embed should appear in your log channel.

---

## Local testing (optional)

```
npm install
copy .env.example .env   # then fill in .env
npm start
```
