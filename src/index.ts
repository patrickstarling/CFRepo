import { extractText, getDocumentProxy } from "unpdf";
import puppeteer from "@cloudflare/puppeteer";

export interface Env {
  AI: Ai;
  BROWSER: Fetcher;            // Browser Rendering binding
  UPLOADS: R2Bucket;            // raw PDFs land here on the PDF path
  ARTICLES: R2Bucket;           // extracted text + generated MP3s
  DB: D1Database;
  QUEUE: Queue<QueueJob>;
  ASSETS: Fetcher;              // static upload page

  DIGEST_EMAIL_TO: string;
  DIGEST_EMAIL_FROM: string;
  PUBLIC_BASE_URL: string;
}

type QueueJob =
  | { id: string; source_type: "url"; url: string }
  | { id: string; source_type: "pdf"; uploadKey: string; filename: string };

// ─── HTTP entrypoint ──────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/save")     return saveUrl(req, env);
    if (req.method === "POST" && url.pathname === "/save-pdf") return savePdf(req, env);
    if (req.method === "GET"  && url.pathname === "/playlist") return playlist(env);
    if (req.method === "GET"  && url.pathname.startsWith("/audio/")) return serveAudio(url, env);
    if (req.method === "GET"  && url.pathname === "/healthz")  return new Response("ok");

    // Everything else falls through to the static upload page
    return env.ASSETS.fetch(req);
  },

  // ─── Queue consumer ─────────────────────────────────────────────────────────
  async queue(batch: MessageBatch<QueueJob>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processJob(msg.body, env);
        msg.ack();
      } catch (err) {
        console.error(`job ${msg.body.id} failed:`, err);
        await env.DB.prepare(
          `UPDATE articles SET status='failed', error=?, updated_at=unixepoch() WHERE id=?`
        ).bind(String(err).slice(0, 500), msg.body.id).run();
        msg.retry();   // queue config caps retries; eventually moves to DLQ
      }
    }
  },

  // ─── Cron: daily digest ─────────────────────────────────────────────────────
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDailyDigest(env));
  },
};

// ─── Ingest: URL ──────────────────────────────────────────────────────────────

async function saveUrl(req: Request, env: Env): Promise<Response> {
  const { url } = await req.json<{ url: string }>().catch(() => ({ url: "" }));
  if (!url || !/^https?:\/\//i.test(url)) {
    return json({ error: "valid http(s) url required" }, 400);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO articles (id, source_type, source_ref, status) VALUES (?, 'url', ?, 'pending')`
  ).bind(id, url).run();

  await env.QUEUE.send({ id, source_type: "url", url });
  return json({ id, status: "queued" }, 202);
}

// ─── Ingest: PDF ──────────────────────────────────────────────────────────────

async function savePdf(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const file = form.get("pdf") as unknown as File | null;
  if (!file || typeof file === "string" || file.type !== "application/pdf") {
    return json({ error: "expected multipart field 'pdf' with a PDF file" }, 400);
  }

  const id = crypto.randomUUID();
  const uploadKey = `pdf/${id}.pdf`;

  await env.UPLOADS.put(uploadKey, file.stream(), {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { originalName: file.name },
  });

  await env.DB.prepare(
    `INSERT INTO articles (id, source_type, source_ref, title, status)
     VALUES (?, 'pdf', ?, ?, 'pending')`
  ).bind(id, uploadKey, file.name).run();

  await env.QUEUE.send({ id, source_type: "pdf", uploadKey, filename: file.name });
  return json({ id, status: "queued" }, 202);
}

// ─── Queue consumer: the actual pipeline ──────────────────────────────────────

async function processJob(job: QueueJob, env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE articles SET status='processing', updated_at=unixepoch() WHERE id=?`
  ).bind(job.id).run();

  // Step 1 — get the article text. The two paths diverge here and converge after.
  const { title, text } = job.source_type === "url"
    ? await fetchViaBrowserRendering(job.url, env)
    : await extractFromPdf(job.uploadKey, env);

  if (!text || text.length < 200) {
    throw new Error(`extracted text too short (${text?.length ?? 0} chars) — likely a parse failure`);
  }

  // Step 2 — summarize + produce a TTS-friendly script in one LLM call.
  // Asking for both at once saves a round trip and keeps them stylistically aligned.
  const { summary, script } = await summarizeAndScript(text, title, env);

  // Step 3 — synthesize audio. MeloTTS returns base64-encoded MP3.
  const audioBytes = await synthesizeAudio(script, env);

  // Step 4 — persist everything.
  const textKey  = `text/${job.id}.txt`;
  const audioKey = `audio/${job.id}.mp3`;
  await env.ARTICLES.put(textKey, text);
  await env.ARTICLES.put(audioKey, audioBytes, {
    httpMetadata: { contentType: "audio/mpeg" },
  });

  // Rough audio duration estimate: MeloTTS averages ~150 wpm. Good enough for the digest.
  const wordCount = script.split(/\s+/).length;
  const audioSeconds = Math.round((wordCount / 150) * 60);

  await env.DB.prepare(
    `UPDATE articles
        SET title=?, summary=?, text_key=?, audio_key=?, audio_seconds=?,
            status='done', updated_at=unixepoch()
      WHERE id=?`
  ).bind(title, summary, textKey, audioKey, audioSeconds, job.id).run();
}

// ─── Step 1a: URL → text via Browser Rendering ────────────────────────────────
//
// We use the Workers Binding (env.BROWSER) which exposes a fetch-like interface
// to the underlying REST API. The /content endpoint returns the rendered HTML
// after JS execution, which is exactly what we need for modern article sites.

async function fetchViaBrowserRendering(targetUrl: string, env: Env): Promise<{ title: string; text: string }> {
  const browser = await puppeteer.launch(env.BROWSER as any);
  try {
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: 30000 });
    const html = await page.content();
    return extractReadableContent(html, targetUrl);
  } finally {
    await browser.close();
  }
}

// Tiny, dependency-free reader. Strips scripts/styles/nav, picks the densest
// text-bearing element. Good enough for ~90% of articles. If you want to get
// fancier later, swap in @mozilla/readability via a Container.
function extractReadableContent(html: string, fallbackTitle: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() || fallbackTitle;

  // Remove non-content tags entirely.
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, "");

  // Prefer <article>, fall back to <main>, fall back to <body>.
  const article = cleaned.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
               ?? cleaned.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
               ?? cleaned.match(/<body\b[\s\S]*?<\/body>/i)?.[0]
               ?? cleaned;

  const text = article
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  return { title, text };
}

// ─── Step 1b: PDF → text via unpdf ────────────────────────────────────────────

async function extractFromPdf(uploadKey: string, env: Env): Promise<{ title: string; text: string }> {
  const obj = await env.UPLOADS.get(uploadKey);
  if (!obj) throw new Error(`upload ${uploadKey} not found in R2`);

  const buf = new Uint8Array(await obj.arrayBuffer());
  const pdf = await getDocumentProxy(buf);

  // Pull metadata for a real title if the PDF has one. Falls back to filename.
  const meta = await pdf.getMetadata().catch(() => null) as any;
  const filename = obj.customMetadata?.originalName ?? "Document";
  const title = (meta?.info?.Title as string) || filename.replace(/\.pdf$/i, "");

  const { text } = await extractText(pdf, { mergePages: true });
  return { title, text: typeof text === "string" ? text : (text as string[]).join("\n\n") };
}

// ─── Step 2: summary + TTS script in one LLM call ─────────────────────────────

async function summarizeAndScript(
  fullText: string,
  title: string,
  env: Env,
): Promise<{ summary: string; script: string }> {
  // MeloTTS handles a few thousand chars cleanly. Cap the script's source material
  // at ~12k chars (~3k tokens) to stay well inside Llama's context with headroom.
  const trimmed = fullText.slice(0, 12_000);

  const prompt = `You are preparing an article to be read aloud by a text-to-speech engine.

Article title: ${title}

Article text:
"""
${trimmed}
"""

Return a JSON object with exactly two fields:
  - "summary": a 2-3 sentence neutral summary of the article.
  - "script": the article rewritten for natural narration. Expand abbreviations,
    spell out numbers and acronyms when ambiguous, remove markdown and inline
    citations, and use short sentences. Aim for roughly the same length as the
    source. Do not add commentary, intro, or sign-off.

Return ONLY the JSON object, no markdown fences, no preamble.`;

  const resp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 4096,
  }) as { response: string };

  // Llama on Workers AI is generally well-behaved with "return only JSON",
  // but defend against the occasional ```json fence anyway.
const cleaned = resp.response.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
let parsed: { summary: string; script: string };
try {
  parsed = JSON.parse(cleaned);
} catch {
  // Llama sometimes emits unescaped quotes inside string values. As a fallback,
  // ask it to repair its own output with strict JSON-only constraints.
  const repair = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{
      role: "user",
      content: `The following text was supposed to be JSON with fields "summary" and "script" but failed to parse. Return ONLY valid JSON with those two fields, properly escaping any quotes or newlines in the string values. No markdown, no preamble.\n\n${cleaned}`,
    }],
    max_tokens: 4096,
  }) as { response: string };
  const repaired = repair.response.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  parsed = JSON.parse(repaired);
}

  if (!parsed.summary || !parsed.script) throw new Error("LLM did not return both summary and script");
  return parsed;
}

// ─── Step 3: TTS via MeloTTS ──────────────────────────────────────────────────

async function synthesizeAudio(script: string, env: Env): Promise<Uint8Array> {
  // MeloTTS has a per-call input limit. For long articles, chunk on sentence
  // boundaries and concatenate the resulting MP3s. MP3 frames are independently
  // decodable so a naive byte concat plays correctly in every player I've tried.
  const chunks = chunkForTts(script, 1800);
  const parts: Uint8Array[] = [];

  for (const chunk of chunks) {
    const result = await env.AI.run("@cf/myshell-ai/melotts", {
      prompt: chunk,
      lang: "en",
    }) as { audio: string };

    // base64 → bytes
    const binary = atob(result.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    parts.push(bytes);
  }

  // Concatenate
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function chunkForTts(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > maxChars && buf) { out.push(buf.trim()); buf = ""; }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// ─── Audio streaming ──────────────────────────────────────────────────────────
// /audio/<id> streams the MP3 from R2. Marks the article as played on first hit.

async function serveAudio(url: URL, env: Env): Promise<Response> {
  const id = url.pathname.split("/")[2];
  const row = await env.DB.prepare(
    `SELECT audio_key, played_at FROM articles WHERE id=? AND status='done'`
  ).bind(id).first<{ audio_key: string; played_at: number | null }>();

  if (!row) return new Response("not found", { status: 404 });

  const obj = await env.ARTICLES.get(row.audio_key);
  if (!obj) return new Response("audio missing", { status: 404 });

  if (!row.played_at) {
    await env.DB.prepare(`UPDATE articles SET played_at=unixepoch() WHERE id=?`).bind(id).run();
  }

  return new Response(obj.body, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "private, max-age=3600",
      "accept-ranges": "bytes",
    },
  });
}

// ─── Playlist page ────────────────────────────────────────────────────────────

async function playlist(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, summary, audio_seconds, played_at, source_type, created_at
       FROM articles
      WHERE status='done'
      ORDER BY created_at DESC
      LIMIT 50`
  ).all<{
    id: string; title: string; summary: string; audio_seconds: number;
    played_at: number | null; source_type: string; created_at: number;
  }>();

  const items = results.map(r => `
    <li class="${r.played_at ? 'played' : ''}">
      <h3>${escapeHtml(r.title ?? "(untitled)")}</h3>
      <p class="meta">${r.source_type.toUpperCase()} · ~${Math.ceil(r.audio_seconds / 60)} min ${r.played_at ? "· played" : ""}</p>
      <p>${escapeHtml(r.summary ?? "")}</p>
      <audio controls preload="none" src="/audio/${r.id}"></audio>
    </li>`).join("");

  return new Response(`<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Read-it-later</title>
<style>
  body{font:16px/1.5 system-ui;max-width:680px;margin:2rem auto;padding:0 1rem;color:#222}
  h1{margin-bottom:1.5rem}
  ul{list-style:none;padding:0}
  li{border:1px solid #ddd;border-radius:8px;padding:1rem;margin-bottom:1rem}
  li.played{opacity:.55}
  h3{margin:0 0 .25rem;font-size:1.1rem}
  .meta{color:#666;font-size:.85rem;margin:0 0 .5rem}
  audio{width:100%;margin-top:.5rem}
</style></head>
<body><h1>Your playlist</h1><ul>${items || "<p>Nothing yet — upload a PDF or save a URL.</p>"}</ul></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

// ─── Daily digest email ───────────────────────────────────────────────────────

async function sendDailyDigest(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, audio_seconds FROM articles
      WHERE status='done' AND played_at IS NULL
      ORDER BY created_at DESC LIMIT 20`
  ).all<{ id: string; title: string; audio_seconds: number }>();

  if (!results.length) { console.log("digest: nothing unplayed, skipping"); return; }

  const totalMin = Math.ceil(results.reduce((n, r) => n + (r.audio_seconds ?? 0), 0) / 60);
  const lines = results.map(r =>
    `• ${r.title} (~${Math.ceil(r.audio_seconds / 60)} min)`
  ).join("\n");

  const body = `You have ${results.length} unplayed item(s) — about ${totalMin} minutes total.

${lines}

Open your playlist: ${env.PUBLIC_BASE_URL}/playlist`;

  // MailChannels has a free tier for Workers — see docs link in README.
  const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: env.DIGEST_EMAIL_TO }] }],
      from: { email: env.DIGEST_EMAIL_FROM, name: "Read-it-later" },
      subject: `Your reading playlist — ${results.length} items`,
      content: [{ type: "text/plain", value: body }],
    }),
  });

  if (!resp.ok) console.error("digest send failed:", resp.status, await resp.text());
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}
