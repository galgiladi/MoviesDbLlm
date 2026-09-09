# AI Chat "Smart Search" on the Movies Page

Status: implemented (tool-calling design, v2 — see History below for the superseded v1).

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
  whole index into context" design (see History). The model is given five fixed, backend-defined tools — never
  a passthrough for model-authored query DSL, so the injection/DoS risk that motivated the original design
  never comes back:
  - `search_titles(query?, genre?, yearFrom?, yearTo?, limit?)` — ranked movie search; returns
    `{ total, items }` so "how many X movies are there" questions can be answered from the accurate total count,
    not just the trimmed `items` list
  - `get_title_details(id)` — full details + credits for one movie
  - `get_person_filmography(name, limit?)` — look up a person, return their filmography with roles
  - `aggregate_titles_by(metric, yearFrom?, yearTo?, limit?)` — genre-level aggregation (count/avgScore/avgNumVotes)
  - `find_people_by_genre(genre, category?, limit?)` — nested aggregation that finds which people appear most
    often in movies of a given genre (optionally filtered to one role) — added specifically to answer
    "recommend a/an `<role>` who does `<genre>` movies" in one call instead of the model manually
    cross-referencing many individual `get_title_details` calls

  Each tool hardcodes its own ES query shape (`server/src/services/chat/tools.ts`); the model only ever supplies
  the tool's declared arguments (a search string, a genre, a year range, an id), never a query body.

- **Search relevance**: `search_titles`'s `multi_match` uses `operator: 'and'` (not the default `'or'`) — a
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
   `MAX_TOOL_ITERATIONS` (6) times, each time streaming one Groq chat-completion turn with the five data tools
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

- `server/src/services/chat/tools.ts` — the five data-tool JSON-schema definitions + their ES-backed
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
  (`search_titles` capped to 6-10 items, `get_person_filmography` to 10-20) specifically to reduce how much
  each call adds to the running total.
- **Tokens-per-day (observed: 200,000 TPD)** — a much harder wall with a much slower recovery (a rolling
  window, not a fixed midnight reset); heavy back-to-back testing can exhaust it for hours. There's no code-side
  mitigation for this one — it's a hard free-tier ceiling. If Ask AI starts reliably failing after working
  fine earlier, check for this specifically (the server logs the raw Groq error) before assuming a regression.

A hard per-call deadline (`PER_CALL_TIMEOUT_MS`, 30s, via `AbortSignal.timeout()`) is also enforced on every
Groq call — the client's own `timeout` option was observed to not cover a stream that goes silent mid-flight
(a stalled stream produced zero chunks for 60s+ with no error before this was added).

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
   exercise `aggregate_titles_by`, a count question (e.g. "how many batman movies are there?") to exercise
   `search_titles`'s `total`, and a recommendation question (e.g. "recommend an actress who does action
   movies") to exercise `find_people_by_genre`.
7. Try a nonsense question to confirm the model returns a coherent "I don't know" rather than hallucinating
   references.
8. Confirm the answer renders as actual formatted Markdown (bold, tables, lists) in the panel, not literal
   `**`/`|`/`-` characters, and that it reads naturally with no mention of "the database" or "search results".

**Status as of the last session**: items 1-3 and the raw `curl` check in item 4 were verified directly against
Elasticsearch/the API (confirmed: `search_titles("batman")` now correctly returns only real Batman movies
with an accurate `total`; `find_people_by_genre` returns genuine, recognizable action actresses; one full
`curl` round-trip produced a well-formatted, natural-sounding Markdown answer). Item 5 (the actual rendered
browser UI) was **not visually confirmed** — testing was blocked by Groq's free-tier daily token limit
(200,000 TPD) being exhausted from the session's own testing before a clean screenshot could be captured.
Worth a real look before relying on it.

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
