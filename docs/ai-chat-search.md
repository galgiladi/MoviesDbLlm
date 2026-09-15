# AI Chat "Smart Search" on the Movies Page

Status: implemented (tool-calling design, v3 — see History below for the superseded v1 and the v2→v3
tool-consolidation rationale).

## Context

The Movies page (`client/src/pages/MoviesPage.tsx`) only supports lexical keyword search (`multi_match` over
`title`/`description`/`genres`, see `server/src/services/movies.service.ts`). It can't answer analytical
natural-language questions like *"who was the busiest actor in the last 10 years"* because that requires
reasoning across credits/filmography, not a text match. This feature adds an "Ask AI" chat panel to the Movies
page where the user asks free-form questions and gets a grounded, streamed answer that cites the actual
movies/people it's based on (clickable references, not hallucinated text).

Decisions made along the way:
- **LLM**: Groq (free tier, fast inference), not Anthropic — a deliberate switch away from Claude/paid APIs.
  Model is configurable via `GROQ_MODEL`, default `openai/gpt-oss-120b` (the originally-configured
  `llama-3.3-70b-versatile` turned out to have been moved to enterprise-only access on Groq's side — verified
  directly against the API with a real key; `gpt-oss-120b` was confirmed to work on the free tier, including
  streaming + tool calls).
- **UI placement**: unchanged — an embedded panel/toggle on the existing `MoviesPage`, not a separate route.
- **Response mode**: streamed (SSE) so text appears progressively; also streams a lightweight `status` event
  (e.g. "Searching for ...") while a tool call is in flight, so the panel shows real-time progress instead of a
  long silent "Thinking..." during multi-tool-call questions.
- **Conversation scope**: unchanged — stateless, one question in, one answer out, no multi-turn history.
- **Data-access approach**: **real tool-calling against Elasticsearch**, replacing the original "stuff the
  whole index into context" design (see History). This is RAG in the general sense (retrieve, then generate
  grounded in what came back) — it has been since this redesign, not something new added with plot summaries.
  The model is given four fixed, backend-defined tools — never a passthrough for model-authored query DSL, so
  the injection/DoS risk that motivated the original design never comes back:
  - `search_movies(query?, genre?, yearFrom?, yearTo?, limit?)` — **hybrid** search: combines lexical (BM25,
    `operator: 'and'`) and semantic (kNN on `plotEmbedding`) in one ES request, so the model doesn't have to
    choose between "exact keywords" and "matches by meaning" — see "Hybrid search" below. Returns
    `{ total, items }` so "how many X movies are there" questions can be answered from the accurate total count.
  - `get_title_details(id)` — full details + credits for one movie
  - `get_person_filmography(name, limit?)` — look up a person, return their filmography with roles
  - `aggregate(dimension: 'genre'|'person', metric?, personCategory?, genre?, yearFrom?, yearTo?, limit?)` —
    unified aggregation: `dimension: 'genre'` ranks genres against each other (count/avgScore/avgNumVotes);
    `dimension: 'person'` ranks people (optionally by role, optionally within one genre) — answers "which genre
    has the highest average score", "how many action movies are there", "recommend an actress who does action
    movies", "top directors of the 2010s" from one tool shape.

  Each tool hardcodes its own ES query shape (`server/src/services/chat/tools.ts`); the model only ever supplies
  the tool's declared arguments (a search string, a genre, a year range, an id), never a query body.

  **This started as six tools** (`search_titles` and `semantic_search_plots` as two the model had to choose
  between; `find_people_by_genre` as a bespoke tool alongside `aggregate_titles_by`) and was deliberately
  consolidated down to four — see "Tool consolidation" under History for why that mattered in practice, not
  just in theory.

- **Search relevance**: `search_movies`'s `multi_match` uses `operator: 'and'` (not the default `'or'`) — a
  real bug found and fixed after testing: with `'or'`, a multi-word query like "Spider-Man" tokenizes to
  ["spider", "man"], and "man" alone is common enough to match tons of unrelated movies (Iron Man, ...), which
  combined with sorting by popularity let famous unrelated blockbusters swamp genuinely relevant results
  (confirmed via a debug trace: searching "Spider-Man" returned *Iron Man*, *Mad Max*, *Catch Me If You Can*).
  `'and'` requires every query term to actually appear (still fuzzy-matched, so minor typos are fine) before a
  document counts as a hit at all.
- **Answer tone/format**: the system prompt explicitly instructs the model to write like a knowledgeable friend
  recommending films — never mentioning "the database", "search results", "tool calls", or other implementation
  detail — and to format the answer in Markdown (tables/bold/lists). The client renders it with `react-markdown`
  + `remark-gfm` (`AiSearchPanel.tsx`) instead of plain text.

## Architecture

**Two-phase tool-calling loop, server-side.** The client POSTs the question to `/api/chat`; the server:

1. **Phase 1 — gather + answer** (`streamChatAnswer` in `server/src/services/chat.service.ts`): loops up to
   `MAX_TOOL_ITERATIONS` (4) times, each time streaming one Groq chat-completion turn with the four data tools
   available (`tool_choice: 'auto'`). Any text the model writes during the loop (including interim commentary
   like "let me check that") is forwarded live as SSE `token` events — this is a deliberate choice: it keeps
   the UX simple (the frontend just concatenates every token event into one growing answer) and is a common,
   transparent pattern for tool-calling chat. Right before each tool executes, a short human-readable SSE
   `status` event fires (`describeToolCall()` — e.g. "Searching for \"Spider-Man\"…", "Looking up Christopher
   Nolan's filmography…") so the panel shows real progress instead of long silence during multi-call questions;
   the frontend clears the status line the moment real answer tokens start arriving. Each requested tool call is
   executed via `executeDataTool` and the JSON result is appended back as a `role: 'tool'` message; the loop
   continues until the model responds with plain text and no further tool calls (or the iteration cap is hit).
2. **Phase 2 — structured citations**: once the loop has a final answer, one more **non-streaming** Groq call
   is made with only the `answer` tool available, `tool_choice` forced to it, asking the model to enumerate
   every movie/person its already-written answer cited. This mirrors the original design's "answer tool call
   is for citations only, not for the visible text" split — the answer text was already fully streamed in
   phase 1, so this call only needs to return `{ references: [{ type, id, title }] }`. A failure here (e.g. a
   transient Groq error) doesn't fail the whole response — it just means no reference chips render.
3. The server streams: text deltas live as SSE `token` events throughout phase 1, then a terminal SSE `final`
   event carrying `{ text, references }` once phase 2 resolves, then closes the stream.

Streaming and tool-calling are combined using the standard OpenAI-compatible chunk-delta accumulation pattern
(Groq's SDK mirrors this exactly): each streamed chunk's `delta.tool_calls[]` carries an `index` used to
accumulate that specific tool call's `id`/`name`/fragmented JSON `arguments` string across chunks, since a
single tool call's arguments can arrive split across many chunks.

## Key files

- `server/src/services/chat/tools.ts` — the four data-tool JSON-schema definitions + their ES-backed
  implementations (the entire data-access boundary; no other code path lets the model reach Elasticsearch)
- `server/src/services/chat.service.ts` — the two-phase Groq loop described above, the `answer` tool
  definition, the system prompt, `describeToolCall()` (status-line text), and the retry/timeout handling below
- `server/src/controllers/chat.controller.ts` — SSE endpoint (`POST /api/chat`), now also forwards `onStatus`
  as a `status` SSE event; `server/src/routes/chat.routes.ts` unchanged
- `client/src/api/chat.ts` — parses the new `status` SSE event in addition to `token`/`final`/`error`
- `client/src/components/AiSearchPanel.tsx` — shows the status line while waiting, and renders the final answer
  with `react-markdown` + `remark-gfm` instead of plain text
- `client/src/index.css` — `.ai-panel-markdown` styles (tables/lists/code) for the rendered answer

## Reliability notes (Groq free tier)

Two separate rate-limit dimensions were hit and handled during testing, both surfaced as HTTP 429
`RateLimitError` with a `"Please try again in N.NNs"` hint in the message:
- **Tokens-per-minute (observed: 8000 TPM)** — easily exhausted by a single multi-tool-call question, since
  every tool result gets echoed back into the growing conversation for every subsequent call in the loop.
  `withRetry()` in `chat.service.ts` parses the wait hint and actually waits it out (up to 3 attempts) instead
  of retrying immediately into the same still-exhausted window. Tool result sizes were also trimmed down
  (`search_movies` capped to 6-10 items, `get_person_filmography` to 10-20) specifically to reduce how much
  each call adds to the running total.
- **Tokens-per-day (observed: 200,000 TPD)** — a much harder wall with a much slower recovery (a rolling
  window, not a fixed midnight reset); heavy back-to-back testing can exhaust it for hours. There's no code-side
  mitigation for this one — it's a hard free-tier ceiling. If Ask AI starts reliably failing after working
  fine earlier, check for this specifically (the server logs the raw Groq error) before assuming a regression.

A hard per-call deadline (`PER_CALL_TIMEOUT_MS`, 30s, via `AbortSignal.timeout()`) is also enforced on every
Groq call — the client's own `timeout` option was observed to not cover a stream that goes silent mid-flight
(a stalled stream produced zero chunks for 60s+ with no error before this was added).

## Hybrid search (lexical + semantic, one tool)

Added once real plot summaries existed (see `docs/PLAN.md`'s plot-summary note) — before that, there was no
real content to search semantically. Elasticsearch has two built-in one-click hybrid/semantic features —
`semantic_text` fields and the RRF `retriever` framework — but **both are Enterprise-license only** (confirmed
against Elastic's own docs before building either version of this feature, not assumed). The free/Basic tier
this project runs on (no auth, `docker-compose.yml`) only includes the lower-level building blocks: a
`dense_vector` field + kNN search, where *we* generate the embedding vectors ourselves and ES just
indexes/searches them, and a plain top-level `query` clause — both of which **can be combined in a single
`_search` request** (`query` + `knn` side by side), with ES adding the two sets of scores together. That's the
free-tier substitute for RRF used here: not as principled as a real rank-fusion, but genuinely hybrid (a
document can surface from either signal, or score higher for matching both), and it needed no license upgrade.

`search_movies` (`server/src/services/chat/tools.ts`) issues exactly this combined request whenever a `query`
string is given: a `bool`/`must` `multi_match` (lexical, `operator: 'and'`, see "Search relevance" above) plus a
`knn` clause against `plotEmbedding` (semantic), with the `knn` score `boost`ed (currently 8×) so a strong
semantic match isn't drowned out by BM25's typically-larger score range. Any `genre`/`yearFrom`/`yearTo` filters
apply to both clauses identically via a shared `filter` array. This replaced two separate v2 tools
(`search_titles` for lexical-only, `semantic_search_plots` for semantic-only) that the model had to choose
between — see "Tool consolidation" in History for why merging them mattered in practice, not just in theory.

- **Embedding model**: local, not a hosted API — `@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2`
  in-process (`server/src/services/embeddings.ts`), 384 dims, ~30ms/embedding on CPU. Deliberately not a free
  hosted embedding API: embeddings are needed on the *live* query path too (every user question needs embedding
  at ask-time, via the same `embedText()` used for indexing), and this project has already been burned
  repeatedly by free-tier rate limits (Groq) — a rate-limited embedding API would just move that problem onto
  the search path too.
- **Intel Mac gotcha**: `onnxruntime-node` (the native runtime `@huggingface/transformers` uses) dropped the
  `darwin-x64` binary in current versions — only `darwin-arm64` (Apple Silicon) ships now. `server/package.json`
  pins it back via `overrides.onnxruntime-node: "1.19.0"`, the last version confirmed to still include it.
  Without this override, loading the pipeline throws `Cannot find module '.../onnxruntime_binding.node'` on
  this kind of machine. Same pattern as the Docker Desktop / Playwright Intel-Mac issues earlier in this
  project — verified directly (installed, hit the missing-binary error, found the override) rather than
  assumed.
- **Mapping**: `titles.plotEmbedding` — `{ type: 'dense_vector', dims: 384, index: true, similarity: 'cosine' }`
  (`server/src/es/indices.ts`). Added to the mapping *after* the index already had 100k docs — `ensureIndex()`
  now calls `indices.putMapping()` on an already-existing index (ES allows adding new fields, just not changing
  existing ones), so this didn't require a full reindex.
- **Backfill pipeline** (two separate resumable scripts, run in order): `npm run enrich:plots` (TMDb plot
  summaries) → `npm run enrich:embeddings` (embeds them). The embedding script skips any movie still on the
  templated description (reconstructs the exact template string to detect this) — nothing meaningful to embed
  there, and embedding a generic templated sentence would just pollute semantic scoring with near-duplicate
  noise across every movie of the same genre. Result: 100,000 scanned, 98,567 embedded, 1,433 skipped as
  still-templated.
- A movie with no embedding (still-templated description) simply can't contribute a `knn` hit — it can still
  surface via the lexical half of the same query, so a themed search never fully excludes un-enriched movies,
  it just can't semantically match them.

## Config

Requires `GROQ_API_KEY` (get a free key at [console.groq.com](https://console.groq.com)) and optionally
`GROQ_MODEL` (default `openai/gpt-oss-120b`) in `server/.env` — see `server/.env.example`. Groq's available
free-tier models change over time; if the configured model starts returning `model_not_found`, check
`GET https://api.groq.com/openai/v1/models` with your key for what's currently accessible.

## Verification

1. `npm run es:up` then `npm run seed` (if not already seeded) to ensure the `titles`/`people` indices have
   real IMDb data.
2. Add `GROQ_API_KEY` to `server/.env`.
3. `npm run dev` (root) to start client + server together.
4. `curl -N -X POST http://localhost:4000/api/chat -H "Content-Type: application/json" -d
   "{\"question\":\"recommend 3 comedies from after 2010\"}"` and confirm SSE frames stream, ending in a
   `final` event with non-empty, plausible `references`.
5. In the browser, open the Movies page, click "Ask AI", ask the same question, and confirm: text streams in
   progressively, reference chips render below the answer, and clicking a chip navigates to the correct
   `/movies/:id` or `/actors/:id` page with matching data.
6. Try a question needing a specific person lookup (e.g. "what has Christopher Nolan directed?") to exercise
   `get_person_filmography`, an aggregation question (e.g. "which genre has the highest average score?") to
   exercise `aggregate` with `dimension: 'genre'`, a count question (e.g. "how many batman movies are there?")
   to exercise `search_movies`'s `total`, and a recommendation question (e.g. "recommend an actress who does
   action movies") to exercise `aggregate` with `dimension: 'person'`.
7. Run `npm run enrich:plots` then `npm run enrich:embeddings` (no `TMDB_API_KEY` needed for the latter — fully
   local), then try a plot/theme question with wording that wouldn't lexically match the actual plot text (e.g.
   "a widower finding love again") to confirm `search_movies` returns a sensible match via its semantic half —
   this is the class of question that wouldn't have worked via lexical matching alone. Also try a query that
   needs *both* halves at once (e.g. "time travel movies from 2000-2010" — "time travel" matches best
   semantically, the year range is a lexical/filter concern) to confirm the combined `query`+`knn` request
   handles both in the single tool call, rather than needing two separate tool calls like the old v2 design did.
8. Try a nonsense question to confirm the model returns a coherent "I don't know" rather than hallucinating
   references.
9. Confirm the answer renders as actual formatted Markdown (bold, tables, lists) in the panel, not literal
   `**`/`|`/`-` characters, and that it reads naturally with no mention of "the database" or "search results".

**Status as of the last session**: items 1-3 and the raw `curl` check in item 4 were verified directly against
Elasticsearch/the API (confirmed: `search_movies("batman")` now correctly returns only real Batman movies
with an accurate `total`; `aggregate` with `dimension: 'person'` returns genuine, recognizable action
actresses; one full `curl` round-trip produced a well-formatted, natural-sounding Markdown answer). Item 5
(the actual rendered browser UI) was **not visually confirmed** — testing was blocked by Groq's free-tier daily
token limit (200,000 TPD) being exhausted from the session's own testing before a clean screenshot could be
captured. Worth a real look before relying on it.

**Hybrid search (item 7)**: `search_movies`'s ES-layer logic was verified directly (bypassing the LLM) across
four cases — a pure-lexical query ("batman"), a pure-semantic query ("a widower finding love again"), a
combined hybrid+filter query ("time travel movies from 2000-2010"), and both `aggregate` dimensions — with
genuinely on-theme, correct results in each case; the hybrid case specifically surfaced "Happy Accidents" (a
time-travel movie matched by meaning, not by the literal phrase) which the old two-tool v2 design's separate
`search_titles`/`semantic_search_plots` calls had missed in earlier testing. A full live round-trip through
Groq confirmed the practical win: the same "time travel movies from 2000-2010" question that previously took
2-4 tool calls under v2 (the model trying `search_titles`, then retrying, then `semantic_search_plots`) now
resolves in a **single** `search_movies` call with correct, better-quality results. Repeated heavy testing in
this session did eventually re-exhaust the Groq daily token limit (documented under "Reliability notes"
above) — a pre-existing, unrelated constraint, not a regression from this change.

## Known limitation

`people.filmography` entries don't carry the title's `genres`/`year` (an explicit, documented tradeoff from
the Phase 2 indexing work — see `docs/PLAN.md`), so a query like "which actor appeared in a musical, an
action movie, and a comedy all in the same year" would require the model to chain `get_person_filmography` +
several `get_title_details` calls per candidate and reason over the results itself — doable, but not a single
efficient tool call today. Denormalizing genre/year onto filmography entries (or adding a dedicated
cross-reference tool) is the natural follow-up if this class of question turns out to matter in practice.

## History (superseded v1 design)

The original implementation (when the dataset was capped at ~1,000 movies) used **context stuffing** instead
of tool-calling: the server ran one fixed `match_all` query, trimmed the entire index down to essential fields,
and handed it to Claude as context — Claude reasoned over the given data with no retrieval loop at all, using
Anthropic prompt caching to keep repeated-question costs down. That stopped scaling once the seed pipeline was
raised to 100,000 movies (an entire-index dump no longer fits in a prompt), and was left running against only
the first 20 movies as a stopgap (`moviesContext.service.ts`, now deleted) until this tool-calling redesign
replaced it entirely, together with the switch to Groq. Nothing from `moviesContext.service.ts` carries over —
retrieval is now real per-question ES queries via the tools above, not a cached, capped snapshot.

## History (v2 → v3: tool consolidation)

The v2 design had six tools: `search_titles` (lexical only), `semantic_search_plots` (semantic only, added
once plot embeddings existed), `get_title_details`, `get_person_filmography`, `aggregate_titles_by` (genre
aggregation), and `find_people_by_genre` (a bespoke tool added on top of `aggregate_titles_by` specifically for
"recommend a `<role>` who does `<genre>` movies" questions). In practice this ran into real, observed problems
that motivated the v3 rework:

- **Choice overhead was itself a failure mode.** With `search_titles` and `semantic_search_plots` as two
  separate options, the model sometimes had to guess which one a question needed, and when it guessed wrong (or
  hedged by trying both) that cost extra tool calls — directly colliding with the tight Groq free-tier rate
  limits (see "Reliability notes"). A live-tested example: "time travel movies from 2000-2010" needed 2-4 tool
  calls under v2 (try lexical, get a weak result, retry semantic, sometimes retry again) before v3 resolved the
  identical question in one `search_movies` call.
- **More tools meant more chances to pick the wrong one entirely**, not just the lexical/semantic split —
  `find_people_by_genre` existing as a separate tool from `aggregate_titles_by` was the same problem in a
  different shape.
- **The fix wasn't "add more tools" (a path considered and rejected)** — it was the opposite: use Elasticsearch
  more natively so *one* tool could cover more ground per call, and shrink the total tool surface so the model
  has fewer decisions to get wrong. Before doing this, ES's own built-in answer to "combine lexical + semantic
  in one request" (the RRF `retriever` framework, and `semantic_text` fields) was checked against Elastic's
  docs and confirmed **Enterprise-license only** — not available on this project's free/Basic self-managed
  setup. The free-tier equivalent — a top-level `query` plus a `knn` clause in the same `_search` call, scores
  combined by addition — was verified to actually work (tested directly against ES) and is what `search_movies`
  uses now (see "Hybrid search" above). `aggregate_titles_by` and `find_people_by_genre` were similarly merged
  into one `aggregate` tool with a `dimension: 'genre'|'person'` switch.
- Net result: six tools → four (`search_movies`, `get_title_details`, `get_person_filmography`, `aggregate`),
  verified both at the ES layer directly (batman lexical search, widower semantic search, time-travel hybrid
  search, both aggregate dimensions all correct) and via a live Groq round-trip showing fewer tool calls and
  equal-or-better answer quality on the same test questions used to validate v2.
