import { api } from './client';
import { Movie, SearchResult } from '../types/movie';

export function searchMovies(q: string, page = 1, size = 20) {
  const params = new URLSearchParams({ page: String(page), size: String(size) });
  if (q) params.set('q', q);
  return api.get<SearchResult<Movie>>(`/api/movies?${params.toString()}`);
}

export function getMovie(id: string) {
  return api.get<Movie>(`/api/movies/${id}`);
}

export function addMovieByImdbUrl(imdbUrl: string) {
  return api.post<Movie>('/api/movies', { imdbUrl });
}

export function updateMovieScore(id: string, score: number) {
  return api.patch<Movie>(`/api/movies/${id}`, { score });
}
