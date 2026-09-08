import { api } from './client';
import { Actor } from '../types/actor';
import { SearchResult } from '../types/movie';

export function searchActors(params: { q?: string; movieId?: string; page?: number; size?: number }) {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    size: String(params.size ?? 20),
  });
  if (params.q) query.set('q', params.q);
  if (params.movieId) query.set('movieId', params.movieId);
  return api.get<SearchResult<Actor>>(`/api/actors?${query.toString()}`);
}

export function getActor(id: string) {
  return api.get<Actor>(`/api/actors/${id}`);
}
