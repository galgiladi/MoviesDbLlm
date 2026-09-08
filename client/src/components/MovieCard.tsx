import { Link } from 'react-router-dom';
import { Movie } from '../types/movie';

function hueFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = value.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

export function MovieCard({ movie }: { movie: Movie }) {
  const hue = hueFromString(movie.id);

  return (
    <Link to={`/movies/${movie.id}`} className="movie-card">
      <div
        className="movie-card-poster"
        style={
          movie.posterUrl
            ? { backgroundImage: `url(${movie.posterUrl})` }
            : { background: `linear-gradient(135deg, hsl(${hue}, 60%, 45%), hsl(${(hue + 60) % 360}, 60%, 30%))` }
        }
      >
        {!movie.posterUrl && <span className="movie-card-initial">{movie.title.charAt(0)}</span>}
        {typeof movie.score === 'number' && <span className="score-badge">★ {movie.score.toFixed(1)}</span>}
      </div>
      <div className="movie-card-body">
        <h3>{movie.title}</h3>
        <p className="muted">{movie.year ?? '—'}</p>
        <div className="tag-row">
          {movie.genres.slice(0, 3).map((g) => (
            <span key={g} className="tag">
              {g}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}
