/**
 * Read-it-later — adds delete, public share links, and related-article
 * discovery via Vectorize. Related is scoped per-user.
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
  VECTORIZE: VectorizeIndex;     // new — for related-article discovery

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

    // Public routes — no auth required.
    if (url.pathname === "/healthz") return new Response("ok");
    if (req.method === "GET" && url.pathname.startsWith("/share/"))      return shareView(url, env);
    if (req.method === "GET" && url.pathname.startsWith("/share-audio/")) return shareAudio(url, env);
    if (req.method === "GET" && url.pathname.startsWith("/share-text/"))  return shareText(url, env);

    // Authenticated routes — require Cloudflare Access header.
    const userEmail = req.headers.get("cf-access-authenticated-user-email");
    if (!userEmail) return new Response("Unauthorized — Cloudflare Access not configured.", { status: 401 });

    if (req.method === "POST"   && url.pathname === "/save")     return saveUrl(req, env, userEmail);
    if (req.method === "POST"   && url.pathname === "/save-pdf") return savePdf(req, env, userEmail);
    if (req.method === "GET"    && url.pathname === "/library")  return library(env, userEmail, url.searchParams.get("sort") ?? "newest");
    if (req.method === "GET"    && url.pathname === "/search")   return search(url, env, userEmail);
    if (req.method === "GET"    && url.pathname.startsWith("/audio/")) return serveAudio(url, env, userEmail);
    if (req.method === "GET"    && url.pathname.startsWith("/text/"))  return serveText(url, env, userEmail);
    if (req.method === "GET"    && url.pathname.startsWith("/related/")) return relatedArticles(url, env, userEmail);
    if (req.method === "POST"   && url.pathname.startsWith("/share/"))   return createShare(url, env, userEmail);
    if (req.method === "DELETE" && url.pathname.startsWith("/share/"))   return revokeShare(url, env, userEmail);
    if (req.method === "DELETE" && url.pathname.startsWith("/article/")) return deleteArticle(url, env, userEmail);

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
  if (!url || !/^https?:\/\//i.test(url)) return json({ error: "valid http(s) url required" }, 400);

  const normalizedUrl = normalizeUrl(url);
  const existing = await env.DB.prepare(
    `SELECT id FROM articles
      WHERE user_email=? AND source_type='url' AND normalized_ref=?
        AND status IN ('done','processing','pending')
      LIMIT 1`
  ).bind(userEmail, normalizedUrl).first<{ id: string }>();
  if (existing) return json({ id: existing.id, status: "duplicate" }, 200);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO articles (id, user_email, source_type, source_ref, normalized_ref, status)
     VALUES (?, ?, 'url', ?, ?, 'pending')`
  ).bind(id, userEmail, url, normalizedUrl).run();

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

  const normalizedTitle = normalizeTitle(file.name);
  const existing = await env.DB.prepare(
    `SELECT id FROM articles
      WHERE user_email=? AND source_type='pdf' AND normalized_title=?
        AND status IN ('done','processing','pending')
      LIMIT 1`
  ).bind(userEmail, normalizedTitle).first<{ id: string }>();
  if (existing) return json({ id: existing.id, status: "duplicate" }, 200);

  const id = crypto.randomUUID();
  const uploadKey = `pdf/${id}.pdf`;

  await env.UPLOADS.put(uploadKey, file.stream(), {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { originalName: file.name, userEmail },
  });

  await env.DB.prepare(
    `INSERT INTO articles (id, user_email, source_type, source_ref, title, normalized_title, status)
     VALUES (?, ?, 'pdf', ?, ?, ?, 'pending')`
  ).bind(id, userEmail, uploadKey, file.name, normalizedTitle).run();

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

  const normalizedTitle = normalizeTitle(title);

  const dup = await env.DB.prepare(
    `SELECT id, summary, text_key, audio_key, audio_seconds
       FROM articles
      WHERE user_email=? AND status IN ('done', 'processing')
        AND normalized_title=? AND id != ?
        AND audio_key IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1`
  ).bind(job.user_email, normalizedTitle, job.id).first<{
    id: string; summary: string; text_key: string; audio_key: string; audio_seconds: number;
  }>();

  if (dup) {
    await env.DB.prepare(
      `UPDATE articles
          SET title=?, normalized_title=?, summary=?, text_key=?, audio_key=?, audio_seconds=?,
              status='done', error='duplicate of ' || ?, updated_at=unixepoch()
        WHERE id=?`
    ).bind(title, normalizedTitle, dup.summary, dup.text_key, dup.audio_key, dup.audio_seconds, dup.id, job.id).run();
    return;
  }

  const { summary, script } = await summarizeAndScript(text, title, env);
  const audioBytes = await synthesizeAudio(script, env);

  const textKey  = `text/${job.id}.txt`;
  const audioKey = `audio/${job.id}.mp3`;
  await env.ARTICLES.put(textKey, text);
  await env.ARTICLES.put(audioKey, audioBytes, { httpMetadata: { contentType: "audio/mpeg" } });

  const wordCount = script.split(/\s+/).length;
  const audioSeconds = Math.round((wordCount / 150) * 60);

  await env.DB.prepare(
    `UPDATE articles
        SET title=?, normalized_title=?, summary=?, text_key=?, audio_key=?, audio_seconds=?,
            status='done', updated_at=unixepoch()
      WHERE id=?`
  ).bind(title, normalizedTitle, summary, textKey, audioKey, audioSeconds, job.id).run();

  // Step 5: embed into Vectorize for related-article discovery. Best-effort —
  // if this fails we still report the article as 'done' (it just won't show up
  // in related-article queries until re-embedded).
  try {
    await embedArticle(job.id, job.user_email, title, summary, env);
    await env.DB.prepare(
      `UPDATE articles SET embedded_at=unixepoch() WHERE id=?`
    ).bind(job.id).run();
  } catch (err) {
    console.error(`embedding failed for ${job.id}:`, err);
  }
}

// ─── Vectorize: embed and query ───────────────────────────────────────────────

async function embedArticle(
  id: string, userEmail: string, title: string, summary: string, env: Env,
): Promise<void> {
  // Use title + summary as the embedding source. Concise, high-signal,
  // avoids embedding 5000 words of article body which dilutes the vector.
  const input = `${title}\n\n${summary}`;
  const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [input] }) as {
    data: number[][];
  };
  const vector = result.data[0];
  if (!vector || vector.length === 0) throw new Error("embedding returned empty vector");

  await env.VECTORIZE.upsert([{
    id,
    values: vector,
    metadata: { user_email: userEmail, title, summary },
  }]);
}

async function relatedArticles(url: URL, env: Env, userEmail: string): Promise<Response> {
  const id = url.pathname.split("/")[2];

  // Confirm the article belongs to this user before doing anything else.
  const row = await env.DB.prepare(
    `SELECT id FROM articles WHERE id=? AND user_email=? AND status='done'`
  ).bind(id, userEmail).first<{ id: string }>();
  if (!row) return json({ error: "not found" }, 404);

  // Look up the existing vector for this article to use as the query.
  const existing = await env.VECTORIZE.getByIds([id]);
  if (!existing || existing.length === 0) {
    return json({ items: [], note: "this article hasn't been indexed yet" });
  }

  // Find nearest neighbors, scoped to this user's email.
  const matches = await env.VECTORIZE.query(existing[0].values, {
    topK: 6,                           // 5 results + the article itself
    filter: { user_email: userEmail },
    returnMetadata: "all",
  });

  // Drop the source article from results, return up to 5 others.
  const items = matches.matches
    .filter(m => m.id !== id)
    .slice(0, 5)
    .map(m => ({
      id: m.id,
      score: m.score,
      title: (m.metadata as any)?.title ?? "(untitled)",
      summary: (m.metadata as any)?.summary ?? "",
    }));

  return json({ items });
}

// ─── Share links ──────────────────────────────────────────────────────────────

async function createShare(url: URL, env: Env, userEmail: string): Promise<Response> {
  const articleId = url.pathname.split("/")[2];

  // Verify ownership.
  const row = await env.DB.prepare(
    `SELECT id FROM articles WHERE id=? AND user_email=? AND status='done'`
  ).bind(articleId, userEmail).first<{ id: string }>();
  if (!row) return json({ error: "not found" }, 404);

  // Reuse an existing active share for this article rather than minting new
  // tokens on every click — keeps shareable URLs stable.
  const existing = await env.DB.prepare(
    `SELECT token FROM shares WHERE article_id=? AND user_email=? AND revoked_at IS NULL LIMIT 1`
  ).bind(articleId, userEmail).first<{ token: string }>();
  if (existing) {
    return json({ token: existing.token, url: `${env.PUBLIC_BASE_URL}/share/${existing.token}` });
  }

  // 22 chars of base64url ≈ 132 bits of entropy. Plenty for an unguessable URL.
  const token = generateToken();
  await env.DB.prepare(
    `INSERT INTO shares (token, article_id, user_email) VALUES (?, ?, ?)`
  ).bind(token, articleId, userEmail).run();

  return json({ token, url: `${env.PUBLIC_BASE_URL}/share/${token}` });
}

async function revokeShare(url: URL, env: Env, userEmail: string): Promise<Response> {
  const articleId = url.pathname.split("/")[2];
  await env.DB.prepare(
    `UPDATE shares SET revoked_at=unixepoch()
      WHERE article_id=? AND user_email=? AND revoked_at IS NULL`
  ).bind(articleId, userEmail).run();
  return json({ revoked: true });
}

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Base64url encode without padding.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function lookupShare(token: string, env: Env): Promise<{ articleId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT article_id FROM shares WHERE token=? AND revoked_at IS NULL`
  ).bind(token).first<{ article_id: string }>();
  if (!row) return null;
  // Bump view count, fire-and-forget.
  env.DB.prepare(`UPDATE shares SET view_count=view_count+1 WHERE token=?`).bind(token).run();
  return { articleId: row.article_id };
}

async function shareView(url: URL, env: Env): Promise<Response> {
  const token = url.pathname.split("/")[2];
  const share = await lookupShare(token, env);
  if (!share) return new Response("Share link is invalid or has been revoked.", { status: 404 });

  const article = await env.DB.prepare(
    `SELECT id, title, summary, audio_seconds FROM articles WHERE id=? AND status='done'`
  ).bind(share.articleId).first<{ id: string; title: string; summary: string; audio_seconds: number }>();
  if (!article) return new Response("Article not found.", { status: 404 });

  const minutes = Math.max(1, Math.ceil((article.audio_seconds ?? 0) / 60));

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(article.title)} — Read-it-later</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar">
    <span class="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      <span>Read-it-later</span>
    </span>
    <span class="share-tag">shared with you</span>
  </header>
  <main>
    <section class="page">
      <article class="card share-card">
        <h1>${escapeHtml(article.title)}</h1>
        <p class="meta"><span>~${minutes} min listen</span></p>
        <p class="summary">${escapeHtml(article.summary ?? "")}</p>
        <audio controls preload="none" src="/share-audio/${token}"></audio>
        <details class="transcript" data-token="${token}">
          <summary>Show transcript</summary>
          <div class="transcript-body">Loading…</div>
        </details>
      </article>
    </section>
  </main>
  <script>
  document.addEventListener('toggle', async (ev) => {
    const det = ev.target;
    if (!det.matches('details.transcript') || !det.open) return;
    const body = det.querySelector('.transcript-body');
    if (body.dataset.loaded) return;
    body.dataset.loaded = '1';
    try {
      const r = await fetch('/share-text/' + det.dataset.token);
      if (!r.ok) throw new Error('failed (' + r.status + ')');
      body.textContent = await r.text();
    } catch (err) {
      body.textContent = 'Could not load transcript: ' + err.message;
    }
  }, true);
  </script>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function shareAudio(url: URL, env: Env): Promise<Response> {
  const token = url.pathname.split("/")[2];
  const share = await lookupShare(token, env);
  if (!share) return new Response("not found", { status: 404 });

  const row = await env.DB.prepare(
    `SELECT audio_key FROM articles WHERE id=? AND status='done'`
  ).bind(share.articleId).first<{ audio_key: string }>();
  if (!row) return new Response("not found", { status: 404 });

  const obj = await env.ARTICLES.get(row.audio_key);
  if (!obj) return new Response("audio missing", { status: 404 });

  return new Response(obj.body, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "public, max-age=3600",
      "accept-ranges": "bytes",
    },
  });
}

async function shareText(url: URL, env: Env): Promise<Response> {
  const token = url.pathname.split("/")[2];
  const share = await lookupShare(token, env);
  if (!share) return new Response("not found", { status: 404 });

  const row = await env.DB.prepare(
    `SELECT text_key FROM articles WHERE id=? AND status='done'`
  ).bind(share.articleId).first<{ text_key: string }>();
  if (!row) return new Response("not found", { status: 404 });

  const obj = await env.ARTICLES.get(row.text_key);
  if (!obj) return new Response("text missing", { status: 404 });

  return new Response(obj.body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────────

async function deleteArticle(url: URL, env: Env, userEmail: string): Promise<Response> {
  const id = url.pathname.split("/")[2];

  const row = await env.DB.prepare(
    `SELECT text_key, audio_key, source_type, source_ref FROM articles
      WHERE id=? AND user_email=?`
  ).bind(id, userEmail).first<{
    text_key: string | null; audio_key: string | null;
    source_type: string; source_ref: string;
  }>();

  if (!row) return new Response("not found", { status: 404 });

  // Best-effort R2 cleanup. If this article was a dup pointing at another's
  // audio_key, deleting it could orphan the original — we skip cleanup of
  // shared assets by checking whether other rows reference them.
  const cleanups: Promise<unknown>[] = [];

  if (row.audio_key) {
    const others = await env.DB.prepare(
      `SELECT 1 FROM articles WHERE audio_key=? AND id != ? LIMIT 1`
    ).bind(row.audio_key, id).first();
    if (!others) cleanups.push(env.ARTICLES.delete(row.audio_key).catch(() => {}));
  }
  if (row.text_key) {
    const others = await env.DB.prepare(
      `SELECT 1 FROM articles WHERE text_key=? AND id != ? LIMIT 1`
    ).bind(row.text_key, id).first();
    if (!others) cleanups.push(env.ARTICLES.delete(row.text_key).catch(() => {}));
  }
  if (row.source_type === "pdf" && row.source_ref) {
    cleanups.push(env.UPLOADS.delete(row.source_ref).catch(() => {}));
  }
  await Promise.all(cleanups);

  // Drop from Vectorize too. Best-effort.
  try { await env.VECTORIZE.deleteByIds([id]); } catch {}

  // Cascade: revoke any active shares for this article.
  await env.DB.prepare(`UPDATE shares SET revoked_at=unixepoch() WHERE article_id=? AND revoked_at IS NULL`).bind(id).run();
  await env.DB.prepare(`DELETE FROM articles WHERE id=? AND user_email=?`).bind(id, userEmail).run();

  return json({ id, deleted: true });
}

// ─── Browser rendering, PDF extraction, summarize, TTS ────────────────────────

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
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();

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

async function summarizeAndScript(fullText: string, title: string, env: Env): Promise<{ summary: string; script: string }> {
  const script = prepareForTts(fullText);

  const trimmed = fullText.slice(0, 12_000);
  const summaryResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [{
      role: "user",
      content: `Summarize the following article in 2-3 neutral sentences. Return ONLY the summary text, no preamble, no markdown, no quotes.

Title: ${title}

Article:
"""
${trimmed}
"""`,
    }],
    max_tokens: 300,
  }) as { response: string };

  const summary = summaryResp.response.trim().replace(/^["']|["']$/g, "");
  if (!summary) throw new Error("LLM did not return a summary");
  return { summary, script };
}

function prepareForTts(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\[[^\]]{1,30}\]/g, "")
    .replace(/&/g, " and ").replace(/%/g, " percent")
    .replace(/\$(\d)/g, "$1 dollars")
    .replace(/[*_`#>]/g, "")
    .replace(/\n{2,}/g, ". ").replace(/\n/g, " ")
    .replace(/\s+/g, " ").trim();
}

async function synthesizeAudio(script: string, env: Env): Promise<Uint8Array> {
  const chunks = chunkForTts(script, 1800);
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    const result = await env.AI.run("@cf/myshell-ai/melotts", { prompt: chunk, lang: "en" }) as { audio: string };
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

// ─── Audio + text serving (authenticated) ─────────────────────────────────────

async function serveAudio(url: URL, env: Env, userEmail: string): Promise<Response> {
  const id = url.pathname.split("/")[2];
  const row = await env.DB.prepare(
    `SELECT audio_key, played_at FROM articles WHERE id=? AND user_email=? AND status='done'`
  ).bind(id, userEmail).first<{ audio_key: string; played_at: number | null }>();
  if (!row) return new Response("not found", { status: 404 });

  const obj = await env.ARTICLES.get(row.audio_key);
  if (!obj) return new Response("audio missing", { status: 404 });

  if (!row.played_at) {
    await env.DB.prepare(`UPDATE articles SET played_at=unixepoch() WHERE id=? AND user_email=?`).bind(id, userEmail).run();
  }

  return new Response(obj.body, {
    headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=3600", "accept-ranges": "bytes" },
  });
}

async function serveText(url: URL, env: Env, userEmail: string): Promise<Response> {
  const id = url.pathname.split("/")[2];
  const row = await env.DB.prepare(
    `SELECT text_key FROM articles WHERE id=? AND user_email=? AND status='done'`
  ).bind(id, userEmail).first<{ text_key: string }>();
  if (!row) return new Response("not found", { status: 404 });

  const obj = await env.ARTICLES.get(row.text_key);
  if (!obj) return new Response("text missing", { status: 404 });

  return new Response(obj.body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=3600" },
  });
}

// ─── Library + search ─────────────────────────────────────────────────────────

interface ArticleRow {
  id: string; title: string; summary: string; audio_seconds: number;
  played_at: number | null; source_type: string; created_at: number;
}

async function library(env: Env, userEmail: string, sort: string): Promise<Response> {
  const orderBy = (() => {
    switch (sort) {
      case "oldest":   return "created_at ASC";
      case "longest":  return "audio_seconds DESC NULLS LAST";
      case "shortest": return "audio_seconds ASC NULLS LAST";
      case "title":    return "LOWER(title) ASC";
      case "newest":
      default:         return "created_at DESC";
    }
  })();

  const { results } = await env.DB.prepare(
    `SELECT id, title, summary, audio_seconds, played_at, source_type, created_at
       FROM articles WHERE user_email=? AND status='done'
      ORDER BY ${orderBy} LIMIT 100`
  ).bind(userEmail).all<ArticleRow>();
  return renderLibrary(results, userEmail, "", sort);
}

async function search(url: URL, env: Env, userEmail: string): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return Response.redirect(new URL("/library", url).toString(), 302);

  const like = `%${q.replace(/[%_]/g, m => "\\" + m)}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, title, summary, audio_seconds, played_at, source_type, created_at
       FROM articles WHERE user_email=? AND status='done'
        AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
      ORDER BY created_at DESC LIMIT 100`
  ).bind(userEmail, like, like).all<ArticleRow>();
  return renderLibrary(results, userEmail, q, "newest");
}

function renderLibrary(rows: ArticleRow[], userEmail: string, query: string, sort: string): Response {
  const items = rows.map(r => {
    const minutes = Math.max(1, Math.ceil((r.audio_seconds ?? 0) / 60));
    const playedClass = r.played_at ? "is-played" : "";
    const sourceChip = r.source_type.toUpperCase();
    const titleHtml = highlight(escapeHtml(r.title ?? "(untitled)"), query);
    const summaryHtml = highlight(escapeHtml(r.summary ?? ""), query);
    return `<article class="card ${playedClass}" data-id="${r.id}">
      <header>
        <h2>${titleHtml}</h2>
        <p class="meta">
          <span class="chip chip-${r.source_type}">${sourceChip}</span>
          <span>~${minutes} min</span>
          ${r.played_at ? `<span class="dot">·</span><span>played</span>` : ""}
          <span class="card-actions">
            <button class="action-btn related-btn" data-id="${r.id}" title="Find related">↔</button>
            <button class="action-btn share-btn" data-id="${r.id}" data-title="${escapeHtml(r.title ?? "")}" title="Share">↗</button>
            <button class="action-btn delete-btn" data-id="${r.id}" data-title="${escapeHtml(r.title ?? "")}" title="Delete">×</button>
          </span>
        </p>
      </header>
      <p class="summary">${summaryHtml}</p>
      <audio controls preload="none" src="/audio/${r.id}"></audio>
      <details class="transcript" data-id="${r.id}">
        <summary>Show transcript</summary>
        <div class="transcript-body">Loading…</div>
      </details>
      <div class="related" data-id="${r.id}" hidden>
        <h3>Related in your library</h3>
        <div class="related-body">Loading…</div>
      </div>
    </article>`;
  }).join("");

  const empty = query
    ? `<p class="empty">No matches for <strong>${escapeHtml(query)}</strong>.</p>`
    : `<p class="empty">Your library is empty. <a href="/">Save your first article →</a></p>`;

  return new Response(layout({
    title: query ? `Search: ${query}` : "Library",
    userEmail,
    activeNav: query ? "search" : "library",
    body: `<section class="page">
      <header class="page-header">
        <h1>${query ? `Results for &ldquo;${escapeHtml(query)}&rdquo;` : "Your library"}</h1>
        <div class="page-meta">
          <p class="page-sub">${rows.length} ${rows.length === 1 ? "article" : "articles"}</p>
          ${query ? "" : `
            <form method="get" action="/library" class="sort-form">
              <label>Sort by:
                <select name="sort" onchange="this.form.submit()">
                  <option value="newest"   ${sort === "newest"   ? "selected" : ""}>Newest first</option>
                  <option value="oldest"   ${sort === "oldest"   ? "selected" : ""}>Oldest first</option>
                  <option value="title"    ${sort === "title"    ? "selected" : ""}>Title (A–Z)</option>
                  <option value="longest"  ${sort === "longest"  ? "selected" : ""}>Longest first</option>
                  <option value="shortest" ${sort === "shortest" ? "selected" : ""}>Shortest first</option>
                </select>
              </label>
            </form>`}
        </div>
      </header>
      <div class="list">${items || empty}</div>
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
  title: string; userEmail: string; activeNav: "add" | "library" | "search"; body: string; query?: string;
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
  <script>
  // Lazy-load transcripts when the user opens them.
  document.addEventListener('toggle', async (ev) => {
    const det = ev.target;
    if (!det.matches('details.transcript') || !det.open) return;
    const body = det.querySelector('.transcript-body');
    if (body.dataset.loaded) return;
    body.dataset.loaded = '1';
    try {
      const r = await fetch('/text/' + det.dataset.id);
      if (!r.ok) throw new Error('failed (' + r.status + ')');
      body.textContent = await r.text();
    } catch (err) {
      body.textContent = 'Could not load transcript: ' + err.message;
    }
  }, true);

  // Card actions: delete, share, related.
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.action-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const card = btn.closest('article.card');

    if (btn.classList.contains('delete-btn')) {
      const title = btn.dataset.title || 'this article';
      if (!confirm('Delete "' + title + '"? This also revokes any share links.')) return;
      btn.disabled = true;
      try {
        const r = await fetch('/article/' + id, { method: 'DELETE' });
        if (!r.ok) throw new Error('delete failed (' + r.status + ')');
        card.remove();
      } catch (err) {
        alert('Could not delete: ' + err.message);
        btn.disabled = false;
      }
      return;
    }

    if (btn.classList.contains('share-btn')) {
      btn.disabled = true;
      try {
        const r = await fetch('/share/' + id, { method: 'POST' });
        if (!r.ok) throw new Error('share failed (' + r.status + ')');
        const data = await r.json();
        // Try the OS share sheet first, fall back to copying to clipboard.
        if (navigator.share) {
          try {
            await navigator.share({ title: btn.dataset.title || 'Read-it-later', url: data.url });
          } catch (err) {
            if (err.name !== 'AbortError') throw err;
          }
        } else {
          await navigator.clipboard.writeText(data.url);
          alert('Share link copied to clipboard:\\n\\n' + data.url);
        }
      } catch (err) {
        alert('Could not share: ' + err.message);
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (btn.classList.contains('related-btn')) {
      const panel = card.querySelector('.related');
      const body = panel.querySelector('.related-body');
      // Toggle visibility on subsequent clicks.
      if (!panel.hidden && body.dataset.loaded) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      if (body.dataset.loaded) return;
      body.dataset.loaded = '1';
      try {
        const r = await fetch('/related/' + id);
        if (!r.ok) throw new Error('failed (' + r.status + ')');
        const data = await r.json();
        if (data.note) {
          body.textContent = data.note;
          body.dataset.loaded = '';
          return;
        }
        if (!data.items.length) {
          body.textContent = 'No related articles found yet — save more to build connections.';
          return;
        }
        body.innerHTML = '<ul class="related-list">' + data.items.map(it =>
          '<li><strong>' + escapeForHtml(it.title) + '</strong>' +
          '<p>' + escapeForHtml(it.summary) + '</p></li>'
        ).join('') + '</ul>';
      } catch (err) {
        body.textContent = 'Could not load related: ' + err.message;
        body.dataset.loaded = '';
      }
      return;
    }
  });

  function escapeForHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }
  </script>
</body>
</html>`;
}

// ─── Daily digest, per user ───────────────────────────────────────────────────

async function sendAllDailyDigests(env: Env): Promise<void> {
  const { results: users } = await env.DB.prepare(
    `SELECT DISTINCT user_email FROM articles WHERE status='done' AND played_at IS NULL`
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
  const lines = results.map(r => `• ${r.title} (~${Math.ceil((r.audio_seconds ?? 0) / 60)} min)`).join("\n");
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
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim().replace(/[;,\s]+$/, ""));
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
                  "ref", "ref_src", "ref_url", "fbclid", "gclid", "mc_cid", "mc_eid"];
    for (const k of drop) u.searchParams.delete(k);
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function normalizeTitle(raw: string): string {
  return (raw || "").toLowerCase()
    .replace(/\.pdf$/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+[—–\-|]\s+.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}
