import Groq from 'groq-sdk';
import { esClient } from '../../es/client';
import { TITLES_INDEX, PEOPLE_INDEX } from '../../es/indices';
import { Movie } from '../../types/movie';
import { Actor } from '../../types/actor';

/**
 * Every tool the model can call is a small, hardcoded ES query — never a passthrough for
 * model-authored query DSL. This is the entire data-access boundary for the chat feature.
 */

type ToolDefinition = Groq.Chat.Completions.ChatCompletionTool;
type ToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asInt(value: unknown): number | undefined {
  // Number(null) is 0, not NaN — the model can legitimately send `null` for an unset optional
  // field (Groq's tool-call schema requires it to be an allowed type), so that must be treated
  // the same as "absent", not coerced into a real 0.
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = asInt(value);
  if (n === undefined) return fallback;
  return Math.min(Math.max(n, 1), max);
}

const searchTitles: ToolExecutor = async (args) => {
  const query = asString(args.query);
  const genre = asString(args.genre);
  const yearFrom = asInt(args.yearFrom);
  const yearTo = asInt(args.yearTo);
  // Kept deliberately small — every tool result gets echoed back into the conversation history
  // for every subsequent call in the loop, so oversized results compound quickly against the
  // free tier's tight tokens-per-minute budget (observed: 8000 TPM, easily exhausted by a
  // single multi-turn question).
  const limit = clampLimit(args.limit, 6, 10);

  const filter: Record<string, unknown>[] = [];
  if (genre) filter.push({ term: { genres: genre } });
  if (yearFrom !== undefined || yearTo !== undefined) {
    filter.push({ range: { year: { gte: yearFrom, lte: yearTo } } });
  }

  // operator: 'and' matters a lot here: with the default 'or', a multi-word query like
  // "Spider-Man" tokenizes to ["spider", "man"], and "man" alone is common enough to match tons
  // of unrelated movies (Iron Man, ...) — which, combined with sorting by popularity, let famous
  // unrelated blockbusters swamp the real matches. 'and' requires every term to actually appear
  // (fuzzy-matched, so minor typos are still fine) before a document counts as a hit at all.
  const must = query
    ? [{ multi_match: { query, fields: ['title^3', 'description', 'genres'], operator: 'and' as const, fuzziness: 'AUTO' } }]
    : [{ match_all: {} }];

  const result = await esClient.search<Movie>({
    index: TITLES_INDEX,
    query: { bool: { must, filter } },
    size: limit,
    sort: [{ numVotes: 'desc' as const }, { score: 'desc' as const }],
  });

  const total = typeof result.hits.total === 'number' ? result.hits.total : result.hits.total?.value ?? 0;

  return {
    total,
    items: result.hits.hits.map((hit) => {
      const m = hit._source as Movie;
      return { id: m.id, title: m.title, year: m.year, genres: m.genres, score: m.score, numVotes: m.numVotes };
    }),
  };
};

const getTitleDetails: ToolExecutor = async (args) => {
  const id = asString(args.id);
  if (!id) return { error: 'id is required' };

  try {
    const result = await esClient.get<Movie>({ index: TITLES_INDEX, id });
    const m = result._source;
    if (!m) return { found: false };
    return {
      found: true,
      id: m.id,
      title: m.title,
      year: m.year,
      genres: m.genres,
      runtimeMinutes: m.runtimeMinutes,
      score: m.score,
      numVotes: m.numVotes,
      description: m.description,
      credits: m.credits,
    };
  } catch (err: any) {
    if (err?.meta?.statusCode === 404) return { found: false };
    throw err;
  }
};

const getPersonFilmography: ToolExecutor = async (args) => {
  const name = asString(args.name);
  if (!name) return { error: 'name is required' };
  const limit = clampLimit(args.limit, 10, 20);

  const result = await esClient.search<Actor>({
    index: PEOPLE_INDEX,
    query: { multi_match: { query: name, fields: ['name^3'], fuzziness: 'AUTO' } },
    size: 1,
  });

  const hit = result.hits.hits[0]?._source;
  if (!hit) return { found: false };

  return {
    found: true,
    id: hit.id,
    name: hit.name,
    birthYear: hit.birthYear,
    filmography: hit.filmography.slice(0, limit),
  };
};

const aggregateTitlesBy: ToolExecutor = async (args) => {
  const metric = asString(args.metric) ?? 'count';
  const yearFrom = asInt(args.yearFrom);
  const yearTo = asInt(args.yearTo);
  const limit = clampLimit(args.limit, 10, 25);

  const query = yearFrom !== undefined || yearTo !== undefined
    ? { range: { year: { gte: yearFrom, lte: yearTo } } }
    : { match_all: {} };

  const result = await esClient.search<Movie>({
    index: TITLES_INDEX,
    query,
    size: 0,
    aggs: {
      by_genre: {
        terms: { field: 'genres', size: 100 },
        aggs: {
          avgScore: { avg: { field: 'score' } },
          avgNumVotes: { avg: { field: 'numVotes' } },
        },
      },
    },
  } as any);

  const buckets = ((result as any).aggregations?.by_genre?.buckets ?? []) as Array<{
    key: string;
    doc_count: number;
    avgScore: { value: number | null };
    avgNumVotes: { value: number | null };
  }>;

  const rows = buckets.map((b) => ({
    genre: b.key,
    count: b.doc_count,
    avgScore: b.avgScore.value ?? undefined,
    avgNumVotes: b.avgNumVotes.value ?? undefined,
  }));

  const sortKey = metric === 'avgScore' ? 'avgScore' : metric === 'avgNumVotes' ? 'avgNumVotes' : 'count';
  rows.sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));

  return rows.slice(0, limit);
};

const findPeopleByGenre: ToolExecutor = async (args) => {
  const genre = asString(args.genre);
  if (!genre) return { error: 'genre is required' };
  const category = asString(args.category);
  const limit = clampLimit(args.limit, 10, 20);

  const result = await esClient.search<Movie>({
    index: TITLES_INDEX,
    query: { term: { genres: genre } },
    size: 0,
    aggs: {
      credits: {
        nested: { path: 'credits' },
        aggs: {
          matching: {
            filter: category ? { term: { 'credits.category': category } } : { match_all: {} },
            aggs: {
              by_person: {
                terms: { field: 'credits.personId', size: limit },
                aggs: {
                  name: { terms: { field: 'credits.name.keyword', size: 1 } },
                  category: { terms: { field: 'credits.category', size: 1 } },
                },
              },
            },
          },
        },
      },
    },
  } as any);

  const buckets = ((result as any).aggregations?.credits?.matching?.by_person?.buckets ?? []) as Array<{
    key: string;
    doc_count: number;
    name: { buckets: { key: string }[] };
    category: { buckets: { key: string }[] };
  }>;

  return buckets.map((b) => ({
    personId: b.key,
    name: b.name.buckets[0]?.key ?? b.key,
    category: b.category.buckets[0]?.key,
    movieCount: b.doc_count,
  }));
};

export const DATA_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_titles',
      description:
        'Search movies by free-text query and/or filter by genre and year range. Returns { total, items }: ' +
        '"total" is the full count of matching movies (use this for "how many X movies are there" questions), ' +
        '"items" is a ranked list of the most well-known matches with basic info. Use this to find candidate ' +
        'movies before looking up full details with get_title_details.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: ['string', 'null'], description: 'Free-text search over title/description (optional).' },
          genre: { type: ['string', 'null'], description: 'Filter to movies with this exact genre, e.g. "Comedy" (optional).' },
          yearFrom: { type: ['integer', 'null'], description: 'Only movies released in this year or later (optional).' },
          yearTo: { type: ['integer', 'null'], description: 'Only movies released in this year or earlier (optional).' },
          limit: { type: ['integer', 'null'], description: 'Max results to return (default 10, max 25).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_title_details',
      description:
        'Get full details for one movie by its id, including its cast/crew credits (actors, directors, ' +
        'writers, producers).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The movie id (IMDb tconst), e.g. from search_titles results.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_person_filmography',
      description:
        'Look up a person by name (actor, actress, director, writer, or producer) and return their ' +
        'filmography — every movie they are credited on in the database, with their role on each.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The person's name to look up." },
          limit: { type: ['integer', 'null'], description: 'Max filmography entries to return (default 25, max 100).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aggregate_titles_by',
      description:
        'Aggregate movies by genre to answer questions like "which genre has the highest average score" or ' +
        '"how many action movies are there". Optionally restrict to a year range first.',
      parameters: {
        type: 'object',
        properties: {
          metric: {
            type: 'string',
            enum: ['count', 'avgScore', 'avgNumVotes'],
            description: 'What to rank genres by.',
          },
          yearFrom: { type: ['integer', 'null'], description: 'Only consider movies released in this year or later (optional).' },
          yearTo: { type: ['integer', 'null'], description: 'Only consider movies released in this year or earlier (optional).' },
          limit: { type: ['integer', 'null'], description: 'Max genres to return, sorted by metric descending (default 10).' },
        },
        required: ['metric'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_people_by_genre',
      description:
        'Find which people appear most often in movies of a given genre, optionally restricted to one role ' +
        '(actor, actress, director, writer, or producer). Use this for "recommend a/an <role> who does ' +
        '<genre> movies" style questions instead of manually cross-referencing many individual movies.',
      parameters: {
        type: 'object',
        properties: {
          genre: { type: 'string', description: 'Genre to filter by, e.g. "Action".' },
          category: {
            type: ['string', 'null'],
            enum: ['actor', 'actress', 'director', 'writer', 'producer', null],
            description: 'Optional: restrict to one credit role.',
          },
          limit: { type: ['integer', 'null'], description: 'Max people to return, sorted by movie count descending (default 10, max 20).' },
        },
        required: ['genre'],
      },
    },
  },
];

const EXECUTORS: Record<string, ToolExecutor> = {
  search_titles: searchTitles,
  get_title_details: getTitleDetails,
  get_person_filmography: getPersonFilmography,
  aggregate_titles_by: aggregateTitlesBy,
  find_people_by_genre: findPeopleByGenre,
};

export async function executeDataTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const executor = EXECUTORS[name];
  if (!executor) return { error: `Unknown tool: ${name}` };
  return executor(args);
}
