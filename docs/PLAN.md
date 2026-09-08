# IMDb Movies + Actors on Elasticsearch (POC)

> Original design plan used to scaffold this project. Still accurate for the movies/actors/search/IMDb-scrape
> pieces described here. The **Ask AI** chat feature (`server/src/services/chat.service.ts` +
> `moviesContext.service.ts`, `client/src/components/AiSearchPanel.tsx`) was added afterward and isn't covered
> below — see [CLAUDE.md](CLAUDE.md) for that.

## Context

The user wants a demo app (Elasticsearch already provisioned via [docker-compose.yml](docker-compose.yml) — ES 8.15 + Kibana, no auth, `localhost:9200`) that:
- Indexes ~1000 real movies (title, description, score, genres, year...) into Elasticsearch
- Indexes the actors ("players") who appear in them, linked to their movies
- Serves a React client with basic search (handled server-side), a movies list/detail page, an "add movie by IMDb URL" page, inline score editing, and an actors page searchable by name or by movie

Per the user's earlier decisions:
- **Bulk seed data source**: IMDb's official non-commercial datasets (`datasets.imdbws.com`) — free, no API key, no rate limits, gives real IMDb IDs/titles/years/genres/ratings/cast. These files have **no plot text**, so seeded movies get a short templated description (user accepted this tradeoff explicitly).
- **Add-by-URL**: scrape the single IMDb title page's embedded `ld+json` block (robust structured data IMDb embeds on every title page — far more stable than scraping DOM/CSS classes) to get title/description/rating/genres/actor names for that one movie.

This is a greenfield directory (only docker-compose.yml exists), so this plan defines the full project scaffold.

## Architecture

Two independent TypeScript projects alongside the existing `docker-compose.yml`:

```
elastic-poc/
  docker-compose.yml       (existing — ES + Kibana)
  server/                  (Node + Express + TypeScript)
  client/                  (React + TypeScript, Vite)
  README.md                (setup/run instructions, incl. seed step & timing expectations)
```

### Elasticsearch modeling

Two indices, denormalized for fast search in both directions (ES has no real joins):

**`movies`**
- `id` (keyword, = IMDb tconst, e.g. `tt0111161`)
- `title` (text + `.keyword`), `year` (int), `genres` (keyword[]), `runtimeMinutes` (int)
- `score` (float, = IMDb averageRating), `numVotes` (int)
- `description` (text — templated for seed data, real plot text when added via URL scrape)
- `imdbUrl` (keyword), `posterUrl` (keyword, optional — only scrape gives this)
- `cast`: nested `[{ actorId, name, character }]` (denormalized for display on the movie page)
- `createdAt`/`updatedAt` (date)

**`actors`**
- `id` (keyword, = IMDb nconst, or a slug for scrape-added actors with no nconst)
- `name` (text + `.keyword`), `birthYear` (int, optional)
- `movies`: nested `[{ movieId, title, character }]` (denormalized — powers "search actors by movie" without a join)

### Backend — `server/`

```
server/
  src/
    index.ts, app.ts
    config/env.ts
    es/client.ts, es/indices.ts        # ES client singleton + index mappings + ensureIndices()
    types/movie.ts, types/actor.ts
    routes/movies.routes.ts, actors.routes.ts
    controllers/movies.controller.ts, actors.controller.ts
    services/movies.service.ts          # search/get/create/patch against ES
    services/actors.service.ts          # search by name / by movieId (nested query)
    services/imdbScrape.service.ts      # fetch IMDb title page, parse ld+json, map to Movie+Actor[]
    middleware/errorHandler.ts
    scripts/seed/
      download.ts     # stream-download + gunzip the 4 imdb dataset files into server/data/.cache (skips if already present)
      buildSeed.ts     # stream-parse TSVs with readline: filter title.basics to type=movie, join title.ratings,
                        # take top 1000 by numVotes desc; stream title.principals filtered to those tconsts (actor/actress);
                        # stream name.basics filtered to the resulting nconsts; write server/data/seed-movies.json + seed-actors.json
      indexSeed.ts     # ensureIndices() then bulk-index the two JSON files into ES
  package.json (express, @elastic/elasticsearch, axios, cheerio, dotenv, cors; ts-node-dev, typescript)
  tsconfig.json, .env.example (PORT, ES_NODE=http://localhost:9200, CLIENT_ORIGIN)
```

API surface:
- `GET /api/movies?q=&page=&size=` — `multi_match` on title (boosted) + description, paginated
- `GET /api/movies/:id`
- `POST /api/movies` `{ imdbUrl }` — scrapes the page, upserts any new actors (matched/created by name), indexes the movie, returns it
- `PATCH /api/movies/:id` `{ score }` — partial ES update (the requested "edit score"; endpoint is a generic partial-update so it isn't hard-locked to just that field)
- `GET /api/actors?q=&movieId=&page=&size=` — name search (`multi_match` on name) or, when `movieId` given, a nested query on `movies.movieId`
- `GET /api/actors/:id`

### Frontend — `client/` (React + TypeScript via Vite)

```
client/
  src/
    main.tsx, App.tsx, router (react-router-dom)
    api/client.ts, api/movies.ts, api/actors.ts   # typed fetch wrappers, base URL from VITE_API_URL
    types/movie.ts, types/actor.ts                # mirrors server types
    pages/
      MoviesPage.tsx        # search bar + paginated card grid
      MovieDetailPage.tsx   # details, cast list (links to actors), inline score editor
      AddMoviePage.tsx      # paste-IMDb-URL form -> POST /api/movies -> redirect to new movie
      ActorsPage.tsx        # search by name, or filter by movie (typeahead over /api/movies), card grid with each actor's movies
      ActorDetailPage.tsx
    components/
      NavBar.tsx, SearchBar.tsx, MovieCard.tsx, ActorCard.tsx, ScoreEditor.tsx, Pagination.tsx
    styles: plain CSS (no heavy UI framework) — clean card-grid layout, since seed data has no poster art (only scrape-added movies get `posterUrl`)
  package.json, tsconfig.json, vite.config.ts, .env.example (VITE_API_URL=http://localhost:4000)
```

Nav: **Movies | Add Movie | Actors**.

### Root convenience
Small root `package.json` with `concurrently` to run `docker compose up`, `server` dev, and `client` dev together via one `npm run dev`; plus a `README.md` documenting first-time setup, including that the one-time `npm run seed` in `server/` streams several large IMDb dataset files (largest, `title.principals.tsv.gz`, is a few hundred MB compressed) so it can take a few minutes.

## Verification
1. `docker compose up -d` — confirm ES reachable at `http://localhost:9200` and Kibana at `:5601`.
2. `cd server && npm install && npm run seed` — confirm `seed-movies.json`/`seed-actors.json` produced and bulk-indexed (script logs counts); spot check via `GET http://localhost:9200/movies/_count` and `_search`.
3. `npm run dev` (server) — hit `GET /api/movies?q=matrix` and `GET /api/actors?q=keanu` with curl/Postman, confirm results.
4. `cd client && npm install && npm run dev` — in the browser: search movies, open a movie detail page, edit its score and confirm it persists on refresh, use "Add Movie" with a real `imdb.com/title/tt...` URL and confirm it appears with description/cast, open Actors page and search by name and by movie.

---

## Phase 2 — Scaling up (current)

Status: implemented. This section describes what's actually in the code today; see [CLAUDE.md](../CLAUDE.md)
for the up-to-date file-by-file summary.

### Decisions locked in
- **Engine**: stays **Elasticsearch** — an OpenSearch swap was considered (to mirror the user's real production
  stack) but decided against for this pass to avoid extra migration risk/effort; revisit later if there's a
  concrete reason to. No client library or Docker service changes as a result.
- **Scale**: raise the seed cap from ~1,000 to **top 100,000 movies by `numVotes`** (still `titleType=movie`
  only — tvSeries/videoGame explicitly deferred). This does **not** meaningfully change indexing runtime: the
  pipeline already has to fully stream-scan `title.basics`/`title.ratings` (fixed-size full-file passes
  regardless of N) to compute the top-N, and fully stream-scan `title.principals` to pull credits for whichever
  tconsts were selected. Only the *output* size scales with N, and bulk-indexing 100k small JSON docs into
  Elasticsearch is still on the order of seconds to low minutes, not the bottleneck of the pipeline.
- **Roles**: expand beyond actors-only to **actor, actress, director, writer, producer** (all pulled from
  `title.principals`, which already carries these categories for top-billed credits — no need to add
  `title.crew.tsv` as a separate download for this pass).
- **Plot summaries**: explicitly **deferred**. IMDb's bulk datasets have zero plot/description field anywhere
  (`title.basics` only has `tconst, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear,
  runtimeMinutes, genres`). The only free source of real plot text is scraping each IMDb title page's `ld+json`
  block (what `imdbScrape.service.ts` already does for the single-URL "Add Movie" flow) — not viable in bulk for
  100k movies. Seeded movies keep the current templated description; real plot text (via TMDb API) stays a
  future enrichment step, added without needing to redo this phase.
- **Index naming**: rename `movies` → `titles` and `actors` → `people` now, ahead of actually needing the
  broader scope (tvSeries/videoGame, more roles) — avoids a rename/migration later. HTTP route paths
  (`/api/movies`, `/api/actors`) stay as-is for this pass to minimize client churn; only the Elasticsearch index
  names and internal service naming change. Revisit route naming if/when it becomes worth the churn.

### Updated Elasticsearch modeling

Two indices, same "denormalize both directions, no joins" approach as Phase 1, with roles now carried via a
`category` field instead of being actors-only:

**`titles`** (was `movies`)
- `id` (keyword, = tconst), `title` (text + `.keyword`), `year` (int), `genres` (keyword[]), `runtimeMinutes` (int)
- `score` (float, = averageRating), `numVotes` (int)
- `description` (text — still templated, no real plot yet)
- `imdbUrl` (keyword), `posterUrl` (keyword, optional)
- `credits`: nested `[{ personId, name, category, character? }]` — `category` is one of
  `actor|actress|director|writer|producer`; `character` only present for actor/actress. One unified nested array
  (not separate `cast`/`crew` arrays) so adding more roles later doesn't require a schema change.
- `createdAt`/`updatedAt` (date)

**`people`** (was `actors`)
- `id` (keyword, = nconst), `name` (text + `.keyword`), `birthYear` (int, optional)
- `filmography`: nested `[{ titleId, title, category, character? }]` — denormalized, powers "search people by
  title/role" without a join. **Not** denormalizing `genres`/`startYear` onto each filmography entry yet (that
  was specifically to support a harder "same-year cross-genre" query class that's out of scope for now); add it
  later if/when that becomes a real goal, since it's an additive field, not a redesign.

### Backend structure changes
- `server/src/es/` (`client.ts`, `indices.ts`) unchanged in location/client — only `indices.ts`'s index
  constants/mappings changed (`TITLES_INDEX`/`PEOPLE_INDEX`, `credits`/`filmography` nested fields with
  `category`). `server/.env`'s `ES_NODE` and `docker-compose.yml`'s `elasticsearch`/`kibana` services are
  unchanged, since the engine didn't change.
- `server/src/scripts/seed/`: same three-step shape (`download` → `buildSeed` → `indexSeed`), but `buildSeed.ts`
  raises the cap to 100,000, pulls the expanded role set from `title.principals`, and writes to the renamed
  `titles`/`people` shape; `indexSeed.ts` bulk-indexes via the same `@elastic/elasticsearch` client, just against
  the renamed indices.
- `server/src/services/movies.service.ts` / `actors.service.ts`: same responsibilities, updated for the new
  index names and unified `credits`/`filmography` shape.
- Client (`client/src/`): types/api wrappers updated for the new field shape (`credits` replacing `cast`, role
  `category` on each credit; `filmography` replacing `movies` with a `titleId` reference), page/component
  structure unchanged — reused as-is per the "same frontend" decision.

### Verification
1. `docker compose up -d` — confirm ES reachable at `http://localhost:9200` and Kibana at `:5601` (unchanged
   from Phase 1).
2. `cd server && npm run seed` — confirm the download/build/index steps complete and log up to 100,000 titles
   with populated `credits` spanning all five role categories; spot check via
   `GET http://localhost:9200/titles/_count`.
3. `npm run dev` (root) — confirm `GET /api/movies?q=...` and `GET /api/actors?q=...` still work end-to-end
   against the renamed indices, and the existing client pages (search, detail, actors) render correctly with no
   code changes needed beyond the type/field updates above.
