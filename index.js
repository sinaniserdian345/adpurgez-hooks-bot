import "dotenv/config";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

// ---- config (from environment / .env) ----
const cfg = {
  token: process.env.DISCORD_TOKEN,
  url: process.env.ADPURGEZ_INGEST_URL || "https://adpurgez.com/hooks-api.php?action=bot_ingest",
  key: process.env.ADPURGEZ_INGEST_KEY,
  channelId: (process.env.ALLOWED_CHANNEL_ID || "").trim(),
  userIds: (process.env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
  maxPerMessage: Math.max(1, Number(process.env.MAX_IMAGES_PER_MESSAGE || 10)),
};

if (!cfg.token || !cfg.key) {
  console.error("Missing DISCORD_TOKEN or ADPURGEZ_INGEST_KEY — copy .env.example to .env and fill them in.");
  process.exit(1);
}

// Adpurgez limits: image/jpeg|png|webp, 5 MB decoded per screenshot. We send one image per
// request (a single creative object) so we never brush the 7 MiB per-request cap.
const MAX_DECODED = 5 * 1024 * 1024;

// Detect the real image type from the file's magic bytes, so image_content_type always
// matches what the server re-detects (it rejects on any mismatch).
function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function ingest(att, msg) {
  if (att.size > MAX_DECODED) return { s: "skip", why: "over 5 MB" };

  let buf;
  try {
    const res = await fetch(att.url);
    if (!res.ok) return { s: "error", why: `couldn't download (HTTP ${res.status})` };
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    return { s: "error", why: "download failed" };
  }
  if (buf.length > MAX_DECODED) return { s: "skip", why: "over 5 MB" };
  const mime = sniffMime(buf);
  if (!mime) return { s: "skip", why: "not a JPG / PNG / WebP image" };

  const payload = JSON.stringify({
    image_b64: buf.toString("base64"),
    image_content_type: mime,
    forwarded_by: `discord:${msg.author.username}`,
    forwarded_at: new Date().toISOString(),
  });

  let r, raw = "", j = null;
  try {
    r = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: payload,
    });
    raw = await r.text();
    try { j = JSON.parse(raw); } catch {}
  } catch {
    return { s: "error", why: "couldn't reach Adpurgez" };
  }

  // Surface whatever the server actually said, in whatever shape it came back.
  const serverMsg =
    (j && (j.error || j.message || (Array.isArray(j.items) && j.items[0] && j.items[0].error))) ||
    (raw ? raw.replace(/\s+/g, " ").trim().slice(0, 180) : "");

  if (r.status === 429) return { s: "error", why: serverMsg || "hourly limit reached — try again later" };
  if (r.status === 401) return { s: "error", why: serverMsg || "ingestion key rejected — check ADPURGEZ_INGEST_KEY" };
  if (j && j.status === "created") return { s: "created", id: j.id };
  if (j && j.status === "duplicate") return { s: "duplicate", id: j.id };
  return { s: "error", why: serverMsg || `HTTP ${r.status}` };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Adpurgez Hooks bot online as ${c.user.tag}`);
  if (!cfg.userIds.length && !cfg.channelId) {
    console.warn("No ALLOWED_USER_IDS or ALLOWED_CHANNEL_ID set — anyone who can message the bot can spend your 500/hour quota.");
  }
});

function allowed(msg) {
  if (cfg.userIds.length && !cfg.userIds.includes(msg.author.id)) return false;
  const isDM = msg.channel?.isDMBased?.() ?? false;
  if (cfg.channelId && !isDM && msg.channel.id !== cfg.channelId) return false;
  return true;
}

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  const imgs = [...msg.attachments.values()].filter(
    (a) => (a.contentType || "").startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(a.name || "")
  );
  if (!imgs.length) return;
  if (!allowed(msg)) return;

  let hourglass;
  try { hourglass = await msg.react("⏳"); } catch {}

  let created = 0, dup = 0, failed = 0, skipped = 0;
  const notes = [];
  for (const att of imgs.slice(0, cfg.maxPerMessage)) {
    const out = await ingest(att, msg);
    if (out.s === "created") { created++; notes.push(`✅ saved as hook #${out.id}`); }
    else if (out.s === "duplicate") { dup++; notes.push(`♻️ already saved (#${out.id})`); }
    else if (out.s === "skip") { skipped++; notes.push(`⏭️ ${out.why}`); }
    else { failed++; notes.push(`⚠️ ${out.why}`); }
  }
  if (imgs.length > cfg.maxPerMessage) notes.push(`…only the first ${cfg.maxPerMessage} images were processed`);

  try { await hourglass?.users.remove(client.user.id); } catch {}
  try { await msg.react(failed ? "⚠️" : "✅"); } catch {}

  const head = `**${created} saved · ${dup} duplicate${failed ? ` · ${failed} failed` : ""}${skipped ? ` · ${skipped} skipped` : ""}** — view in Adpurgez → Hooks`;
  try {
    await msg.reply({ content: (head + "\n" + notes.join("\n")).slice(0, 1900), allowedMentions: { repliedUser: false } });
  } catch {}
});

client.login(cfg.token);
