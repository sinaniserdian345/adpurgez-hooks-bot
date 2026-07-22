# Adpurgez Hooks — Discord bot

Drop TikTok screenshots into Discord (a DM to the bot, or a chosen channel) and it forwards each
one to your Adpurgez **Hooks** ingestion endpoint. Adpurgez runs its vision model on every new
screenshot and extracts the hook text, proof, caption, creator, engagement, verdict, and media
type — you just review them in the Hooks tab. Screenshots only; no links needed.

The bot sends one screenshot per request as `image_b64` + `image_content_type`, authenticated with
your ingestion key as a Bearer token. It replies with `✅ saved as hook #123`, `♻️ already saved`
(the server de-dupes on the SHA-256 of the image), or a short reason if something was skipped.

## What it can't run on
This is an always-on process (a live Discord gateway connection), so it **cannot** run on your
Hostinger shared hosting. Run it on your own machine, a small VPS, or a free always-on host like
Railway, Render, or Fly.io. Nothing here gets uploaded to `public_html`.

## Setup

### 1. Create the Discord bot
1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it → that's `DISCORD_TOKEN`.
3. Still on the **Bot** tab, turn on **Message Content Intent** (required to read image attachments in a channel; DMs work without it, but keep it on).

### 2. Invite it to a server
1. **OAuth2 → URL Generator** → scopes: `bot`. Bot permissions: **Send Messages**, **Read Message History**, **Add Reactions**.
2. Open the generated URL, add the bot to a server you own. (You need a shared server before you can DM the bot.)

### 3. Get your Adpurgez ingestion key
In Adpurgez → **Hooks** tab → generate a bot/ingestion key and copy it. Paste it into
`ADPURGEZ_INGEST_KEY`. Keep it secret — anyone with the key can add to your Hooks and burn your
500/hour quota. You can revoke and re-issue it in the same place.

### 4. Configure and run
```bash
cp .env.example .env      # then fill in DISCORD_TOKEN and ADPURGEZ_INGEST_KEY
npm install
npm start
```
Strongly recommended: set `ALLOWED_USER_IDS` (your own Discord user ID) and/or `ALLOWED_CHANNEL_ID`
so only you can feed it. To get an ID, enable Discord → Settings → Advanced → **Developer Mode**,
then right-click yourself / the channel → **Copy ID**.

## Deploy always-on (example: Railway)
1. Push this `discord-bot/` folder to a Git repo.
2. Railway → New Project → Deploy from repo.
3. Add the variables from `.env.example` under the service's **Variables**.
4. Railway runs `npm start` from `package.json`. Same idea on Render (Background Worker) or Fly.io.

## Usage
- **DM** the bot one or more screenshots, or **post them in the allowed channel**.
- It reacts ⏳ while working, then ✅ (or ⚠️ if something failed) and replies with a per-image summary.
- Limits enforced by Adpurgez: images must be JPG/PNG/WebP, ≤ 5 MB each, and ≤ 500 screenshots/hour.

## Notes
- One screenshot = one ingest request (keeps every request well under the 7 MiB cap). A message with
  several images is processed image-by-image; the reply summarizes all of them.
- The extracted hook text / verdict / engagement live in the Hooks tab — the Discord reply only
  confirms whether each screenshot was saved or was a duplicate.
