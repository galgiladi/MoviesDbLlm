export interface ChatReference {
  type: 'movie' | 'actor';
  id: string;
  title: string;
}

export interface ChatFinalAnswer {
  text: string;
  references: ChatReference[];
}

interface StreamChatAnswerHandlers {
  onToken: (text: string) => void;
  onFinal: (answer: ChatFinalAnswer) => void;
  onError: (message: string) => void;
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export async function streamChatAnswer(
  question: string,
  { onToken, onFinal, onError }: StreamChatAnswerHandlers,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
  } catch {
    onError('Failed to reach the server.');
    return;
  }

  if (!response.ok || !response.body) {
    onError('Failed to get an answer.');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      parseFrame(frame, { onToken, onFinal, onError });
    }
  }
}

function parseFrame(frame: string, { onToken, onFinal, onError }: StreamChatAnswerHandlers) {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    else if (line.startsWith('data: ')) data = line.slice('data: '.length);
  }
  if (!data) return;

  const parsed = JSON.parse(data);
  if (event === 'token') onToken(parsed.text);
  else if (event === 'final') onFinal(parsed);
  else if (event === 'error') onError(parsed.message);
}
