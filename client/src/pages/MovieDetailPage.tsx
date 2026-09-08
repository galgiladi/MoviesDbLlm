import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getMovie } from '../api/movies';
import { Movie } from '../types/movie';
import { ScoreEditor } from '../components/ScoreEditor';

export function MovieDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [movie, setMovie] = useState<Movie | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getMovie(id)
      .then(setMovie)
      .catch(() => setError('Movie not found.'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="page">Loading...</div>;
  if (error || !movie) return <div className="page error-text">{error ?? 'Movie not found.'}</div>;

  const cast = movie.credits.filter((c) => c.category === 'actor' || c.category === 'actress');

  return (
    <div className="page">
      <Link to="/" className="back-link">
        ← Back to movies
      </Link>

      <div className="movie-detail">
        <div
          className="movie-detail-poster"
          style={movie.posterUrl ? { backgroundImage: `url(${movie.posterUrl})` } : undefined}
        >
          {!movie.posterUrl && <span>{movie.title.charAt(0)}</span>}
        </div>

        <div className="movie-detail-body">
          <h1>
            {movie.title} {movie.year && <span className="muted">({movie.year})</span>}
          </h1>

          <div className="tag-row">
            {movie.genres.map((g) => (
              <span key={g} className="tag">
                {g}
              </span>
            ))}
          </div>

          <ScoreEditor
            movieId={movie.id}
            score={movie.score}
            onUpdated={(newScore) => setMovie({ ...movie, score: newScore })}
          />

          {movie.numVotes !== undefined && <p className="muted">{movie.numVotes.toLocaleString()} votes</p>}
          {movie.runtimeMinutes && <p className="muted">{movie.runtimeMinutes} min</p>}

          <p className="description">{movie.description}</p>

          <a href={movie.imdbUrl} target="_blank" rel="noreferrer" className="imdb-link">
            View on IMDb ↗
          </a>

          {cast.length > 0 && (
            <>
              <h2>Cast</h2>
              <div className="cast-list">
                {cast.map((c) => (
                  <Link key={c.personId} to={`/actors/${c.personId}`} className="cast-chip">
                    {c.name}
                    {c.character && <span className="muted"> as {c.character}</span>}
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
