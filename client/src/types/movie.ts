export interface CastMember {
  actorId: string;
  name: string;
  character?: string;
}

export interface Movie {
  id: string;
  title: string;
  year?: number;
  genres: string[];
  runtimeMinutes?: number;
  score?: number;
  numVotes?: number;
  description: string;
  imdbUrl: string;
  posterUrl?: string;
  cast: CastMember[];
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}
