import { useState } from 'react';
import { updateMovieScore } from '../api/movies';
import { ApiError } from '../api/client';

interface ScoreEditorProps {
  movieId: string;
  score?: number;
  onUpdated: (newScore: number) => void;
}

export function ScoreEditor({ movieId, score, onUpdated }: ScoreEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(score !== undefined ? String(score) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
      setError('Score must be a number between 0 and 10');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMovieScore(movieId, parsed);
      onUpdated(updated.score ?? parsed);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update score');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="score-editor">
        <span className="score-display">★ {score !== undefined ? score.toFixed(1) : '—'}</span>
        <button className="link-button" onClick={() => setEditing(true)}>
          Edit score
        </button>
      </div>
    );
  }

  return (
    <div className="score-editor">
      <input
        type="number"
        min={0}
        max={10}
        step={0.1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <button onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
      <button
        className="link-button"
        onClick={() => {
          setEditing(false);
          setError(null);
          setValue(score !== undefined ? String(score) : '');
        }}
      >
        Cancel
      </button>
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
