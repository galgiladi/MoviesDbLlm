# elastic-poc — Movie Explorer

A demo app: React + TypeScript client, Node/Express + TypeScript API, Elasticsearch as the datastore. Indexes
up to ~100,000 real movies (title/year/genres/rating + actor, actress, director, writer, and producer credits)
from IMDb's official bulk datasets, with server-side search (ranked by popularity), an "Ask AI" panel backed
by Groq (tool-calling over the real ES data, not a stuffed context), inline score editing, and adding new
movies by pasting an IMDb URL.

See [README.md](README.md) for setup/run steps. The original design plan lives in [docs/PLAN.md](docs/PLAN.md)
— its Phase 1 section is still accurate for the search/scrape pieces; § Phase 2 covers the scale-up and index
rename described below. The Ask AI feature (below) was added after Phase 1 and isn't reflected in it.

## Layout

```
elastic-poc/
  docker-compose.yml   # Elasticsearch 8.15 + Kibana, no auth, localhost:9200 / :5601
  server/              # Express + TypeScript API
  client/              # React + TypeScript client (Vite)
```

Two independent npm projects (`server/`, `client/`); a root `package.json` runs both together (`npm run dev`
at the repo root, via `concurrently`).

## Server (`server/`)

- `src/index.ts` → `app.ts`: bootstraps Express, calls `ensureIndices()` before listening.
- `src/es/`: `client.ts` (singleton `@elastic/elasticsearch` client), `indices.ts` (mappings + `ensureIndices()`
  for the `titles` and `people` indices — nested `credits`/`filmography` fields denormalize the relationship
  both ways since ES has no joins). Each credit/filmography entry carries a `category`:
  `actor | actress | director | writer | producer`, so a title's `credits` array covers its whole cast+crew in
  one unified list rather than separate arrays per role.
- `src/services/`:
  - `movies.service.ts`, `actors.service.ts` — search/get/create/patch against ES. `searchActors`'s `movieId`
    param (and the `GET /api/actors?movieId=` query param) is unchanged externally, but internally now queries
    the nested `filmography.titleId` field.
  - `imdbScrape.service.ts` — given an IMDb title URL, fetches the page and parses its embedded
    `<script type="application/ld+json">` block (far more stable than scraping DOM/CSS classes) for
    title/description/rating/genres/actor names. Only ever produces `category: 'actor'` credits (the scraped
    page doesn't distinguish roles or give stable IMDb `nconst`s).
  - `chat.service.ts` + `chat/tools.ts` — the **Ask AI** feature: a two-phase Groq (`groq-sdk`, model from
    `GROQ_MODEL`, default `openai/gpt-oss-120b`) tool-calling loop. Phase 1 streams turns where the model can
    call six fixed, ES-backed data tools (`search_titles`, `get_title_details`, `get_person_filmography`,
    `aggregate_titles_by`, `find_people_by_genre`, `semantic_search_plots` — defined in `chat/tools.ts`, the
    entire data-access boundary; the model never gets raw query DSL) until it produces a final text answer with
    no more tool calls, also streaming a `status` SSE event before each tool call so the UI shows real progress;
    phase 2 forces one more `answer` tool call (no data tools offered) purely to extract `{ references }` for
    the UI's clickable chips. The system prompt requires natural, Markdown-formatted answers with no mention of
    "the database"/tools — the client renders it with `react-markdown` + `remark-gfm`. See
    [docs/ai-chat-search.md](docs/ai-chat-search.md) for the full design and why it replaced an earlier
    context-stuffing version that stopped scaling once the index passed ~1,000 movies.
  - `embeddings.ts` — local (CPU, no API key, no rate limits) text embeddings via
    `@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2` in-process (384 dims). Backs both the
    one-time `enrich:embeddings` backfill and `semantic_search_plots`'s live query embedding. **Important**:
    `server/package.json` pins `overrides.onnxruntime-node` to `1.19.0` — newer versions dropped the native
    binary for `darwin-x64` (Intel Mac) entirely; without the override, loading the pipeline fails with
    `Cannot find module '.../onnxruntime_binding.node'` on this kind of machine. Don't remove the override
    without confirming darwin-x64 support is back.
- `src/controllers/` + `src/routes/`: `movies`, `actors`, `chat` — thin REST/SSE layer over the services.
- `src/scripts/seed/`: one-time seed pipeline (`npm run seed`, from `server/`):
  1. `download.ts` — downloads IMDb's public dataset files into `data/.cache/` (skips existing files).
  2. `buildSeed.ts` — streams those files (never loads the multi-GB ones fully into memory), picks the top
     100,000 most-voted real movies, pulls up to 15 top-billed credits per movie across
     actor/actress/director/writer/producer roles, writes `data/seed-movies.json` + `data/seed-actors.json`.
     IMDb's bulk data has no plot text, so seed movies get a short templated `description` — real plot text
     (via a TMDb enrichment step) is an explicit, deferred future addition, not part of this pipeline.
  3. `indexSeed.ts` — `ensureIndices()` then bulk-indexes both JSON files.
  Run `seed:download`/`seed:build`/`seed:index` individually if you need to redo one step (e.g. re-run
  `seed:index` if it fails because Elasticsearch was still starting — the container needs a beat after
  `docker compose up` before it accepts connections). At 100,000 movies, `seed:build`'s two full scans of
  `title.principals.tsv.gz` and `name.basics.tsv.gz` (both tens of millions of rows) are the slow steps —
  runtime is dominated by those linear file scans, not by the movie count itself.
- `src/scripts/enrich/plots.ts` (`npm run enrich:plots`): resumable pass that backfills real plot summaries
  from TMDb (`GET /3/find/{imdbId}?external_source=imdb_id`, one call per movie) directly onto the
  already-indexed `titles` docs — replaces the templated description with TMDb's `overview` (and sets
  `posterUrl` from TMDb's poster if present) wherever a match is found; movies TMDb doesn't have keep the
  templated description. Progress is persisted to `data/.cache/tmdb-plot-progress.json`, so it's safe to
  Ctrl+C and re-run later — already-attempted tconsts aren't retried. Requires `TMDB_API_KEY` (free key from
  themoviedb.org); concurrency is capped at 8 to stay under TMDb's free-tier rate limit. Run this before
  `enrich:embeddings` (below) — the embedding pass has nothing meaningful to embed until real plots exist.
- `src/scripts/enrich/embedPlots.ts` (`npm run enrich:embeddings`): resumable pass that computes a local
  embedding (`services/embeddings.ts`) of each movie's real plot summary and writes it to the `plotEmbedding`
  field, skipping movies still on the templated description (reconstructs the exact template string to detect
  this — nothing meaningful to embed there). Progress persisted to
  `data/.cache/plot-embedding-progress.json`. No API key needed (fully local); ~30ms/movie on CPU.

### API surface

- `GET /api/movies?q=&page=&size=` — search (title/description/genres)
- `GET /api/movies/:id`
- `POST /api/movies { imdbUrl }` — scrape + index a new movie, upserting its (actor-only) credits
- `PATCH /api/movies/:id { score, description?, title? }`
- `GET /api/actors?q=&movieId=&page=&size=` — name search, or full credits list for one movie via `movieId`
- `GET /api/actors/:id`
- `POST /api/chat { question }` — SSE stream (`token`/`final`/`error` events) for the Ask AI panel

Routes intentionally still say `/api/movies`/`/api/actors` even though the underlying indices are now
`titles`/`people` — renaming the routes wasn't part of this pass; revisit only if it becomes worth the client
churn.

## Client (`client/`)

React Router pages: `MoviesPage` (search + grid + the `AiSearchPanel` "Ask AI" toggle), `MovieDetailPage`
(cast — i.e. `credits` filtered to `actor`/`actress` — inline `ScoreEditor`), `AddMoviePage` (paste-IMDb-URL
form), `ActorsPage` (search by name or by movie via typeahead), `ActorDetailPage` (shows `filmography` with
each entry's role). `api/` holds typed fetch wrappers (`client.ts` reads `VITE_API_URL`, default
`http://localhost:4000`); `api/chat.ts` handles the SSE stream for Ask AI. Styling is plain CSS (`index.css`)
— no UI framework.

## Conventions worth preserving

- Titles/people are denormalized in both directions in ES (a title doc carries `credits`, a person doc carries
  `filmography`) specifically to support "search people by movie" and "show credits on a movie" without joins.
  Keep both sides in sync when adding new write paths (see `upsertActorForMovie` in `actors.service.ts`).
- Every credit/filmography entry carries a `category` (`actor | actress | director | writer | producer`); UI
  code that only wants cast should filter on `category === 'actor' || category === 'actress'` (see
  `MovieDetailPage.tsx`) rather than assuming every entry is an actor.
- Ask AI no longer caches or invalidates anything (no more `moviesContext.service.ts`) — every question runs
  real ES queries via the tools in `chat/tools.ts`, so new/edited movies show up immediately, not on a TTL.
- `server/.env` and `client/.env` are gitignored; `.env.example` in each documents the required vars
  (`GROQ_API_KEY` is required for Ask AI to work — free key at console.groq.com; `TMDB_API_KEY` is required for
  `npm run enrich:plots` — free key at themoviedb.org). `enrich:embeddings` and `semantic_search_plots` need no
  API key — the embedding model runs locally.

## Known follow-ups (not started)

- **Cross-genre/year person queries**: a query like "actor in a musical, action movie, and comedy all in the
  same year" isn't a single efficient tool call today, since `people.filmography` entries don't carry the
  title's genre/year (see `docs/PLAN.md`) — the model would have to chain several `get_title_details` calls
  and reason over the results itself. Documented in `docs/ai-chat-search.md`'s "Known limitation".
- **`find_people_by_genre` tool design**: added to answer "recommend a/an `<role>` for `<genre>` movies", but
  flagged as the wrong general shape — a bespoke tool per question pattern doesn't scale. Should be merged
  with `aggregate_titles_by` into one general aggregation tool (group by genre *or* by person+role) before
  adding more capabilities in this family; not done yet, left as one tool for now.
- **tvSeries / videoGame titles**: explicitly out of scope for now; the pipeline only indexes `titleType=movie`.
