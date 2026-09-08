# Movie Explorer (Elasticsearch POC)

React + TypeScript client, Node/Express + TypeScript API, backed by Elasticsearch. Indexes ~1000 real movies
(and their cast) from IMDb's official non-commercial datasets, with basic server-side search, inline score
editing, and adding new movies by pasting an IMDb URL.

## Prerequisites

- Node.js 18+ and npm
- Docker Desktop (for Elasticsearch + Kibana)

## 1. Start Elasticsearch

```
docker compose up -d
```

This starts Elasticsearch on `http://localhost:9200` and Kibana on `http://localhost:5601` (no auth, single-node,
for local dev only).

## 2. Install dependencies

```
npm run install:all
```

(or `npm install` inside `server/` and `client/` separately)

Copy the env files if you want to override defaults:

```
copy server\.env.example server\.env
copy client\.env.example client\.env
```

## 3. Seed the data (one-time)

From `server/`:

```
cd server
npm run seed
```

This runs three steps:

1. `seed:download` — downloads IMDb's public dataset files (`title.basics`, `title.ratings`, `title.principals`,
   `name.basics`) from `datasets.imdbws.com` into `server/data/.cache/`. **`title.principals.tsv.gz` is a few
   hundred MB** — this step can take several minutes depending on your connection, and re-runs are skipped if
   the files already exist.
2. `seed:build` — streams those files, picks the ~1000 most-voted real movies, pulls their top-billed cast, and
   writes `server/data/seed-movies.json` + `server/data/seed-actors.json`. Also takes a few minutes since it has
   to scan the full dataset files.
3. `seed:index` — creates the `movies`/`actors` Elasticsearch indices (if missing) and bulk-indexes both files.

IMDb's bulk datasets don't include plot summaries, so seeded movies get a short auto-generated description.
Movies added later via "Add Movie" (by pasting an IMDb URL) get their real plot description scraped from that
page instead.

## 4. Run the app

From the repo root:

```
npm run dev
```

This runs the API on `http://localhost:4000` and the client on `http://localhost:5173`. (Or run
`npm run dev` inside `server/` and `client/` in separate terminals.)

## API

- `GET /api/movies?q=&page=&size=` — search movies (title/description/genres)
- `GET /api/movies/:id`
- `POST /api/movies { imdbUrl }` — scrape an IMDb title page and index it (creates linked actors as needed)
- `PATCH /api/movies/:id { score, description?, title? }` — edit a movie
- `GET /api/actors?q=&movieId=&page=&size=` — search actors by name, or list an entire movie's cast via `movieId`
- `GET /api/actors/:id`
- `POST /api/chat { question }` — AI chat search (SSE); see [docs/ai-chat-search.md](docs/ai-chat-search.md).
  Requires `ANTHROPIC_API_KEY` in `server/.env`.

## Notes

- Actor cast data scraped from a single IMDb page (via "Add Movie") only has names, not IMDb's stable actor IDs
  (`nconst`), so those actors are matched/created by exact name.
- Elasticsearch runs without security enabled — fine for local POC use, not for production.
