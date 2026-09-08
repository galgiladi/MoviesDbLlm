# AI Chat "Smart Search" on the Movies Page

Status: implemented.

## Context

The Movies page (`client/src/pages/MoviesPage.tsx`) only supports lexical keyword search (`multi_match` over
`title`/`description`/`genres`, see `server/src/services/movies.service.ts`). It can't answer analytical
natural-language questions like *"who was the busiest actor in the last 10 years"* because that requires
reasoning across the nested `cast` field, not a text match. This feature adds an "Ask AI" chat panel to the
Movies page where the user asks free-form questions and gets a grounded, streamed answer that cites the actual
movies/actors it's based on (clickable references, not hallucinated text).

Decisions made along the way:
- **LLM**: Anthropic Claude.
- **UI placement**: an embedded panel/toggle on the existing `MoviesPage`, not a separate route.
- **Response mode**: streamed (SSE) so text appears progressively like a real chat.
- **Conversation scope**: stateless — one question in, one answer out, no multi-turn history for v1.
- **Data-access approach**: an earlier design gave Claude a tool to author its own Elasticsearch query DSL at
  answer time. That was rejected as too risky (script-injection/DoS surface from letting a model author live
  query DSL). Given the dataset is small (1000 movies, ~1.27MB in `server/data/seed-movies.json`, each with
  nested cast), the safer design is **context stuffing**: the server runs one fixed, hardcoded query it wrote
  itself (a plain `match_all` fetch of the whole `movies` index — never a model-authored query), trims it to
  relevant fields, and hands that as ground-truth context to Claude. Claude then computes answers (counts,
  "most appearances," filters by year/genre, etc.) purely by reasoning over the data it was given. **Claude
  never sends a query to Elasticsearch itself** — eliminating the entire class of injection/DoS risk that came
  with letting the model author arbitrary query DSL against a live cluster. This trades that risk for token
  cost, mitigated with Anthropic prompt caching.

## Architecture

**Context-stuffed single-turn completion, server-side.** The client POSTs the question to `/api/chat`. The
server:

1. Builds (or reuses a cached) **trimmed data context**: one `match_all`-style fetch of the entire `movies`
   index, mapped down to only the fields useful for reasoning: `id, title, year, genres, description, score,
   numVotes, cast: [{actorId, name}]`. Dropped: `imdbUrl`, `posterUrl`, `runtimeMinutes`, `createdAt`,
   `updatedAt` — not needed to answer questions, only used by detail pages the UI already has. The `actors`
   index is not fetched separately — `movies.cast` already contains every actor/movie relationship needed.
2. Sends Claude a system prompt containing that context block (marked for Anthropic prompt caching), today's
   date (so "recent 10 years" resolves correctly), and instructions to answer only from the given data and
   ground every claim in it.
3. Sends the user's question as the user message, and streams Claude's response via SSE.
4. Claude's reply ends with a required **structured `answer` tool call**: `{ references: [{ type: 'movie' |
   'actor', id: string, title: string }] }`. The visible answer text is accumulated server-side from the
   streamed text deltas rather than repeated inside the tool call. Because the only data Claude has is the
   context block itself, every `id`/`title` it cites necessarily comes from that block.
5. The server streams: text deltas live as SSE `token` events, then a terminal SSE `final` event carrying
   `{ text, references }`, then closes the stream.

No tool-based data retrieval loop is used — this is simpler than a typical RAG/agentic setup precisely because
the whole corpus already fits in context. The only "tool" Claude has is the terminal `answer` call, used to get
structured, parseable output instead of free-form prose.

**Prompt caching for cost/freshness.** Resending ~1.27MB of trimmed JSON on every question would be slow and
expensive without mitigation:
- `server/src/services/moviesContext.service.ts` builds the trimmed context block and caches it in memory with
  a short TTL (5 minutes).
- The block is also marked with Anthropic's native prompt-caching directive (`cache_control: { type:
  'ephemeral' }`) on the system prompt content block, so repeated questions within the cache window reuse
  Claude-side cached input tokens instead of reprocessing the full context every time.
- The in-memory cache is invalidated whenever `createMovie` or `patchMovie` runs (`movies.service.ts`), so
  newly added movies or edited scores show up in chat answers promptly. This only works because the dataset is
  small; it would need to become real retrieval again if the catalog grew to a much larger scale — a known,
  explicit limitation of this choice.

## Key files

- `server/src/services/moviesContext.service.ts` — trimmed/cached context builder (the one fixed ES query)
- `server/src/services/chat.service.ts` — builds the Claude request, streams tokens + final structured answer
- `server/src/services/movies.service.ts` — calls `invalidateMoviesContext()` in `createMovie`/`patchMovie`
- `server/src/controllers/chat.controller.ts`, `server/src/routes/chat.routes.ts` — SSE endpoint (`POST
  /api/chat`), mounted in `server/src/app.ts`
- `client/src/api/chat.ts` — SSE client helper (manual `fetch` + stream parsing, since `EventSource` doesn't
  support POST bodies)
- `client/src/components/AiSearchPanel.tsx` — chat UI (toggle, input, streamed answer, reference chips linking
  to `/movies/:id` / `/actors/:id`)
- `client/src/pages/MoviesPage.tsx` — "Ask AI" toggle wiring
- `client/src/index.css` — `.ai-panel` / `.ai-reference-chip` styles, reusing existing CSS custom properties

## Config

Requires `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`, default `claude-sonnet-5`) in `server/.env` —
see `server/.env.example`.

## Verification

1. `npm run es:up` then `npm run seed` (if not already seeded) to ensure the `movies` index has real IMDb data
   with populated `cast`/`year` fields.
2. Add `ANTHROPIC_API_KEY` to `server/.env`.
3. `npm run dev` (root) to start client + server together.
4. `curl -N -X POST http://localhost:4000/api/chat -H "Content-Type: application/json" -d
   "{\"question\":\"who was the busiest actor in the last 10 years\"}"` and confirm SSE frames stream, ending
   in a `final` event with non-empty, plausible `references`.
5. In the browser, open the Movies page, click "Ask AI", ask the same question, and confirm: text streams in
   progressively, reference chips render below the answer, and clicking a chip navigates to the correct
   `/movies/:id` or `/actors/:id` page with matching data.
6. Try a different analytical question (e.g. "what genre has the highest average score?") and a simple
   descriptive one (e.g. "movies about time travel from the 90s") to confirm both reasoning styles work from
   context alone.
7. Add a new movie via "Add Movie", then ask a question that should include it — confirm it shows up once
   `invalidateMoviesContext()` has cleared the cache.
8. Try a nonsense question to confirm Claude returns a coherent "I don't know" via the `answer` tool rather
   than hallucinating references.
