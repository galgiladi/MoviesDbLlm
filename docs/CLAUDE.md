# elastic-poc — Movie Explorer

A demo app: React + TypeScript client, Node/Express + TypeScript API, Elasticsearch as the datastore. Indexes
~1000 real movies (and cast) from IMDb's official bulk datasets, with server-side search, an "Ask AI" panel
backed by Claude, inline score editing, and adding new movies by pasting an IMDb URL.

See [README.md](README.md) for setup/run steps. The original design plan (data-source tradeoffs, ES modeling,
API surface) lives in [PLAN.md](PLAN.md) — still accurate for the core movies/actors/search/scrape pieces; the
Ask AI feature (below) was added after that plan and isn't reflected in it.

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
  for the `movies` and `actors` indices — nested `cast`/`movies` fields denormalize the relationship both ways
  since ES has no joins).
- `src/services/`:
  - `movies.service.ts`, `actors.service.ts` — search/get/create/patch against ES.
  - `imdbScrape.service.ts` — given an IMDb title URL, fetches the page and parses its embedded
    `<script type="application/ld+json">` block (far more stable than scraping DOM/CSS classes) for
    title/description/rating/genres/actor names.
  - `chat.service.ts` + `moviesContext.service.ts` — the **Ask AI** feature (added after the original plan):
    streams a Claude answer (via `@anthropic-ai/sdk`, model from `ANTHROPIC_MODEL`) grounded only in the
    current movie data. `moviesContext.service.ts` builds/caches a JSON context block from ES (5 min TTL,
    invalidated on movie create/update) and Claude is instructed to cite only movies/actors from that block,
    reporting citations via a forced tool call (`answer`) so the UI can render clickable reference chips.
    **Note:** `MAX_MOVIES` in `moviesContext.service.ts` is currently hardcoded to 20 (not the full 1000) —
    left that way mid-change to cheaply smoke-test the Anthropic key/billing; bump it back up before relying
    on Ask AI for real answers across the whole catalog.
- `src/controllers/` + `src/routes/`: `movies`, `actors`, `chat` — thin REST/SSE layer over the services.
- `src/scripts/seed/`: one-time seed pipeline (`npm run seed`, from `server/`):
  1. `download.ts` — downloads IMDb's public dataset files into `data/.cache/` (skips existing files).
  2. `buildSeed.ts` — streams those files (never loads them fully into memory), picks the ~1000 most-voted
     real movies, pulls their top-billed cast, writes `data/seed-movies.json` + `data/seed-actors.json`.
     IMDb's bulk data has no plot text, so seed movies get a short templated `description`.
  3. `indexSeed.ts` — `ensureIndices()` then bulk-indexes both JSON files.
  Run `seed:download`/`seed:build`/`seed:index` individually if you need to redo one step (e.g. re-run
  `seed:index` if it fails because Elasticsearch was still starting — the container needs a beat after
  `docker compose up` before it accepts connections).

### API surface

- `GET /api/movies?q=&page=&size=` — search (title/description/genres)
- `GET /api/movies/:id`
- `POST /api/movies { imdbUrl }` — scrape + index a new movie, upserting cast (actors matched/created by exact
  name, since scraped data has no stable IMDb `nconst`)
- `PATCH /api/movies/:id { score, description?, title? }`
- `GET /api/actors?q=&movieId=&page=&size=` — name search, or full cast of one movie via `movieId`
- `GET /api/actors/:id`
- `POST /api/chat { question }` — SSE stream (`token`/`final`/`error` events) for the Ask AI panel

## Client (`client/`)

React Router pages: `MoviesPage` (search + grid + the `AiSearchPanel` "Ask AI" toggle), `MovieDetailPage`
(cast, inline `ScoreEditor`), `AddMoviePage` (paste-IMDb-URL form), `ActorsPage` (search by name or by movie
via typeahead), `ActorDetailPage`. `api/` holds typed fetch wrappers (`client.ts` reads `VITE_API_URL`,
default `http://localhost:4000`); `api/chat.ts` handles the SSE stream for Ask AI. Styling is plain CSS
(`index.css`) — no UI framework.

## Conventions worth preserving

- Movies/actors are denormalized in both directions in ES (movie docs carry `cast`, actor docs carry
  `movies`) specifically to support "search actors by movie" and "show cast on a movie" without joins. Keep
  both sides in sync when adding new write paths (see `upsertActorForMovie` in `actors.service.ts`).
- Any code path that changes movie data must call `invalidateMoviesContext()` (see `movies.service.ts`) so
  Ask AI doesn't answer from a stale cached context.
- `server/.env` and `client/.env` are gitignored; `.env.example` in each documents the required vars
  (`ANTHROPIC_API_KEY` is required for Ask AI to work).
