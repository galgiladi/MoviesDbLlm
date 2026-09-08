export interface ActorMovie {
  movieId: string;
  title: string;
  character?: string;
}

export interface Actor {
  id: string;
  name: string;
  birthYear?: number;
  movies: ActorMovie[];
}
