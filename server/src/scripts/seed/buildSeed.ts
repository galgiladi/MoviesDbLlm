import fs from 'fs';
import path from 'path';
import { CreditCategory } from '../../types/movie';
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

const TARGET_MOVIE_COUNT = 100_000;
const CREDIT_CATEGORIES: readonly CreditCategory[] = ['actor', 'actress', 'director', 'writer', 'producer'];
const MAX_CREDITS_PER_MOVIE = 15;

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

interface CreditRef {
  personId: string;
  category: CreditCategory;
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
  credits: { personId: string; name: string; category: CreditCategory; character?: string }[];
}

interface SeedActor {
  id: string;
  name: string;
  birthYear?: number;
  filmography: { titleId: string; title: string; category: CreditCategory; character?: string }[];
}

function templateDescription(m: MovieBase): string {
  const genreText = m.genres.length ? m.genres.join(', ') : 'Drama';
  const yearText = m.year ? ` (${m.year})` : '';
  return `${m.title}${yearText} is a ${genreText} film.`;
}

async function loadRatingCandidates(): Promise<Map<string, RatingRow>> {
  console.log('Reading title.ratings.tsv.gz ...');
  // No pool cap here: at 100,000-movie scale, trimming to an arbitrary top-N-by-votes window
  // (regardless of title type) risks running out of *movie*-type matches before the target is
  // reached, since tvSeries/tvEpisode/videoGame titles compete for the same top-voted ranks.
  // We're already reading every rated row into memory below, so a cap wouldn't save memory
  // anyway - it would only reintroduce that risk.
  const candidates = new Map<string, RatingRow>();
  let scanned = 0;
  for await (const row of streamTsvGz(path.join(CACHE_DIR, 'title.ratings.tsv.gz'))) {
    scanned += 1;
    if (scanned % 500_000 === 0) console.log(`  read ${scanned.toLocaleString()} rating rows ...`);
    const numVotes = toIntOrUndefined(row.numVotes);
    const averageRating = toFloatOrUndefined(row.averageRating);
    if (numVotes === undefined || averageRating === undefined) continue;
    candidates.set(row.tconst, { tconst: row.tconst, averageRating, numVotes });
  }
  console.log(`Loaded ${candidates.size.toLocaleString()} rated titles.`);
  return candidates;
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
  console.log(`Found ${matches.length.toLocaleString()} candidate movies, keeping top ${top.length.toLocaleString()}.`);
  return top;
}

async function loadCreditsForMovies(movieIds: Set<string>): Promise<Map<string, CreditRef[]>> {
  console.log('Scanning title.principals.tsv.gz for credits (this is the largest file, may take a while) ...');
  const creditsByMovie = new Map<string, CreditRef[]>();
  let scanned = 0;

  for await (const row of streamTsvGz(path.join(CACHE_DIR, 'title.principals.tsv.gz'))) {
    scanned += 1;
    if (scanned % 5_000_000 === 0) console.log(`  scanned ${scanned.toLocaleString()} principal rows ...`);

    if (!movieIds.has(row.tconst)) continue;
    if (!(CREDIT_CATEGORIES as readonly string[]).includes(row.category)) continue;

    const list = creditsByMovie.get(row.tconst) ?? [];
    list.push({
      personId: row.nconst,
      category: row.category as CreditCategory,
      ordering: toIntOrUndefined(row.ordering) ?? 999,
      character: parseFirstCharacter(row.characters),
    });
    creditsByMovie.set(row.tconst, list);
  }

  for (const [tconst, list] of creditsByMovie) {
    list.sort((a, b) => a.ordering - b.ordering);
    creditsByMovie.set(tconst, list.slice(0, MAX_CREDITS_PER_MOVIE));
  }

  console.log(`Collected credits for ${creditsByMovie.size.toLocaleString()} movies.`);
  return creditsByMovie;
}

async function loadPersonNames(personIds: Set<string>): Promise<Map<string, { name: string; birthYear?: number }>> {
  console.log('Scanning name.basics.tsv.gz for person names ...');
  const names = new Map<string, { name: string; birthYear?: number }>();
  let scanned = 0;

  for await (const row of streamTsvGz(path.join(CACHE_DIR, 'name.basics.tsv.gz'))) {
    scanned += 1;
    if (scanned % 2_000_000 === 0) console.log(`  scanned ${scanned.toLocaleString()} names ...`);

    if (!personIds.has(row.nconst)) continue;
    names.set(row.nconst, { name: row.primaryName, birthYear: toIntOrUndefined(row.birthYear) });
    if (names.size === personIds.size) break;
  }

  console.log(`Resolved ${names.size.toLocaleString()}/${personIds.size.toLocaleString()} person names.`);
  return names;
}

async function main() {
  for (const file of ['title.basics.tsv.gz', 'title.ratings.tsv.gz', 'title.principals.tsv.gz', 'name.basics.tsv.gz']) {
    if (!fs.existsSync(path.join(CACHE_DIR, file))) {
      console.error(`Missing ${file} in ${CACHE_DIR}. Run "npm run seed:download" first.`);
      process.exit(1);
    }
  }

  const candidates = await loadRatingCandidates();
  const topMovies = await findTopMovies(candidates);
  const movieIds = new Set(topMovies.map((m) => m.id));

  const creditsByMovie = await loadCreditsForMovies(movieIds);
  const personIds = new Set<string>();
  for (const list of creditsByMovie.values()) {
    for (const c of list) personIds.add(c.personId);
  }

  const personNames = await loadPersonNames(personIds);

  const seedMovies: SeedMovie[] = topMovies.map((m) => ({
    ...m,
    description: templateDescription(m),
    imdbUrl: `https://www.imdb.com/title/${m.id}/`,
    credits: (creditsByMovie.get(m.id) ?? [])
      .filter((c) => personNames.has(c.personId))
      .map((c) => ({
        personId: c.personId,
        name: personNames.get(c.personId)!.name,
        category: c.category,
        character: c.character,
      })),
  }));

  const peopleMap = new Map<string, SeedActor>();
  for (const movie of seedMovies) {
    for (const credit of movie.credits) {
      const info = personNames.get(credit.personId)!;
      const person = peopleMap.get(credit.personId) ?? {
        id: credit.personId,
        name: info.name,
        birthYear: info.birthYear,
        filmography: [],
      };
      person.filmography.push({ titleId: movie.id, title: movie.title, category: credit.category, character: credit.character });
      peopleMap.set(credit.personId, person);
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'seed-movies.json'), JSON.stringify(seedMovies, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'seed-actors.json'), JSON.stringify([...peopleMap.values()], null, 2));

  console.log(`Wrote ${seedMovies.length.toLocaleString()} movies and ${peopleMap.size.toLocaleString()} people to server/data/.`);
}

main().catch((err) => {
  console.error('Seed build failed:', err);
  process.exit(1);
});
