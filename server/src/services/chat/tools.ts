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
  const limit = clampLimit(args.limit, 10, 25);

  const filter: Record<string, unknown>[] = [];
  if (genre) filter.push({ term: { genres: genre } });
  if (yearFrom !== undefined || yearTo !== undefined) {
    filter.push({ range: { year: { gte: yearFrom, lte: yearTo } } });
  }

  const must = query
    ? [{ multi_match: { query, fields: ['title^3', 'description', 'genres'], fuzziness: 'AUTO' } }]
    : [{ match_all: {} }];

  const result = await esClient.search<Movie>({
    index: TITLES_INDEX,
    query: { bool: { must, filter } },
    size: limit,
    sort: [{ numVotes: 'desc' as const }, { score: 'desc' as const }],
  });

  return result.hits.hits.map((hit) => {
    const m = hit._source as Movie;
    return { id: m.id, title: m.title, year: m.year, genres: m.genres, score: m.score, numVotes: m.numVotes };
  });
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
  const limit = clampLimit(args.limit, 25, 100);

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

export const DATA_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_titles',
      description:
        'Search movies by free-text query and/or filter by genre and year range. Returns a ranked list of ' +
        'matching movies (most well-known first) with basic info. Use this to find candidate movies before ' +
        'looking up full details with get_title_details.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search over title/description (optional).' },
          genre: { type: 'string', description: 'Filter to movies with this exact genre, e.g. "Comedy" (optional).' },
          yearFrom: { type: 'integer', description: 'Only movies released in this year or later (optional).' },
          yearTo: { type: 'integer', description: 'Only movies released in this year or earlier (optional).' },
          limit: { type: 'integer', description: 'Max results to return (default 10, max 25).' },
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
          limit: { type: 'integer', description: 'Max filmography entries to return (default 25, max 100).' },
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
          yearFrom: { type: 'integer', description: 'Only consider movies released in this year or later (optional).' },
          yearTo: { type: 'integer', description: 'Only consider movies released in this year or earlier (optional).' },
          limit: { type: 'integer', description: 'Max genres to return, sorted by metric descending (default 10).' },
        },
        required: ['metric'],
      },
    },
  },
];

const EXECUTORS: Record<string, ToolExecutor> = {
  search_titles: searchTitles,
  get_title_details: getTitleDetails,
  get_person_filmography: getPersonFilmography,
  aggregate_titles_by: aggregateTitlesBy,
};

export async function executeDataTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const executor = EXECUTORS[name];
  if (!executor) return { error: `Unknown tool: ${name}` };
  return executor(args);
}
