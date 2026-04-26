# Read-it-later (Cloudflare edition)

A weekend hack that turns saved articles into an audio playlist. Two ingest paths
converge on a single processing pipeline:

- **URL path** — paste a link, Browser Rendering loads it, the article body gets
  extracted. Showcases Browser Rendering. Limited by the free tier's 10 minutes
  of browser time per day (~30 articles).
- **PDF path** — drop a PDF, `unpdf` parses it inside the Worker. No browser
  needed. Effectively unlimited throughput for the kind of volume one human
  produces.

Everything else is shared: Workers AI summarizes and rewrites for narration,
MeloTTS produces the audio, R2 stores text + audio, D1 holds metadata, a Cron
Trigger emails a daily digest.

## Architecture at a glance

```
URL ──► [URL Worker] ──► [Browser Rendering] ──┐
                                                ├─► [Queue] ──► [Consumer]
PDF ──► [PDF Worker] ──► [R2 uploads]   ───────┘                   │
                                                                   ├─► unpdf (PDF jobs only)
                                                                   ├─► Workers AI (Llama 3.1 8B): summary + script
                                                                   ├─► Workers AI (MeloTTS): MP3
                                                                   ├─► R2 articles  (text + audio)
                                                                   └─► D1            (metadata)

[Cron, daily 7am UTC] ──► query D1 ──► email digest via MailChannels
```

## What's in the box

| File                      | Purpose                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `wrangler.toml`           | All bindings: AI, BROWSER, R2 (×2), D1, Queue, Cron, Assets   |
| `src/index.ts`            | The whole Worker — fetch handler, queue consumer, scheduled   |
| `migrations/0001_init.sql`| The `articles` table and its indexes                          |
| `public/index.html`       | Drag-and-drop upload page + URL save form                     |
| `package.json`            | `unpdf` dependency, helper scripts for setup                  |

## Free tier budget

| Resource          | Free limit                | This project's usage                        |
| ----------------- | ------------------------- | ------------------------------------------- |
| Workers requests  | 100k/day                  | Tiny — a few per save + cron                |
| Browser Rendering | **10 min/day**            | The tightest constraint; ~30 URL saves/day  |
| Workers AI        | ~10k neurons/day          | Summary is cheap, MeloTTS is the consumer   |
| Queues            | 1M operations/month       | Trivial usage                               |
| R2                | 10 GB storage, 1M reads/mo| Audio is ~1 MB/min, plenty of headroom      |
| D1                | 5 GB, 5M reads, 100k writes/day | Negligible                            |
| Cron Triggers     | Unlimited on free         | One trigger, fires daily                    |

## Setup walkthrough

These steps assume a fresh Cloudflare account and a working `wrangler` install.

### 1. Install and log in

```bash
npm install
npx wrangler login
```

### 2. Create the storage resources

```bash
npm run r2:create        # creates both R2 buckets
npm run queue:create     # creates the main queue and the dead-letter queue
npm run db:create        # prints a database_id — copy it
```

Paste the printed `database_id` into `wrangler.toml` under the `[[d1_databases]]`
block, replacing `REPLACE_WITH_YOUR_D1_ID`.

### 3. Run the schema migration

```bash
npm run db:migrate       # applies migrations/0001_init.sql against the remote DB
```

### 4. Set the secrets

```bash
npx wrangler secret put DIGEST_EMAIL_TO       # where to send the daily digest
npx wrangler secret put DIGEST_EMAIL_FROM     # sender address (see MailChannels note below)
npx wrangler secret put PUBLIC_BASE_URL       # e.g. https://read-it-later.<you>.workers.dev
```

### 5. Deploy

```bash
npm run deploy
```

Visit your Worker URL. You should see the upload page. Try saving a URL or
dropping a PDF. Within ~30 seconds the queue consumer will finish and the
playlist page will show the new item with an audio player.

## Local development

```bash
npm run db:migrate:local   # one-time, sets up the local D1 simulator
npm run dev                # runs wrangler dev with all bindings simulated
```

A few caveats for local dev:
- Workers AI calls go to the real API even in dev, so they count against your quota.
- Browser Rendering in `wrangler dev` runs against your real account by default;
  it does count against your daily 10 minutes.
- The MailChannels send call won't actually deliver email locally — it'll log and continue.

## How each piece works

### URL ingest (`POST /save`)

Validates the URL, inserts a `pending` row in D1, enqueues a job, returns 202
immediately. The user doesn't wait for processing.

### PDF ingest (`POST /save-pdf`)

Accepts a multipart form upload. Streams the file straight into R2 (`UPLOADS`
bucket) without buffering in Worker memory — important because Workers have a
128 MB memory limit. Inserts the `pending` row, enqueues a job pointing at the
R2 key.

### Queue consumer

Pulls one job at a time (`max_batch_size = 1`). Updates status to `processing`,
then runs the four-step pipeline:

1. **Get article text.** Branches on `source_type`. URL jobs hit Browser
   Rendering; PDF jobs pull from R2 and run `unpdf`.
2. **Summarize and rewrite.** A single Llama 3.1 8B call returns JSON with both
   a `summary` (for the digest UI) and a `script` (for TTS). Asking for both
   together saves a round trip.
3. **Synthesize audio.** MeloTTS has a per-call input limit, so the script is
   chunked on sentence boundaries. The resulting MP3 byte-sequences are
   concatenated — MP3 frames decode independently so this just works.
4. **Persist.** Text and audio go to the `ARTICLES` R2 bucket; metadata,
   including a rough duration estimate, goes to D1. Status flips to `done`.

If any step throws, the consumer marks the row `failed` with the error message
and calls `msg.retry()`. After three retries the message lands in the
`articles-dlq` dead-letter queue, where you can inspect it from the dashboard.

### Audio streaming (`GET /audio/:id`)

Streams the MP3 directly from R2. Marks the article as `played` on first hit so
the daily digest can skip it next time.

### Playlist (`GET /playlist`)

Server-rendered HTML showing the 50 most recent items, dimmed if already played.
Inline `<audio>` players, no JS needed.

### Daily digest (Cron, 7am UTC)

Queries D1 for unplayed `done` items, formats a plain-text email listing them
with rough durations, sends via MailChannels.

## A note on MailChannels

MailChannels free relay for Workers requires a domain you own with the right
SPF/DKIM records. If you don't have a domain set up, easiest swaps:
- **Resend** has a free tier; replace the `fetch("https://api.mailchannels.net/...")`
  call with their API and add a `RESEND_API_KEY` secret.
- **No email at all** — replace the digest with a webhook to Discord or Slack.
  For a hobby project, a Discord webhook is two lines of code.

## Things that will trip you up

**The `nodejs_compat` flag is required.** `unpdf` needs it. It's already in
`wrangler.toml`. If you forget it, you'll see opaque "module not found" errors
at deploy time.

**Browser Rendering identifies as a bot.** Some sites will return a Cloudflare
challenge page. The `extractReadableContent` parser will then return ~200 chars
of "checking your browser" text and the consumer will throw "extracted text too
short". This is intentional — it surfaces the failure rather than producing a
useless audio file. Workaround: use the PDF path for those sites by printing
to PDF in your browser first.

**MeloTTS is the slowest step.** A 1500-word article takes ~20-30 seconds of
TTS time. The Workers free tier gives you 30 seconds of CPU per request, but
queue consumers get more headroom. If you start hitting timeouts on very long
articles, the right move is to split the consumer into two queue stages —
"prepare script" and "synthesize audio" — so each stage stays well under any
limit. For a weekend build, this single-stage version is fine.

**Llama JSON parsing.** The model is well-behaved, but ~1 in 50 responses adds
a stray markdown fence. The code strips ` ```json ... ``` ` already. If you see
parse failures in the DLQ, add a second `JSON.parse` attempt that scrapes the
first `{...}` substring before giving up.

## What to build next

In rough order of bang-for-buck:

1. **A "skip to next" UI on the playlist.** Right now the audio elements are
   independent. A bit of JS to chain them and persist position would make this
   much more usable on a walk.
2. **Move the consumer to Workflows.** Same logic, but each step gets its own
   retry policy and the state survives Worker restarts. Especially nice for the
   long-tail TTS step.
3. **A browser extension or iOS Shortcut for one-tap save.** Hits `/save` with
   the current tab's URL. Five lines of code, huge UX upgrade.
4. **Voice variety.** MeloTTS supports multiple languages — extend the LLM
   prompt to detect the article's language and pass the right `lang` to TTS.
5. **A "topics" classifier.** Add another short Llama call that tags each
   article (tech, politics, fiction, …) and let the playlist filter by tag.

## Why this shape

The two design choices most worth flagging:

**Why a single Worker instead of separate ingest/consumer/cron Workers?** They
all share state — the same D1 schema, the same R2 buckets — and Wrangler treats
fetch/queue/scheduled handlers as a single deployment unit. Splitting buys
nothing for a project this size and complicates the bindings file.

**Why store extracted text in R2 if the audio's the deliverable?** Two reasons.
First, you can re-run the LLM step later with a better model or prompt without
re-fetching the source — which preserves your Browser Rendering quota. Second,
text search across your library is a fun follow-on project, and having the text
already sitting in R2 makes it cheap to add (Vectorize + an embedding model on
the same Workers AI binding). Cheap insurance.
