import { CreditCategory } from './movie';

export interface FilmographyEntry {
  titleId: string;
  title: string;
  category: CreditCategory;
  character?: string;
}

export interface Actor {
  id: string;
  name: string;
  birthYear?: number;
  filmography: FilmographyEntry[];
}
