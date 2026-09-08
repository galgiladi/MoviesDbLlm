import Groq from 'groq-sdk';
import { env } from '../config/env';
import { DATA_TOOL_DEFINITIONS, executeDataTool } from './chat/tools';

const groq = new Groq({ apiKey: env.groqApiKey });

const ANSWER_TOOL_NAME = 'answer';
const MAX_TOOL_ITERATIONS = 6;

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

const ANSWER_TOOL: Groq.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: ANSWER_TOOL_NAME,
    description:
      'Report every movie or person your just-written answer cited, so the UI can render clickable ' +
      'reference links. Call this exactly once, after your answer text, using each item\'s exact "id" and ' +
      '"title"/"name" as returned by the data tools.',
    parameters: {
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
};

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    'You are a movie-database assistant with tools that query a real database of up to 100,000 movies',
    '(from IMDb data) and the actors/actresses/directors/writers/producers credited on them.',
    '',
    'Always use the search_titles, get_title_details, get_person_filmography, and aggregate_titles_by tools',
    'to look up real data before answering — never state a specific movie, person, or fact that a tool result',
    "didn't actually give you, and never rely on outside knowledge about real movies/actors.",
    '',
    `Today's date is ${today}. Resolve relative time ranges (e.g. "the last 10 years") against it.`,
    '',
    'Call tools as many times as needed (they can be combined — e.g. search_titles then get_title_details on',
    'the results) to gather enough information, then write your final answer as plain text with no further',
    'tool calls. If the data genuinely does not support an answer, say so plainly instead of guessing.',
  ].join('\n');
}

type Message = Groq.Chat.Completions.ChatCompletionMessageParam;

interface AccumulatedToolCall {
  id?: string;
  name?: string;
  args: string;
}

/** Streams one chat-completion turn, forwarding text deltas live and accumulating tool calls. */
async function streamTurn(
  messages: Message[],
  tools: Groq.Chat.Completions.ChatCompletionTool[],
  toolChoice: Groq.Chat.Completions.ChatCompletionToolChoiceOption,
  onToken: (text: string) => void,
): Promise<{ content: string; toolCalls: { id: string; name: string; args: string }[] }> {
  const stream = await groq.chat.completions.create({
    model: env.groqModel,
    messages,
    tools,
    tool_choice: toolChoice,
    stream: true,
  });

  let content = '';
  const acc: Record<number, AccumulatedToolCall> = {};

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      onToken(delta.content);
    }

    for (const tc of delta.tool_calls ?? []) {
      const entry = acc[tc.index] ?? (acc[tc.index] = { args: '' });
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
    }
  }

  const toolCalls = Object.values(acc).filter(
    (tc): tc is { id: string; name: string; args: string } => Boolean(tc.id && tc.name),
  );

  return { content, toolCalls };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function streamChatAnswer(question: string, handlers: StreamChatAnswerHandlers): Promise<void> {
  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: question },
  ];

  let finalText = '';

  // Phase 1: let the model call data tools as needed, streaming any text it writes along the
  // way (including interim commentary), until it responds with plain text and no tool calls.
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const { content, toolCalls } = await streamTurn(messages, DATA_TOOL_DEFINITIONS, 'auto', handlers.onToken);
    finalText += content;

    if (toolCalls.length === 0) break;

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    for (const tc of toolCalls) {
      const result = await executeDataTool(tc.name, safeParseArgs(tc.args));
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  finalText = finalText.trim();
  if (!finalText) {
    handlers.onFinal({ text: "I wasn't able to find enough information to answer that.", references: [] });
    return;
  }

  // Phase 2: force a structured `answer` tool call (no further data tools offered) purely to
  // extract citations for the UI — the visible answer text itself was already streamed above.
  messages.push({ role: 'assistant', content: finalText });
  messages.push({ role: 'user', content: 'Now call the answer tool listing every movie/person you cited.' });

  let references: ChatReference[] = [];
  try {
    const response = await groq.chat.completions.create({
      model: env.groqModel,
      messages,
      tools: [ANSWER_TOOL],
      tool_choice: { type: 'function', function: { name: ANSWER_TOOL_NAME } },
      stream: false,
    });

    const toolCall = response.choices[0]?.message.tool_calls?.[0];
    if (toolCall) {
      const parsed = safeParseArgs(toolCall.function.arguments) as { references?: ChatReference[] };
      references = Array.isArray(parsed.references) ? parsed.references : [];
    }
  } catch {
    // References are a nice-to-have for the UI; don't fail the whole answer if this call errors.
    references = [];
  }

  handlers.onFinal({ text: finalText, references });
}
