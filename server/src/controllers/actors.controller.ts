import { Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { getActorById, searchActors } from '../services/actors.service';

function parsePaging(req: Request) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  return { page, size };
}

export const listActors = asyncHandler(async (req: Request, res: Response) => {
  const { page, size } = parsePaging(req);
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const movieId = typeof req.query.movieId === 'string' ? req.query.movieId : undefined;
  const result = await searchActors({ q, movieId, page, size });
  res.json(result);
});

export const getActor = asyncHandler(async (req: Request, res: Response) => {
  const actor = await getActorById(req.params.id);
  if (!actor) throw new HttpError(404, 'Actor not found');
  res.json(actor);
});
