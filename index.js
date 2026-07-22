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
const EXT_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function mimeOf(att) {
  let m = (att.contentType || "").toLowerCase().split(";")[0].trim();
  if (m === "image/jpg") m = "image/jpeg";
  if (["image/jpeg", "image/png", "image/webp"].includes(m)) return m;
  const ext = (att.name || "").toLowerCase().split(".").pop();
  return EXT_MIME[ext] || null;
}

async function ingest(att, msg) {
  const mime = mimeOf(att);
  if (!mime) return { s: "skip", why: "not a JPG / PNG / WebP image" };
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

  const payload = JSON.stringify({
    image_b64: buf.toString("base64"),
    image_content_type: mime,
    forwarded_by: `discord:${msg.author.username}`,
    forwarded_at: new Date().toISOString(),
  });

  let r, j;
  try {
    r = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: payload,
    });
    j = await r.json().catch(() => ({}));
  } catch {
    return { s: "error", why: "couldn't reach Adpurgez" };
  }

  if (r.status === 429) return { s: "error", why: "hourly limit reached — try again later" };
  if (r.status === 401) return { s: "error", why: "ingestion key rejected — check ADPURGEZ_INGEST_KEY" };
  if (!r.ok) return { s: "error", why: (j && j.error) || `HTTP ${r.status}` };
  if (j.status === "created") return { s: "created", id: j.id };
  if (j.status === "duplicate") return { s: "duplicate", id: j.id };
  return { s: "error", why: (j && j.error) || "rejected by Adpurgez" };
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
