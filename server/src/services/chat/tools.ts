import Groq from 'groq-sdk';
import { esClient } from '../../es/client';
import { TITLES_INDEX, PEOPLE_INDEX } from '../../es/indices';
import { Movie } from '../../types/movie';
import { Actor } from '../../types/actor';
import { embedText } from '../embeddings';

/**
 * Every tool the model can call is a small, hardcoded ES query — never a passthrough for
 * model-authored query DSL. This is the entire data-access boundary for the chat feature.
 *
 * Deliberately few, broad tools rather than many narrow ones: each extra tool the model has to
 * choose between is a chance for it to pick wrong, double up, or oscillate between two that do
 * almost the same thing (observed directly: search_titles and semantic_search_plots used
 * redundantly, "recommend a role for a genre" needing its own bespoke tool). search_movies below
 * folds lexical + semantic search into one hybrid call instead of leaving that choice to the
 * model; aggregate folds genre-level and person-level aggregation into one shape.
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

/**
 * Hybrid search: combines lexical (BM25, operator:'and') and semantic (kNN on plotEmbedding) in
 * one ES request, so the model doesn't have to choose between "exact keywords" and "matches by
 * meaning" — Elasticsearch's own scoring blends both. Elastic's one-click hybrid retriever (RRF)
 * is Enterprise-only (verified against Elastic's docs before building this); this is the
 * documented free-tier alternative — a plain `query` + `knn` in the same request, combined by
 * score addition, with `boost` used to bring kNN's ~0-1 cosine range into the same ballpark as
 * BM25's typically-larger scores.
 */
const searchMovies: ToolExecutor = async (args) => {
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

  if (!query) {
    const result = await esClient.search<Movie>({
      index: TITLES_INDEX,
      query: filter.length ? { bool: { filter } } : { match_all: {} },
      size: limit,
      sort: [{ numVotes: 'desc' as const }, { score: 'desc' as const }],
    });
    return toSearchResult(result);
  }

  // operator: 'and' matters a lot here: with the default 'or', a multi-word query like
  // "Spider-Man" tokenizes to ["spider", "man"], and "man" alone is common enough to match tons
  // of unrelated movies (Iron Man, ...) — 'and' requires every term to actually appear (still
  // fuzzy-matched, so minor typos are fine) before a document counts as a lexical hit at all.
  const result = await esClient.search<Movie>({
    index: TITLES_INDEX,
    query: {
      bool: {
        must: [{ multi_match: { query, fields: ['title^3', 'description', 'genres'], operator: 'and' as const, fuzziness: 'AUTO' } }],
        filter,
      },
    },
    knn: {
      field: 'plotEmbedding',
      query_vector: await embedText(query),
      k: limit,
      num_candidates: Math.max(limit * 10, 50),
      filter: filter.length ? { bool: { filter } } : undefined,
      boost: 8,
    },
    size: limit,
  } as any);
  return toSearchResult(result);
};

function toSearchResult(result: Awaited<ReturnType<typeof esClient.search<Movie>>>) {
  const total = typeof result.hits.total === 'number' ? result.hits.total : result.hits.total?.value ?? 0;
  return {
    total,
    items: result.hits.hits.map((hit) => {
      const m = hit._source as Movie;
      return { id: m.id, title: m.title, year: m.year, genres: m.genres, score: m.score, numVotes: m.numVotes };
    }),
  };
}

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

/**
 * Unified aggregation: group by genre, or by person+role — one shape instead of two separate
 * tools (aggregate_titles_by / find_people_by_genre) that did almost the same underlying work.
 * Adding a new grouping dimension later (e.g. by decade) extends this one tool rather than adding
 * another bespoke one.
 */
const aggregate: ToolExecutor = async (args) => {
  const dimension = asString(args.dimension);
  const metric = asString(args.metric) ?? 'count';
  const genre = asString(args.genre);
  const personCategory = asString(args.personCategory);
  const yearFrom = asInt(args.yearFrom);
  const yearTo = asInt(args.yearTo);
  const limit = clampLimit(args.limit, 10, 25);

  const filter: Record<string, unknown>[] = [];
  if (yearFrom !== undefined || yearTo !== undefined) {
    filter.push({ range: { year: { gte: yearFrom, lte: yearTo } } });
  }

  if (dimension === 'person') {
    if (genre) filter.push({ term: { genres: genre } });

    const result = await esClient.search<Movie>({
      index: TITLES_INDEX,
      query: filter.length ? { bool: { filter } } : { match_all: {} },
      size: 0,
      aggs: {
        credits: {
          nested: { path: 'credits' },
          aggs: {
            matching: {
              filter: personCategory ? { term: { 'credits.category': personCategory } } : { match_all: {} },
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
  }

  // dimension === 'genre' (default)
  const result = await esClient.search<Movie>({
    index: TITLES_INDEX,
    query: filter.length ? { bool: { filter } } : { match_all: {} },
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
  rows.sort((a, b) => (b[sortKey as 'count' | 'avgScore' | 'avgNumVotes'] ?? 0) - (a[sortKey as 'count' | 'avgScore' | 'avgNumVotes'] ?? 0));

  return rows.slice(0, limit);
};

export const DATA_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_movies',
      description:
        'Search movies — combines exact keyword matching (title/genre/year) AND matching by meaning/theme/' +
        'premise in one call, so it works whether the question names a title or describes a plot (e.g. ' +
        '"Batman" or "a widower finding love again"). Returns { total, items }: "total" is the full count of ' +
        'matching movies (use for "how many X movies are there" questions), "items" is a ranked list of the ' +
        'most well-known/relevant matches. Use this to find candidate movies before get_title_details.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: ['string', 'null'], description: 'Free-text search — a title, or a plot/theme description (optional).' },
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
          id: { type: 'string', description: 'The movie id (IMDb tconst), e.g. from search_movies results.' },
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
      name: 'aggregate',
      description:
        'Aggregate movies by genre, or by person+role, to answer stats/ranking questions: "which genre has ' +
        'the highest average score", "how many action movies are there", "recommend an actress who does ' +
        'action movies", "top directors of the 2010s". Optionally restrict to a year range and/or genre first.',
      parameters: {
        type: 'object',
        properties: {
          dimension: {
            type: 'string',
            enum: ['genre', 'person'],
            description: '"genre" ranks genres against each other; "person" ranks people (optionally by role).',
          },
          metric: {
            type: ['string', 'null'],
            enum: ['count', 'avgScore', 'avgNumVotes', null],
            description: 'For dimension "genre": what to rank genres by (default "count").',
          },
          personCategory: {
            type: ['string', 'null'],
            enum: ['actor', 'actress', 'director', 'writer', 'producer', null],
            description: 'For dimension "person": optionally restrict to one credit role.',
          },
          genre: { type: ['string', 'null'], description: 'For dimension "person": optionally restrict to one genre (optional).' },
          yearFrom: { type: ['integer', 'null'], description: 'Only consider movies released in this year or later (optional).' },
          yearTo: { type: ['integer', 'null'], description: 'Only consider movies released in this year or earlier (optional).' },
          limit: { type: ['integer', 'null'], description: 'Max rows to return, sorted descending (default 10, max 25).' },
        },
        required: ['dimension'],
      },
    },
  },
];

const EXECUTORS: Record<string, ToolExecutor> = {
  search_movies: searchMovies,
  get_title_details: getTitleDetails,
  get_person_filmography: getPersonFilmography,
  aggregate,
};

export async function executeDataTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const executor = EXECUTORS[name];
  if (!executor) return { error: `Unknown tool: ${name}` };
  return executor(args);
}
