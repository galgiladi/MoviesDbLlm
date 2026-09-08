import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { searchActors } from '../api/actors';
import { searchMovies } from '../api/movies';
import { Actor } from '../types/actor';
import { Movie, SearchResult } from '../types/movie';
import { SearchBar } from '../components/SearchBar';
import { ActorCard } from '../components/ActorCard';
import { Pagination } from '../components/Pagination';

const PAGE_SIZE = 20;

export function ActorsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const movieId = searchParams.get('movieId') ?? '';
  const movieTitle = searchParams.get('movieTitle') ?? '';
  const page = Number(searchParams.get('page') ?? '1');

  const [result, setResult] = useState<SearchResult<Actor> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [movieQuery, setMovieQuery] = useState('');
  const [movieOptions, setMovieOptions] = useState<Movie[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    searchActors({ q: movieId ? undefined : q, movieId: movieId || undefined, page, size: PAGE_SIZE })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load actors. Is the server running?');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [q, movieId, page]);

  useEffect(() => {
    if (!movieQuery.trim()) {
      setMovieOptions([]);
      return;
    }
    let cancelled = false;
    const timeout = setTimeout(() => {
      searchMovies(movieQuery.trim(), 1, 6)
        .then((data) => {
          if (!cancelled) setMovieOptions(data.items);
        })
        .catch(() => {
          /* ignore typeahead errors */
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [movieQuery]);

  function selectMovie(movie: Movie) {
    setMovieQuery('');
    setMovieOptions([]);
    setSearchParams({ movieId: movie.id, movieTitle: movie.title });
  }

  function clearMovieFilter() {
    setSearchParams(q ? { q } : {});
  }

  return (
    <div className="page">
      <h1>Actors</h1>

      {movieId ? (
        <div className="active-filter">
          Showing cast of <strong>{movieTitle}</strong>
          <button className="link-button" onClick={clearMovieFilter}>
            Clear filter
          </button>
        </div>
      ) : (
        <SearchBar initialValue={q} placeholder="Search actors by name..." onSearch={(value) => setSearchParams(value ? { q: value } : {})} />
      )}

      {!movieId && (
        <div className="movie-filter">
          <label htmlFor="movieFilter">...or filter by movie</label>
          <input
            id="movieFilter"
            type="text"
            placeholder="Start typing a movie title..."
            value={movieQuery}
            onChange={(e) => setMovieQuery(e.target.value)}
          />
          {movieOptions.length > 0 && (
            <ul className="movie-typeahead">
              {movieOptions.map((m) => (
                <li key={m.id}>
                  <button onClick={() => selectMovie(m)}>
                    {m.title} {m.year && <span className="muted">({m.year})</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading && <p className="muted">Loading...</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && result && (
        <>
          {result.items.length === 0 ? (
            <p className="muted">No actors found.</p>
          ) : (
            <div className="card-grid">
              {result.items.map((actor) => (
                <ActorCard key={actor.id} actor={actor} />
              ))}
            </div>
          )}
          <Pagination
            page={result.page}
            size={result.size}
            total={result.total}
            onPageChange={(newPage) => {
              const params: Record<string, string> = { page: String(newPage) };
              if (q) params.q = q;
              if (movieId) {
                params.movieId = movieId;
                params.movieTitle = movieTitle;
              }
              setSearchParams(params);
            }}
          />
        </>
      )}
    </div>
  );
}
