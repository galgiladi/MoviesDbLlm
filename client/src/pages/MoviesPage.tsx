import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { searchMovies } from '../api/movies';
import { Movie, SearchResult } from '../types/movie';
import { SearchBar } from '../components/SearchBar';
import { MovieCard } from '../components/MovieCard';
import { Pagination } from '../components/Pagination';
import { AiSearchPanel } from '../components/AiSearchPanel';

const PAGE_SIZE = 20;

export function MoviesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const page = Number(searchParams.get('page') ?? '1');

  const [result, setResult] = useState<SearchResult<Movie> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAi, setShowAi] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    searchMovies(q, page, PAGE_SIZE)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load movies. Is the server running?');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [q, page]);

  return (
    <div className="page">
      <h1>Movies</h1>
      <SearchBar
        initialValue={q}
        placeholder="Search movies by title, genre, description..."
        onSearch={(value) => setSearchParams(value ? { q: value } : {})}
      />

      <button type="button" className="link-button ask-ai-toggle" onClick={() => setShowAi((v) => !v)}>
        {showAi ? 'Hide Ask AI' : 'Ask AI'}
      </button>
      {showAi && <AiSearchPanel />}

      {loading && <p className="muted">Loading...</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && result && (
        <>
          {result.items.length === 0 ? (
            <p className="muted">No movies found.</p>
          ) : (
            <div className="card-grid">
              {result.items.map((movie) => (
                <MovieCard key={movie.id} movie={movie} />
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
              setSearchParams(params);
            }}
          />
        </>
      )}
    </div>
  );
}
