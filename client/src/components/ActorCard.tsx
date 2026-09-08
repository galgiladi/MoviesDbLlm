import { Link } from 'react-router-dom';
import { Actor } from '../types/actor';

export function ActorCard({ actor }: { actor: Actor }) {
  return (
    <Link to={`/actors/${actor.id}`} className="actor-card">
      <div className="actor-card-avatar">{actor.name.charAt(0)}</div>
      <div>
        <h3>{actor.name}</h3>
        {actor.birthYear && <p className="muted">b. {actor.birthYear}</p>}
        <p className="muted">
          {actor.movies.length} movie{actor.movies.length === 1 ? '' : 's'} in index
        </p>
      </div>
    </Link>
  );
}
