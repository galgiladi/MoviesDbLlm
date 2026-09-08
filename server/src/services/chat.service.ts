import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { getMoviesContextBlock } from './moviesContext.service';

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

const ANSWER_TOOL_NAME = 'answer';

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
}

function buildSystemInstructions(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    'You are a movie-database assistant. Answer the user\'s question using ONLY the movie data provided below',
    'as your source of truth - never rely on outside knowledge about real movies or actors. Every specific',
    'movie or actor you mention by name must come from that data.',
    '',
    `Today's date is ${today}. Resolve relative time ranges (e.g. "the last 10 years") against it.`,
    '',
    `After writing your complete answer as plain text, call the "${ANSWER_TOOL_NAME}" tool exactly once,`,
    'listing every movie or actor your answer cited, using their exact "id" and "title"/"name" from the data.',
    `If the data does not support an answer, say so in your text and call "${ANSWER_TOOL_NAME}" with an empty`,
    'references list.',
  ].join('\n');
}

export async function streamChatAnswer(question: string, handlers: StreamChatAnswerHandlers): Promise<void> {
  const contextBlock = await getMoviesContextBlock();

  const stream = anthropic.messages.stream({
    model: env.anthropicModel,
    max_tokens: 1536,
    system: [
      { type: 'text', text: buildSystemInstructions() },
      {
        type: 'text',
        text: `Movie data (JSON array, each item has id, title, year, genres, description, score, numVotes, cast):\n${contextBlock}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: ANSWER_TOOL_NAME,
        description: 'Report the movies/actors cited in your answer, so the UI can render clickable references.',
        input_schema: {
          type: 'object',
          properties: {
            references: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['movie', 'actor'] },
                  id: { type: 'string' },
                  title: { type: 'string' },
                },
                required: ['type', 'id', 'title'],
              },
            },
          },
          required: ['references'],
        },
      },
    ],
    messages: [{ role: 'user', content: question }],
  });

  let accumulatedText = '';
  stream.on('text', (delta) => {
    accumulatedText += delta;
    handlers.onToken(delta);
  });

  const finalMessage = await stream.finalMessage();
  const toolUse = finalMessage.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === ANSWER_TOOL_NAME,
  );
  const references = (toolUse?.input as { references?: ChatReference[] } | undefined)?.references ?? [];

  handlers.onFinal({ text: accumulatedText.trim(), references });
}
