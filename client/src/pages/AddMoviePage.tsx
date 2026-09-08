import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addMovieByImdbUrl } from '../api/movies';
import { ApiError } from '../api/client';

export function AddMoviePage() {
  const [imdbUrl, setImdbUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const movie = await addMovieByImdbUrl(imdbUrl.trim());
      navigate(`/movies/${movie.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add movie');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page narrow">
      <h1>Add a Movie</h1>
      <p className="muted">Paste a link to the movie's IMDb page and we'll fetch its details automatically.</p>

      <form className="add-movie-form" onSubmit={handleSubmit}>
        <label htmlFor="imdbUrl">IMDb URL</label>
        <input
          id="imdbUrl"
          type="url"
          required
          placeholder="https://www.imdb.com/title/tt0111161/"
          value={imdbUrl}
          onChange={(e) => setImdbUrl(e.target.value)}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Fetching...' : 'Add Movie'}
        </button>
        {error && <p className="error-text">{error}</p>}
      </form>
    </div>
  );
}
