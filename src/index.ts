/**
 * Read-it-later — multi-user edition.
 *
 * Auth: Cloudflare Access sits in front of this Worker. Access verifies the
 * user and injects the `Cf-Access-Authenticated-User-Email` header on every
 * request. We trust that header and use it to scope all queries.
 *
 * Routes:
 *   POST /save              { url }       — queue a URL ingest
 *   POST /save-pdf          multipart     — queue a PDF ingest
 *   GET  /                                — upload page (static)
 *   GET  /library                         — articles list
 *   GET  /search?q=...                    — search title + summary
 *   GET  /audio/:id                       — stream MP3, mark played
 *   GET  /healthz                         — liveness check (unauthenticated)
 */

import { extractText, getDocumentProxy } from "unpdf";
import puppeteer from "@cloudflare/puppeteer";

export interface Env {
  AI: Ai;
  BROWSER: Fetcher;
  UPLOADS: R2Bucket;
  ARTICLES: R2Bucket;
  DB: D1Database;
  QUEUE: Queue<QueueJob>;
  ASSETS: Fetcher;

  DIGEST_EMAIL_FROM: string;
  PUBLIC_BASE_URL: string;
}

type QueueJob =
  | { id: string; user_email: string; source_type: "url"; url: string }
  | { id: string; user_email: string; source_type: "pdf"; uploadKey: string; filename: string };

// ─── HTTP entrypoint ──────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Healthcheck stays unauthenticated so monitors can ping it.
    if (url.pathname === "/healthz") return new Response("ok");

    // Trust Cloudflare Access. If this header is missing, Access isn't in
    // front of the Worker — refuse rather than serve unauthenticated traffic.
    const userEmail = req.headers.get("cf-access-authenticated-user-email");
    if (!userEmail) {
      return new Response("Unauthorized — Cloudflare Access not configured.", { status: 401 });
    }

    if (req.method === "POST" && url.pathname === "/save")     return saveUrl(req, env, userEmail);
    if (req.method === "POST" && url.pathname === "/save-pdf") return savePdf(req, env, userEmail);
    if (req.method === "GET"  && url.pathname === "/library")  return library(env, userEmail);
    if (req.method === "GET"  && url.pathname === "/search")   return search(url, env, userEmail);
    if (req.method === "GET"  && url.pathname.startsWith("/audio/")) return serveAudio(url, env, userEmail);

    // Everything else falls through to the static upload page.
    return env.ASSETS.fetch(req);
  },

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
        msg.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendAllDailyDigests(env));
  },
};

// ─── Ingest: URL ──────────────────────────────────────────────────────────────

async function saveUrl(req: Request, env: Env, userEmail: string): Promise<Response> {
  const { url } = await req.json<{ url: string }>().catch(() => ({ url: "" }));
  if (!url || !/^https?:\/\//i.test(url)) {
    return json({ error: "valid http(s) url required" }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM articles
      WHERE user_email=? AND source_type='url' AND source_ref=?
        AND status IN ('done','processing','pending')
      LIMIT 1`
  ).bind(userEmail, url).first<{ id: string }>();
  if (existing) return json({ id: existing.id, status: "duplicate" }, 200);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO articles (id, user_email, source_type, source_ref, status)
     VALUES (?, ?, 'url', ?, 'pending')`
  ).bind(id, userEmail, url).run();

  await env.QUEUE.send({ id, user_email: userEmail, source_type: "url", url });
  return json({ id, status: "queued" }, 202);
}

// ─── Ingest: PDF ──────────────────────────────────────────────────────────────

async function savePdf(req: Request, env: Env, userEmail: string): Promise<Response> {
  const form = await req.formData();
  const file = form.get("pdf") as unknown as File | null;
  if (!file || typeof file === "string" || file.type !== "application/pdf") {
    return json({ error: "expected multipart field 'pdf' with a PDF file" }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM articles
      WHERE user_email=? AND source_type='pdf' AND title=?
        AND status IN ('done','processing','pending')
      LIMIT 1`
  ).bind(userEmail, file.name).first<{ id: string }>();
  if (existing) return json({ id: existing.id, status: "duplicate" }, 200);

  const id = crypto.randomUUID();
  const uploadKey = `pdf/${id}.pdf`;

  await env.UPLOADS.put(uploadKey, file.stream(), {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { originalName: file.name, userEmail },
  });

  await env.DB.prepare(
    `INSERT INTO articles (id, user_email, source_type, source_ref, title, status)
     VALUES (?, ?, 'pdf', ?, ?, 'pending')`
  ).bind(id, userEmail, uploadKey, file.name).run();

  await env.QUEUE.send({ id, user_email: userEmail, source_type: "pdf", uploadKey, filename: file.name });
  return json({ id, status: "queued" }, 202);
}

// ─── Queue consumer pipeline ──────────────────────────────────────────────────

async function processJob(job: QueueJob, env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE articles SET status='processing', updated_at=unixepoch() WHERE id=?`
  ).bind(job.id).run();

  const { title, text } = job.source_type === "url"
    ? await fetchViaBrowserRendering(job.url, env)
    : await extractFromPdf(job.uploadKey, env);

  if (!text || text.length < 200) {
    throw new Error(`extracted text too short (${text?.length ?? 0} chars) — likely a parse failure`);
  }

  // Title-based dedup, scoped to this user.
  const dup = await env.DB.prepare(
    `SELECT id, summary, text_key, audio_key, audio_seconds
       FROM articles
      WHERE user_email=? AND status='done' AND title=? AND id != ?
      LIMIT 1`
  ).bind(job.user_email, title, job.id).first<{
    id: string; summary: string; text_key: string; audio_key: string; audio_seconds: number;
  }>();

  if (dup) {
    await env.DB.prepare(
      `UPDATE articles
          SET title=?, summary=?, text_key=?, audio_key=?, audio_seconds=?,
              status='done', error='duplicate of ' || ?, updated_at=unixepoch()
        WHERE id=?`
    ).bind(title, dup.summary, dup.text_key, dup.audio_key, dup.audio_seconds, dup.id, job.id).run();
    return;
  }

  const { summary, script } = await summarizeAndScript(text, title, env);
  const audioBytes = await synthesizeAudio(script, env);

  const textKey  = `text/${job.id}.txt`;
  const audioKey = `audio/${job.id}.mp3`;
  await env.ARTICLES.put(textKey, text);
  await env.ARTICLES.put(audioKey, audioBytes, {
    httpMetadata: { contentType: "audio/mpeg" },
  });

  const wordCount = script.split(/\s+/).length;
  const audioSeconds = Math.round((wordCount / 150) * 60);

  await env.DB.prepare(
    `UPDATE articles
        SET title=?, summary=?, text_key=?, audio_key=?, audio_seconds=?,
            status='done', updated_at=unixepoch()
      WHERE id=?`
  ).bind(title, summary, textKey, audioKey, audioSeconds, job.id).run();
}

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

function extractReadableContent(html: string, fallbackTitle: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() || fallbackTitle;

  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, "");

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

async function extractFromPdf(uploadKey: string, env: Env): Promise<{ title: string; text: string }> {
  const obj = await env.UPLOADS.get(uploadKey);
  if (!obj) throw new Error(`upload ${uploadKey} not found in R2`);

  const buf = new Uint8Array(await obj.arrayBuffer());
  const pdf = await getDocumentProxy(buf);

  const meta = await pdf.getMetadata().catch(() => null) as any;
  const filename = obj.customMetadata?.originalName ?? "Document";
  const title = (meta?.info?.Title as string) || filename.replace(/\.pdf$/i, "");

  const { text } = await extractText(pdf, { mergePages: true });
  return { title, text: typeof text === "string" ? text : (text as string[]).join("\n\n") };
}

async function summarizeAndScript(
  fullText: string,
  title: string,
  env: Env,
): Promise<{ summary: string; script: string }> {
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

  const cleaned = resp.response.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let parsed: { summary: string; script: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
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

async function synthesizeAudio(script: string, env: Env): Promise<Uint8Array> {
  const chunks = chunkForTts(script, 1800);
  const parts: Uint8Array[] = [];

  for (const chunk of chunks) {
    const result = await env.AI.run("@cf/myshell-ai/melotts", {
      prompt: chunk,
      lang: "en",
    }) as { audio: string };

    const binary = atob(result.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    parts.push(bytes);
  }

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

async function serveAudio(url: URL, env: Env, userEmail: string): Promise<Response> {
  const id = url.pathname.split("/")[2];
  const row = await env.DB.prepare(
    `SELECT audio_key, played_at FROM articles
      WHERE id=? AND user_email=? AND status='done'`
  ).bind(id, userEmail).first<{ audio_key: string; played_at: number | null }>();

  if (!row) return new Response("not found", { status: 404 });

  const obj = await env.ARTICLES.get(row.audio_key);
  if (!obj) return new Response("audio missing", { status: 404 });

  if (!row.played_at) {
    await env.DB.prepare(
      `UPDATE articles SET played_at=unixepoch() WHERE id=? AND user_email=?`
    ).bind(id, userEmail).run();
  }

  return new Response(obj.body, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "private, max-age=3600",
      "accept-ranges": "bytes",
    },
  });
}

// ─── Library + search ─────────────────────────────────────────────────────────

interface ArticleRow {
  id: string;
  title: string;
  summary: string;
  audio_seconds: number;
  played_at: number | null;
  source_type: string;
  created_at: number;
}

async function library(env: Env, userEmail: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, summary, audio_seconds, played_at, source_type, created_at
       FROM articles
      WHERE user_email=? AND status='done'
      ORDER BY created_at DESC
      LIMIT 100`
  ).bind(userEmail).all<ArticleRow>();

  return renderLibrary(results, userEmail, "");
}

async function search(url: URL, env: Env, userEmail: string): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return Response.redirect(new URL("/library", url).toString(), 302);

  const like = `%${q.replace(/[%_]/g, m => "\\" + m)}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, title, summary, audio_seconds, played_at, source_type, created_at
       FROM articles
      WHERE user_email=? AND status='done'
        AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
      ORDER BY created_at DESC
      LIMIT 100`
  ).bind(userEmail, like, like).all<ArticleRow>();

  return renderLibrary(results, userEmail, q);
}

// ─── UI rendering ─────────────────────────────────────────────────────────────

function renderLibrary(rows: ArticleRow[], userEmail: string, query: string): Response {
  const items = rows.map(r => {
    const minutes = Math.max(1, Math.ceil((r.audio_seconds ?? 0) / 60));
    const playedClass = r.played_at ? "is-played" : "";
    const sourceChip = r.source_type.toUpperCase();
    const titleHtml = highlight(escapeHtml(r.title ?? "(untitled)"), query);
    const summaryHtml = highlight(escapeHtml(r.summary ?? ""), query);
    return `<article class="card ${playedClass}">
      <header>
        <h2>${titleHtml}</h2>
        <p class="meta">
          <span class="chip chip-${r.source_type}">${sourceChip}</span>
          <span>~${minutes} min</span>
          ${r.played_at ? `<span class="dot">·</span><span>played</span>` : ""}
        </p>
      </header>
      <p class="summary">${summaryHtml}</p>
      <audio controls preload="none" src="/audio/${r.id}"></audio>
    </article>`;
  }).join("");

  const empty = query
    ? `<p class="empty">No matches for <strong>${escapeHtml(query)}</strong>.</p>`
    : `<p class="empty">Your library is empty. <a href="/">Save your first article →</a></p>`;

  return new Response(layout({
    title: query ? `Search: ${query}` : "Library",
    userEmail,
    activeNav: query ? "search" : "library",
    body: `
      <section class="page">
        <header class="page-header">
          <h1>${query ? `Results for &ldquo;${escapeHtml(query)}&rdquo;` : "Your library"}</h1>
          <p class="page-sub">${rows.length} ${rows.length === 1 ? "article" : "articles"}${query ? "" : " · most recent first"}</p>
        </header>
        <div class="list">
          ${items || empty}
        </div>
      </section>`,
    query,
  }), { headers: { "content-type": "text/html; charset=utf-8" } });
}

function highlight(text: string, query: string): string {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), m => `<mark>${m}</mark>`);
}

interface LayoutOpts {
  title: string;
  userEmail: string;
  activeNav: "add" | "library" | "search";
  body: string;
  query?: string;
}

function layout(o: LayoutOpts): string {
  const navClass = (n: string) => n === o.activeNav ? "active" : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(o.title)} — Read-it-later</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      <span>Read-it-later</span>
    </a>
    <nav>
      <a href="/" class="${navClass("add")}">Add</a>
      <a href="/library" class="${navClass("library")}">Library</a>
      <form action="/search" method="get" class="search">
        <input type="search" name="q" placeholder="Search title or summary…" value="${escapeHtml(o.query ?? "")}" autocomplete="off">
      </form>
    </nav>
    <div class="user" title="${escapeHtml(o.userEmail)}">${escapeHtml(o.userEmail.split("@")[0])}</div>
  </header>
  <main>${o.body}</main>
</body>
</html>`;
}

// ─── Daily digest, per user ───────────────────────────────────────────────────

async function sendAllDailyDigests(env: Env): Promise<void> {
  const { results: users } = await env.DB.prepare(
    `SELECT DISTINCT user_email FROM articles
      WHERE status='done' AND played_at IS NULL`
  ).all<{ user_email: string }>();

  for (const { user_email } of users) {
    try { await sendDigestFor(user_email, env); }
    catch (err) { console.error(`digest failed for ${user_email}:`, err); }
  }
}

async function sendDigestFor(userEmail: string, env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, audio_seconds FROM articles
      WHERE user_email=? AND status='done' AND played_at IS NULL
      ORDER BY created_at DESC LIMIT 20`
  ).bind(userEmail).all<{ id: string; title: string; audio_seconds: number }>();

  if (!results.length) return;

  const totalMin = Math.ceil(results.reduce((n, r) => n + (r.audio_seconds ?? 0), 0) / 60);
  const lines = results.map(r =>
    `• ${r.title} (~${Math.ceil((r.audio_seconds ?? 0) / 60)} min)`
  ).join("\n");

  const body = `You have ${results.length} unplayed item(s) — about ${totalMin} minutes total.

${lines}

Open your library: ${env.PUBLIC_BASE_URL}/library`;

  const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: userEmail }] }],
      from: { email: env.DIGEST_EMAIL_FROM, name: "Read-it-later" },
      subject: `Your reading playlist — ${results.length} items`,
      content: [{ type: "text/plain", value: body }],
    }),
  });

  if (!resp.ok) console.error(`digest send failed for ${userEmail}:`, resp.status, await resp.text());
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
