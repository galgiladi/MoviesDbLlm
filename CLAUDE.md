# elastic-poc — Movie Explorer

A demo app: React + TypeScript client, Node/Express + TypeScript API, Elasticsearch as the datastore. Indexes
up to ~100,000 real movies (title/year/genres/rating + actor, actress, director, writer, and producer credits)
from IMDb's official bulk datasets, with server-side search, an "Ask AI" panel backed by Claude, inline score
editing, and adding new movies by pasting an IMDb URL.

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
  - `chat.service.ts` + `moviesContext.service.ts` — the **Ask AI** feature (added after the original plan):
    streams a Claude answer (via `@anthropic-ai/sdk`, model from `ANTHROPIC_MODEL`) grounded only in the
    current movie data. `moviesContext.service.ts` builds/caches a JSON context block from ES (5 min TTL,
    invalidated on movie create/update) and Claude is instructed to cite only movies/actors from that block,
    reporting citations via a forced tool call (`answer`) so the UI can render clickable reference chips.
    **Note:** `MAX_MOVIES` in `moviesContext.service.ts` is still hardcoded to 20 (a leftover smoke-test cap
    from before the index could hold 100,000 movies) — context-stuffing the *entire* index stops being viable
    at this scale, so raising this number meaningfully requires the tool-based retrieval redesign mentioned
    below, not just a bigger constant.
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
- Any code path that changes movie data must call `invalidateMoviesContext()` (see `movies.service.ts`) so
  Ask AI doesn't answer from a stale cached context.
- `server/.env` and `client/.env` are gitignored; `.env.example` in each documents the required vars
  (`ANTHROPIC_API_KEY` is required for Ask AI to work).

## Known follow-ups (not started)

- **Ask AI at scale**: the context-stuffing approach only works because it currently caps at 20 movies; a real
  redesign (tool-based retrieval instead of stuffing the whole index) is needed before it can reason over the
  full 100,000-movie catalog. Deliberately out of scope for this pass.
- **Plot summaries**: deferred, would need a TMDb (or similar) enrichment step per movie.
- **tvSeries / videoGame titles**: explicitly out of scope for now; the pipeline only indexes `titleType=movie`.
