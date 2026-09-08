import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getActor } from '../api/actors';
import { Actor } from '../types/actor';

export function ActorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [actor, setActor] = useState<Actor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getActor(id)
      .then(setActor)
      .catch(() => setError('Actor not found.'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="page">Loading...</div>;
  if (error || !actor) return <div className="page error-text">{error ?? 'Actor not found.'}</div>;

  return (
    <div className="page narrow">
      <Link to="/actors" className="back-link">
        ← Back to actors
      </Link>

      <div className="actor-detail-header">
        <div className="actor-card-avatar large">{actor.name.charAt(0)}</div>
        <div>
          <h1>{actor.name}</h1>
          {actor.birthYear && <p className="muted">Born {actor.birthYear}</p>}
        </div>
      </div>

      <h2>Movies in this index</h2>
      {actor.movies.length === 0 ? (
        <p className="muted">No movies linked yet.</p>
      ) : (
        <ul className="actor-movie-list">
          {actor.movies.map((m) => (
            <li key={m.movieId}>
              <Link to={`/movies/${m.movieId}`}>{m.title}</Link>
              {m.character && <span className="muted"> as {m.character}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
