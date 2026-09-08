import fs from 'fs';
import path from 'path';
import {
  streamTsvGz,
  nullable,
  toIntOrUndefined,
  toFloatOrUndefined,
  parseGenres,
  parseFirstCharacter,
} from './tsvStream';

const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', '.cache');
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');

const TARGET_MOVIE_COUNT = 1000;
const RATING_CANDIDATE_POOL = 20000; // generous buffer: many top-voted rows are TV series/episodes, not movies
const MAX_CAST_PER_MOVIE = 8;

interface RatingRow {
  tconst: string;
  averageRating: number;
  numVotes: number;
}

interface MovieBase {
  id: string;
  title: string;
  year?: number;
  genres: string[];
  runtimeMinutes?: number;
  score?: number;
  numVotes?: number;
}

interface CastRef {
  actorId: string;
  ordering: number;
  character?: string;
}

interface SeedMovie {
  id: string;
  title: string;
  year?: number;
  genres: string[];
  runtimeMinutes?: number;
  score?: number;
  numVotes?: number;
  description: string;
  imdbUrl: string;
  cast: { actorId: string; name: string; character?: string }[];
}

interface SeedActor {
  id: string;
  name: string;
  birthYear?: number;
  movies: { movieId: string; title: string; character?: string }[];
}

function templateDescription(m: MovieBase): string {
  const genreText = m.genres.length ? m.genres.join(', ') : 'Drama';
  const yearText = m.year ? ` (${m.year})` : '';
  return `${m.title}${yearText} is a ${genreText} film.`;
}

async function loadTopRatingCandidates(): Promise<Map<string, RatingRow>> {
  console.log('Reading title.ratings.tsv.gz ...');
  const all: RatingRow[] = [];
  for await (const row of streamTsvGz(path.join(CACHE_DIR, 'title.ratings.tsv.gz'))) {
    const numVotes = toIntOrUndefined(row.numVotes);
    const averageRating = toFloatOrUndefined(row.averageRating);
    if (numVotes === undefined || averageRating === undefined) continue;
    all.push({ tconst: row.tconst, averageRating, numVotes });
  }
  all.sort((a, b) => b.numVotes - a.numVotes);
  const top = all.slice(0, RATING_CANDIDATE_POOL);
  console.log(`Loaded ${all.length} rated titles, keeping top ${top.length} candidates by vote count.`);
  return new Map(top.map((r) => [r.tconst, r]));
}

async function findTopMovies(candidates: Map<string, RatingRow>): Promise<MovieBase[]> {
  console.log('Scanning title.basics.tsv.gz for movies among candidates ...');
  const matches: MovieBase[] = [];
  let scanned = 0;

  for await (const row of streamTsvGz(path.join(CACHE_DIR, 'title.basics.tsv.gz'))) {
    scanned += 1;
    if (scanned % 1_000_000 === 0) console.log(`  scanned ${scanned.toLocaleString()} titles ...`);

    if (row.titleType !== 'movie') continue;
    if (nullable(row.isAdult) === '1') continue;

    const rating = candidates.get(row.tconst);
    if (!rating) continue;

    matches.push({
      id: row.tconst,
      title: row.primaryTitle || row.originalTitle || row.tconst,
      year: toIntOrUndefined(row.startYear),
      genres: parseGenres(row.genres),
      runtimeMinutes: toIntOrUndefined(row.runtimeMinutes),
      score: rating.averageRating,
      numVotes: rating.numVotes,
    });
  }

  matches.sort((a, b) => (b.numVotes ?? 0) - (a.numVotes ?? 0));
  const top = matches.slice(0, TARGET_MOVIE_COUNT);
  console.log(`Found ${matches.length} candidate movies, keeping top ${top.length}.`);
  return top;
}

async function loadCastForMovies(movieIds: Set<string>): Promise<Map<string, CastRef[]>> {
  console.log('Scanning title.principals.tsv.gz for cast (this is the largest file, may take a while) ...');
  const castByMovie = new Map<string, CastRef[]>();
  let scanned = 0;

  for await (const row of streamTsvGz(path.join(CACHE_DIR, 'title.principals.tsv.gz'))) {
    scanned += 1;
    if (scanned % 5_000_000 === 0) console.log(`  scanned ${scanned.toLocaleString()} principal rows ...`);

    if (!movieIds.has(row.tconst)) continue;
    if (row.category !== 'actor' && row.category !== 'actress') continue;

    const list = castByMovie.get(row.tconst) ?? [];
    list.push({
      actorId: row.nconst,
      ordering: toIntOrUndefined(row.ordering) ?? 999,
      character: parseFirstCharacter(row.characters),
    });
    castByMovie.set(row.tconst, list);
  }

  for (const [tconst, list] of castByMovie) {
    list.sort((a, b) => a.ordering - b.ordering);
    castByMovie.set(tconst, list.slice(0, MAX_CAST_PER_MOVIE));
  }

  console.log(`Collected cast for ${castByMovie.size} movies.`);
  return castByMovie;
}

async function loadActorNames(actorIds: Set<string>): Promise<Map<string, { name: string; birthYear?: number }>> {
  console.log('Scanning name.basics.tsv.gz for actor names ...');
  const names = new Map<string, { name: string; birthYear?: number }>();
  let scanned = 0;

  for await (const row of streamTsvGz(path.join(CACHE_DIR, 'name.basics.tsv.gz'))) {
    scanned += 1;
    if (scanned % 2_000_000 === 0) console.log(`  scanned ${scanned.toLocaleString()} names ...`);

    if (!actorIds.has(row.nconst)) continue;
    names.set(row.nconst, { name: row.primaryName, birthYear: toIntOrUndefined(row.birthYear) });
    if (names.size === actorIds.size) break;
  }

  console.log(`Resolved ${names.size}/${actorIds.size} actor names.`);
  return names;
}

async function main() {
  for (const file of ['title.basics.tsv.gz', 'title.ratings.tsv.gz', 'title.principals.tsv.gz', 'name.basics.tsv.gz']) {
    if (!fs.existsSync(path.join(CACHE_DIR, file))) {
      console.error(`Missing ${file} in ${CACHE_DIR}. Run "npm run seed:download" first.`);
      process.exit(1);
    }
  }

  const candidates = await loadTopRatingCandidates();
  const topMovies = await findTopMovies(candidates);
  const movieIds = new Set(topMovies.map((m) => m.id));

  const castByMovie = await loadCastForMovies(movieIds);
  const actorIds = new Set<string>();
  for (const list of castByMovie.values()) {
    for (const c of list) actorIds.add(c.actorId);
  }

  const actorNames = await loadActorNames(actorIds);

  const seedMovies: SeedMovie[] = topMovies.map((m) => ({
    ...m,
    description: templateDescription(m),
    imdbUrl: `https://www.imdb.com/title/${m.id}/`,
    cast: (castByMovie.get(m.id) ?? [])
      .filter((c) => actorNames.has(c.actorId))
      .map((c) => ({
        actorId: c.actorId,
        name: actorNames.get(c.actorId)!.name,
        character: c.character,
      })),
  }));

  const actorsMap = new Map<string, SeedActor>();
  for (const movie of seedMovies) {
    for (const cast of movie.cast) {
      const info = actorNames.get(cast.actorId)!;
      const actor = actorsMap.get(cast.actorId) ?? {
        id: cast.actorId,
        name: info.name,
        birthYear: info.birthYear,
        movies: [],
      };
      actor.movies.push({ movieId: movie.id, title: movie.title, character: cast.character });
      actorsMap.set(cast.actorId, actor);
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'seed-movies.json'), JSON.stringify(seedMovies, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'seed-actors.json'), JSON.stringify([...actorsMap.values()], null, 2));

  console.log(`Wrote ${seedMovies.length} movies and ${actorsMap.size} actors to server/data/.`);
}

main().catch((err) => {
  console.error('Seed build failed:', err);
  process.exit(1);
});
