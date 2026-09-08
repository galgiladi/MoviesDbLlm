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
  Model is configurable via `GROQ_MODEL` (default `llama-3.3-70b-versatile`).
- **UI placement**: unchanged — an embedded panel/toggle on the existing `MoviesPage`, not a separate route.
- **Response mode**: unchanged — streamed (SSE) so text appears progressively like a real chat.
- **Conversation scope**: unchanged — stateless, one question in, one answer out, no multi-turn history.
- **Data-access approach**: **real tool-calling against Elasticsearch**, replacing the original "stuff the
  whole index into context" design (see History). The model is given four fixed, backend-defined tools — never
  a passthrough for model-authored query DSL, so the injection/DoS risk that motivated the original design
  never comes back:
  - `search_titles(query?, genre?, yearFrom?, yearTo?, limit?)` — ranked movie search
  - `get_title_details(id)` — full details + credits for one movie
  - `get_person_filmography(name, limit?)` — look up a person, return their filmography with roles
  - `aggregate_titles_by(metric, yearFrom?, yearTo?, limit?)` — genre-level aggregation (count/avgScore/avgNumVotes)

  Each tool hardcodes its own ES query shape (`server/src/services/chat/tools.ts`); the model only ever supplies
  the tool's declared arguments (a search string, a genre, a year range, an id), never a query body.

## Architecture

**Two-phase tool-calling loop, server-side.** The client POSTs the question to `/api/chat`; the server:

1. **Phase 1 — gather + answer** (`streamChatAnswer` in `server/src/services/chat.service.ts`): loops up to
   `MAX_TOOL_ITERATIONS` (6) times, each time streaming one Groq chat-completion turn with the four data tools
   available (`tool_choice: 'auto'`). Any text the model writes during the loop (including interim commentary
   like "let me check that") is forwarded live as SSE `token` events — this is a deliberate choice: it keeps
   the UX simple (the frontend just concatenates every token event into one growing answer) and is a common,
   transparent pattern for tool-calling chat. When the model requests tool calls, each is executed via
   `executeDataTool` and the JSON result is appended back as a `role: 'tool'` message; the loop continues until
   the model responds with plain text and no further tool calls (or the iteration cap is hit).
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
- `server/src/services/chat.service.ts` — the two-phase Groq loop described above, plus the `answer` tool
  definition and system prompt
- `server/src/controllers/chat.controller.ts`, `server/src/routes/chat.routes.ts` — SSE endpoint (`POST
  /api/chat`), mounted in `server/src/app.ts` — **unchanged** from v1
- `client/src/api/chat.ts`, `client/src/components/AiSearchPanel.tsx`, `client/src/pages/MoviesPage.tsx`,
  `client/src/index.css` (`.ai-panel`/`.ai-reference-chip`) — **entirely unchanged**; the SSE event contract
  (`token`/`final`/`error`) didn't change, so no client code needed to change for this redesign

## Config

Requires `GROQ_API_KEY` (get a free key at [console.groq.com](https://console.groq.com)) and optionally
`GROQ_MODEL` (default `llama-3.3-70b-versatile`) in `server/.env` — see `server/.env.example`.

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
   `get_person_filmography`, and an aggregation question (e.g. "which genre has the highest average score?")
   to exercise `aggregate_titles_by`.
7. Try a nonsense question to confirm the model returns a coherent "I don't know" rather than hallucinating
   references.

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
