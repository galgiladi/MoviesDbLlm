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

export type MovieInput = Omit<Movie, 'createdAt' | 'updatedAt'>;
