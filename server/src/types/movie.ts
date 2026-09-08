export type CreditCategory = 'actor' | 'actress' | 'director' | 'writer' | 'producer';

export interface Credit {
  personId: string;
  name: string;
  category: CreditCategory;
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
  credits: Credit[];
  createdAt: string;
  updatedAt: string;
}

export type MovieInput = Omit<Movie, 'createdAt' | 'updatedAt'>;
