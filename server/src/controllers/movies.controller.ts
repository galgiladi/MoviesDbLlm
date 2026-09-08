import { Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { createMovie, getMovieById, patchMovie, searchMovies } from '../services/movies.service';
import { scrapeImdbMovie } from '../services/imdbScrape.service';
import { upsertActorForMovie } from '../services/actors.service';
import { CastMember } from '../types/movie';

function parsePaging(req: Request) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  return { page, size };
}

export const listMovies = asyncHandler(async (req: Request, res: Response) => {
  const { page, size } = parsePaging(req);
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const result = await searchMovies({ q, page, size });
  res.json(result);
});

export const getMovie = asyncHandler(async (req: Request, res: Response) => {
  const movie = await getMovieById(req.params.id);
  if (!movie) throw new HttpError(404, 'Movie not found');
  res.json(movie);
});

export const addMovieFromImdbUrl = asyncHandler(async (req: Request, res: Response) => {
  const { imdbUrl } = req.body ?? {};
  if (!imdbUrl || typeof imdbUrl !== 'string') {
    throw new HttpError(400, 'imdbUrl is required');
  }

  const scraped = await scrapeImdbMovie(imdbUrl);

  const existing = await getMovieById(scraped.id);
  if (existing) {
    throw new HttpError(409, `Movie already indexed: ${existing.title}`);
  }

  const cast: CastMember[] = [];
  for (const actor of scraped.actors) {
    const linked = await upsertActorForMovie(actor.name, { movieId: scraped.id, title: scraped.title });
    cast.push({ actorId: linked.id, name: linked.name });
  }

  const movie = await createMovie({
    id: scraped.id,
    title: scraped.title,
    year: scraped.year,
    genres: scraped.genres,
    runtimeMinutes: scraped.runtimeMinutes,
    score: scraped.score,
    numVotes: scraped.numVotes,
    description: scraped.description,
    imdbUrl: scraped.imdbUrl,
    posterUrl: scraped.posterUrl,
    cast,
  });

  res.status(201).json(movie);
});

export const updateMovie = asyncHandler(async (req: Request, res: Response) => {
  const { score, description, title } = req.body ?? {};
  const partial: Record<string, unknown> = {};

  if (score !== undefined) {
    const parsed = Number(score);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
      throw new HttpError(400, 'score must be a number between 0 and 10');
    }
    partial.score = parsed;
  }
  if (description !== undefined) partial.description = String(description);
  if (title !== undefined) partial.title = String(title);

  if (Object.keys(partial).length === 0) {
    throw new HttpError(400, 'No editable fields provided (score, description, title)');
  }

  const updated = await patchMovie(req.params.id, partial);
  if (!updated) throw new HttpError(404, 'Movie not found');
  res.json(updated);
});
