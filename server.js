// music-toys — five independent music toys. Zero-dep Node 20+. Native http + fetch.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT || 3220);
// Default to Sonnet for reasoning-heavy toys; fast toys override to Haiku.
const MODEL = "claude-sonnet-4-6";
const FAST_MODEL = "claude-haiku-4-5-20251001";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------- Claude helper ----------

async function callClaude(system, user, { maxTokens = 800, model = MODEL } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("ANTHROPIC_API_KEY is not set on the server.");
    err.status = 500;
    throw err;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Claude API ${res.status}: ${text.slice(0, 400)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const err = new Error(`Bad JSON from Claude (stop_reason=${data.stop_reason}): ${cleaned.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
}

// ---------- YouTube helper ----------

// Deezer 30-second previews — free public API, no auth, autoplay-friendly on
// mobile because it's a direct MP3 (not a video iframe). Returns null if the
// track isn't on Deezer.
async function searchDeezer(query) {
  try {
    const u = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`;
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const t = data.data?.[0];
    if (!t || !t.preview) return null;
    return {
      preview: t.preview,
      cover: t.album?.cover_medium || t.album?.cover || null,
      coverBig: t.album?.cover_big || t.album?.cover_xl || null,
      deezerUrl: t.link || null,
      durationSec: 30,
    };
  } catch { return null; }
}

async function attachPreviews(items) {
  return Promise.all(items.map(async (it) => {
    const q = `${it.artist} ${it.track}`;
    const dz = await searchDeezer(q);
    return {
      ...it,
      preview: dz?.preview || null,
      cover: dz?.cover || null,
      coverBig: dz?.coverBig || null,
      deezerUrl: dz?.deezerUrl || null,
      fallbackQuery: q,
    };
  }));
}

async function ytSearchVideoId(query) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const u = new URL("https://www.googleapis.com/youtube/v3/search");
    u.searchParams.set("part", "snippet");
    u.searchParams.set("q", query);
    u.searchParams.set("type", "video");
    u.searchParams.set("maxResults", "1");
    u.searchParams.set("videoEmbeddable", "true");
    u.searchParams.set("key", key);
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.items?.[0]?.id?.videoId || null;
  } catch {
    return null;
  }
}

// ---------- Toy 1: The Sound Of… ----------

const SOUND_OF_SYSTEM = `You are a music curator with deep crate-digging instincts. The user gives you ANY noun, phrase, memory, or feeling. Pick ONE real, commercially released song that IS that thing. The pick should make a music nerd say "oh shit, perfect" — strong, specific, slightly surprising. Avoid the obvious if there's a deeper-cut that's more on the nose.

Return ONLY a JSON object:
{
  "artist": string,
  "track": string,
  "year": string,
  "why": string  // ONE sentence. Specific musical detail or moment in the song that ties to the input. Confident, no hedging.
}

If the user lists "already_heard", pick something different.`;

async function handleSoundOf(req, res) {
  try {
    const { input, already_heard } = await readBody(req);
    if (!input || typeof input !== "string" || input.length < 1) {
      return sendJson(res, 400, { error: "Type something first." });
    }
    const userMsg = `Input: ${input}\n\nAlready heard:\n${(already_heard || []).map((x) => `- ${x}`).join("\n") || "(none)"}`;
    const pick = await callClaude(SOUND_OF_SYSTEM, userMsg, { maxTokens: 400, model: FAST_MODEL });
    const [withYt] = await attachPreviews([pick]);
    sendJson(res, 200, { pick: withYt });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---------- Toy 2: The Song You Almost Remember ----------

const REMEMBER_SYSTEM = `You are a music detective. The user describes a song from a vague memory — they don't know the title or artist, but they remember details (a feeling, a sound, a moment in their life when they heard it, a context like a TV show, a fragment of melody description). Your job: identify it, or give your best three candidates ranked by confidence.

Return ONLY a JSON object:
{
  "best_guess": {
    "artist": string,
    "track": string,
    "year": string,
    "confidence": number,            // 0.0 - 1.0
    "why_this_matches": string       // 1-2 sentences citing the user's clues
  },
  "alternates": [                    // 0-2 alternates, only if best_guess confidence < 0.85
    { "artist": string, "track": string, "year": string, "why_this_matches": string }
  ],
  "what_would_help": string          // If you couldn't fully nail it, ONE sentence on what additional detail from the user would help most. Empty string if you're confident.
}

Rules:
- Real, commercially released songs only.
- Treat ambiguity honestly — set confidence accordingly.
- "why_this_matches" must reference the user's specific clues.`;

async function handleRemember(req, res) {
  try {
    const { description } = await readBody(req);
    if (!description || description.length < 8) {
      return sendJson(res, 400, { error: "Give me a few more details to work with." });
    }
    const result = await callClaude(REMEMBER_SYSTEM, `User's memory:\n${description}`, { maxTokens: 1200 });
    const all = [result.best_guess, ...(result.alternates || [])].filter(Boolean);
    const withYt = await attachPreviews(all);
    result.best_guess = withYt[0];
    result.alternates = withYt.slice(1);
    sendJson(res, 200, { result });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---------- Toy 3: Decade Compass ----------

const COMPASS_SYSTEM = `You are a deep music historian. Given a year (1960-2026) and an energy level (0.0 = ambient/sparse, 1.0 = peak/explosive), pick ONE real commercially released song that lived AT THAT EXACT POINT — released within ~1 year of the given year, sitting close to the given energy level.

Variety matters: avoid the obvious chart-toppers when a more interesting equally-fitting track exists. Span genres across requests.

Return ONLY a JSON object:
{
  "artist": string,
  "track": string,
  "year": string,
  "genre_hint": string,    // 1-3 words ("disco-funk", "post-punk", "trap-rap")
  "why": string            // ONE sentence — what makes this sit at this exact coordinate
}

Avoid anything in "already_heard".`;

async function handleCompass(req, res) {
  try {
    const { year, energy, already_heard } = await readBody(req);
    if (typeof year !== "number" || year < 1955 || year > 2026) {
      return sendJson(res, 400, { error: "year must be 1955-2026" });
    }
    if (typeof energy !== "number" || energy < 0 || energy > 1) {
      return sendJson(res, 400, { error: "energy must be 0..1" });
    }
    const userMsg = `Year: ${year}\nEnergy: ${energy.toFixed(2)} (0=ambient, 1=peak)\n\nAlready heard:\n${(already_heard || []).map((x) => `- ${x}`).join("\n") || "(none)"}`;
    const pick = await callClaude(COMPASS_SYSTEM, userMsg, { maxTokens: 400, model: FAST_MODEL });
    const [withYt] = await attachPreviews([pick]);
    sendJson(res, 200, { pick: withYt });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---------- Toy 4: Two Truths and a Lie ----------

const TWOTRUTHS_SYSTEM = `You are designing a "Two Truths and a Lie" round about music. Pick THREE real commercially released songs. Two MUST share a specific, verifiable hidden trait. The third MUST NOT share it. The trait should be interesting — not obvious from track names. Examples: same producer, same drummer/session musician, same year + same recording studio, same uncommon time signature, same key+mode, sample of same source, etc.

Return ONLY a JSON object:
{
  "songs": [                            // 3 songs, ALWAYS in random order — the lie can be at any index
    { "artist": string, "track": string, "year": string }
  ],
  "lie_index": number,                  // 0, 1, or 2 — which one DOESN'T share the trait
  "trait": string,                      // ≤ 12 words. The thing the two truths share.
  "reveal": string                      // 2-3 sentences explaining the trait, citing each song's relationship to it.
}

Rules:
- Real, commercially released songs only. No invented connections.
- The trait must be VERIFIABLE — don't guess at session musicians you're not sure of.
- Pick traits a casual listener wouldn't immediately spot.
- Avoid anything in "already_used" (full song list strings).`;

async function handleTwoTruths(req, res) {
  try {
    const { difficulty, already_used } = await readBody(req);
    const diffMsg = difficulty === "hard"
      ? "Difficulty: HARD. The trait should be very subtle — production-level details, session musicians, mixing engineers, key relationships. Make a music nerd actually stop and think."
      : difficulty === "easy"
      ? "Difficulty: EASY. The trait can be more surface-level — same artist's backing band, same songwriter, same year/genre combination."
      : "Difficulty: MEDIUM. The trait should be findable but interesting — a specific producer, a sample, a recording studio, a year+context combination.";
    const userMsg = `${diffMsg}\n\nAlready used:\n${(already_used || []).map((x) => `- ${x}`).join("\n") || "(none)"}`;
    const round = await callClaude(TWOTRUTHS_SYSTEM, userMsg, { maxTokens: 800 });
    if (!Array.isArray(round.songs) || round.songs.length !== 3) {
      throw new Error("Bad round shape");
    }
    const withYt = await attachPreviews(round.songs);
    round.songs = withYt;
    sendJson(res, 200, { round });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---------- Toy 5: Songs That Don't Exist ----------

const DONTEXIST_SYSTEM = `The user describes a song that doesn't exist — a hypothetical mashup, a "if X did Y album", a sound that doesn't quite have a real song yet. Your job: pick the closest REAL commercially released song that gets nearest to the fantasy. Be specific about WHY it's the closest — what trade-off was made.

Return ONLY a JSON object:
{
  "artist": string,
  "track": string,
  "year": string,
  "why": string,                  // 2 sentences. What's right about it (matches the fantasy) and what's traded off (where it falls short of the impossible original).
  "closer_if": string             // ≤15 words. "It would be even closer if you imagine [specific tweak]."
}

Avoid anything in "already_heard". Be confident, surprising, and slightly funny when the input is funny.`;

async function handleDontExist(req, res) {
  try {
    const { fantasy, already_heard } = await readBody(req);
    if (!fantasy || fantasy.length < 4) {
      return sendJson(res, 400, { error: "Describe the song that doesn't exist." });
    }
    const userMsg = `Fantasy song: ${fantasy}\n\nAlready heard:\n${(already_heard || []).map((x) => `- ${x}`).join("\n") || "(none)"}`;
    const pick = await callClaude(DONTEXIST_SYSTEM, userMsg, { maxTokens: 500, model: FAST_MODEL });
    const [withYt] = await attachPreviews([pick]);
    sendJson(res, 200, { pick: withYt });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---------- Toy 6: Year Wars ----------

const YEAR_WARS_SYSTEM = `Pick TWO real, commercially-released songs from clearly different decades (at least 8 years apart). Goal: make a listener guess wrong about which is older. Pick pairs where the modern-sounding one is actually old, or the vintage-sounding one is actually new.

Return ONLY a JSON object:
{
  "song_a": { "artist": string, "track": string, "year": string },
  "song_b": { "artist": string, "track": string, "year": string },
  "twist": string                // ≤15 words — what makes this pair confusing on first listen
}

Rules:
- Real, commercially released songs only.
- Years must differ by 8+. Prefer pairs where intuition will be wrong.
- Skip anything in "already_used".`;

async function handleYearWars(req, res) {
  try {
    const { already_used } = await readBody(req);
    const userMsg = `Already used (avoid):\n${(already_used || []).map((x) => `- ${x}`).join("\n") || "(none)"}`;
    const round = await callClaude(YEAR_WARS_SYSTEM, userMsg, { maxTokens: 400, model: FAST_MODEL });
    if (!round.song_a || !round.song_b) throw new Error("Bad round shape");
    const [a, b] = await attachPreviews([round.song_a, round.song_b]);
    round.song_a = a; round.song_b = b;
    sendJson(res, 200, { round });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---------- Toy 7: The Album Nobody Made ----------

const ALBUM_SYSTEM = `User describes a hypothetical album that doesn't exist (e.g. "If Frank Ocean made a Christmas album", "The breakup album My Chemical Romance never wrote", "What Drake's gospel record would sound like"). Pick 5 REAL commercially-released songs that, played in sequence, would be a coherent album expressing that concept. Each track plays a different role.

Return ONLY a JSON object:
{
  "headline": string,                // ONE sentence framing the imaginary album
  "tracklist": [                     // exactly 5 entries, in playback order
    {
      "role": string,                // "Opener" | "Build" | "Centerpiece" | "Vulnerable cut" | "Closer"
      "artist": string,
      "track": string,
      "year": string,
      "why": string                  // ≤18 words — why this track at this slot
    }
  ]
}

Rules:
- Real, commercially-released songs.
- The 5 tracks must work as a SEQUENCE — building, peaking, resolving — not just 5 songs that match the vibe.
- Pick songs from different artists where possible, unless the concept demands one artist.`;

async function handleAlbum(req, res) {
  try {
    const { concept } = await readBody(req);
    if (!concept || concept.length < 4) {
      return sendJson(res, 400, { error: "Describe the album that doesn't exist." });
    }
    const album = await callClaude(ALBUM_SYSTEM, `Concept: ${concept}`, { maxTokens: 1200, model: FAST_MODEL });
    if (!Array.isArray(album.tracklist) || album.tracklist.length !== 5) throw new Error("Bad album shape");
    album.tracklist = await attachPreviews(album.tracklist);
    sendJson(res, 200, { album });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---------- Toy 8: Music Tarot ----------

const TAROT_SYSTEM = `User tells you about their current moment, week, or state of mind. Draw their three "music tarot cards": Past, Present, Future. Each card is ONE real commercially-released song.

- Past: a song that captures where they were, often nostalgic, an emotional anchor for what's been
- Present: matches where they are RIGHT NOW
- Future: aspirational — where they're heading, the energy they want, a bet on what's next

Return ONLY a JSON object:
{
  "past":    { "artist": string, "track": string, "year": string, "why": string },
  "present": { "artist": string, "track": string, "year": string, "why": string },
  "future":  { "artist": string, "track": string, "year": string, "why": string },
  "reading": string                  // 2 sentences. The overall arc the three songs trace. Mystical-leaning but specific.
}

Rules:
- Real, commercially-released songs.
- Each "why" is one short sentence with a specific musical detail tying it to the user's situation.
- Avoid the obvious — this is supposed to feel like the cards revealed something.`;

async function handleTarot(req, res) {
  try {
    const { mood } = await readBody(req);
    if (!mood || mood.length < 4) {
      return sendJson(res, 400, { error: "Tell me about your week first." });
    }
    const reading = await callClaude(TAROT_SYSTEM, `Querent's moment:\n${mood}`, { maxTokens: 800, model: FAST_MODEL });
    const [past, present, future] = await attachPreviews([reading.past, reading.present, reading.future]);
    reading.past = past; reading.present = present; reading.future = future;
    sendJson(res, 200, { reading });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---------- HTTP plumbing ----------

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// ---------- Per-IP rate limiting ----------
// Caps Anthropic spend by limiting how many /api/* requests one client can
// make per rolling window. In-memory only — resets on container restart,
// which is fine at this scale.

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 24 * 60 * 60 * 1000);
const rateBuckets = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  return (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function checkRateLimit(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  let entry = rateBuckets.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, entry);
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.writeHead(429, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfterSec),
    });
    res.end(JSON.stringify({
      error: `Daily limit reached (${RATE_LIMIT_MAX} picks per day). Try again later.`,
      retryAfterSec,
    }));
    return false;
  }
  entry.count++;
  // Opportunistic cleanup so the Map doesn't grow forever.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
  }
  return true;
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  if (!extname(rel)) rel = `${rel}.html`;
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + sep) && full !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(full);
    const mime = MIME[extname(full)] || "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  if (req.method === "POST" && path.startsWith("/api/")) {
    if (!checkRateLimit(req, res)) return;
    if (path === "/api/sound-of") return handleSoundOf(req, res);
    if (path === "/api/remember") return handleRemember(req, res);
    if (path === "/api/compass") return handleCompass(req, res);
    if (path === "/api/two-truths") return handleTwoTruths(req, res);
    if (path === "/api/dont-exist") return handleDontExist(req, res);
    if (path === "/api/year-wars") return handleYearWars(req, res);
    if (path === "/api/album") return handleAlbum(req, res);
    if (path === "/api/tarot") return handleTarot(req, res);
  }
  if (req.method === "GET") return serveStatic(req, res, path);
  res.writeHead(405); res.end();
});

server.listen(PORT, () => {
  console.log(`music-toys listening on http://localhost:${PORT}`);
});
