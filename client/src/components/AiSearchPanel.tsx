import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatReference, streamChatAnswer } from '../api/chat';

export function AiSearchPanel() {
  const [question, setQuestion] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [status, setStatus] = useState('');
  const [references, setReferences] = useState<ChatReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setAnswerText('');
    setStatus('');
    setReferences([]);

    streamChatAnswer(trimmed, {
      onToken: (text) => {
        setStatus('');
        setAnswerText((prev) => prev + text);
      },
      onStatus: (text) => setStatus(text),
      onFinal: (answer) => {
        setAnswerText(answer.text);
        setStatus('');
        setReferences(answer.references);
        setLoading(false);
      },
      onError: (message) => {
        setError(message);
        setStatus('');
        setLoading(false);
      },
    });
  }

  return (
    <div className="ai-panel">
      <form className="search-bar" onSubmit={handleSubmit}>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the movies, e.g. who was the busiest actor in the last 10 years?"
          aria-label="Ask AI"
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Thinking...' : 'Ask'}
        </button>
      </form>

      {error && <p className="error-text">{error}</p>}

      {(answerText || loading) && !error && (
        <div className="ai-panel-answer">
          {answerText ? (
            <div className="ai-panel-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{answerText}</ReactMarkdown>
            </div>
          ) : (
            <p className="muted">{status || 'Thinking...'}</p>
          )}

          {references.length > 0 && (
            <div className="tag-row">
              {references.map((ref) => (
                <Link
                  key={`${ref.type}-${ref.id}`}
                  to={ref.type === 'movie' ? `/movies/${ref.id}` : `/actors/${ref.id}`}
                  className="ai-reference-chip"
                >
                  {ref.title}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
