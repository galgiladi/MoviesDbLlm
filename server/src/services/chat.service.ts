import Groq from 'groq-sdk';
import { env } from '../config/env';
import { DATA_TOOL_DEFINITIONS, executeDataTool } from './chat/tools';

// Retries and the actual timeout deadline are handled ourselves (see PER_CALL_TIMEOUT_MS and
// withRetry below) via a per-call AbortSignal, which also covers a stream that goes silent
// mid-flight — the SDK's own retry/timeout wouldn't cover that, so disable them here to avoid
// two different retry/timeout mechanisms fighting each other.
const groq = new Groq({ apiKey: env.groqApiKey, maxRetries: 0 });

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
  onStatus: (text: string) => void;
  onFinal: (answer: ChatFinalAnswer) => void;
}

/** Short, user-facing progress lines shown while a tool call is in flight — never mention the
 * tool name, "the database", or any other implementation detail; just say what's happening in
 * plain language, the way a person helping you look something up would narrate it. */
function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'search_titles': {
      const query = typeof args.query === 'string' && args.query ? `"${args.query}"` : undefined;
      const genre = typeof args.genre === 'string' && args.genre ? args.genre : undefined;
      if (query) return `Searching for ${query}…`;
      if (genre) return `Looking through ${genre} movies…`;
      return 'Searching movies…';
    }
    case 'get_title_details':
      return 'Looking up more details…';
    case 'get_person_filmography': {
      const name = typeof args.name === 'string' && args.name ? args.name : 'them';
      return `Looking up ${name}'s filmography…`;
    }
    case 'aggregate_titles_by':
      return 'Crunching the numbers…';
    case 'find_people_by_genre': {
      const genre = typeof args.genre === 'string' && args.genre ? args.genre : 'that genre';
      return `Finding notable names in ${genre}…`;
    }
    default:
      return 'Looking that up…';
  }
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
    'You are a friendly, knowledgeable movie assistant on a movie site. You have tools that look up real data',
    '(titles, ratings, genres, cast/crew, and aggregate stats) from the site\'s catalog of up to 100,000 movies.',
    '',
    'Always call the tools to look up real data before answering, and never state a specific movie, person,',
    "rating, or count that a tool result didn't actually give you, and never rely on outside knowledge about",
    'real movies/actors instead of the tool results. Combine tools as needed — e.g. search_titles then',
    'get_title_details on a result, or find_people_by_genre to recommend someone known for a given genre.',
    '',
    `Today's date is ${today}. Resolve relative time ranges (e.g. "the last 10 years") against it.`,
    '',
    'Write your final answer like a knowledgeable friend recommending or discussing films — never mention the',
    'tools, "the database", "search results", or any other implementation detail. Format it in Markdown',
    '(use **bold**, tables, and bullet lists where they make rankings or lists of movies easier to scan). Keep',
    "it conversational and to the point: no disclaimers about where the data came from, no meta-commentary",
    'about how you found it. If the data genuinely does not support an answer, say so plainly instead of',
    'guessing.',
  ].join('\n');
}

type Message = Groq.Chat.Completions.ChatCompletionMessageParam;

interface AccumulatedToolCall {
  id?: string;
  name?: string;
  args: string;
}

const PER_CALL_TIMEOUT_MS = 30_000;

function isRetryable(err: unknown): boolean {
  return (
    err instanceof Groq.APIUserAbortError ||
    err instanceof Groq.APIConnectionError ||
    err instanceof Groq.RateLimitError ||
    err instanceof Groq.InternalServerError
  );
}

/** Groq's free tier has a small tokens-per-minute budget (observed: 8000 TPM), easily exhausted
 * by a single multi-tool-call question. The 429 body includes "Please try again in N.NNs" —
 * retrying immediately just re-hits the same still-exhausted window, so parse that hint (falling
 * back to a fixed delay if the message shape ever changes) and actually wait for it. Capped hard:
 * the *daily* token limit uses the same message shape but can suggest waits of several minutes,
 * which is never acceptable in a synchronous chat request — past the cap we just give up instead
 * of blocking the response for that long (see the overall deadline in streamChatAnswer). */
const MAX_RATE_LIMIT_WAIT_MS = 8_000;

function rateLimitWaitMs(err: InstanceType<typeof Groq.RateLimitError>): number {
  const match = /try again in ([\d.]+)s/i.exec(err.message);
  const seconds = match ? Number(match[1]) : 6;
  const ms = Math.ceil((Number.isFinite(seconds) ? seconds : 6) * 1000) + 250;
  return Math.min(ms, MAX_RATE_LIMIT_WAIT_MS);
}

/** Retries on a timeout/abort or a transient (rate-limit/connection/5xx) error — rate limits get
 * up to 3 attempts total (waiting out the API's suggested delay each time, which is typically
 * sub-second to a few seconds, since a single multi-tool-call question can bump into the free
 * tier's small tokens-per-minute budget more than once on its own); everything else gets one
 * retry. A genuine bad-request/schema error is rethrown immediately rather than wasting an
 * attempt on a call that will just fail the same way again. `deadlineAt` bounds the *total* time
 * spent here (including waits) so this can never itself blow past the overall response deadline —
 * once it's passed, whatever error we have is rethrown immediately instead of waiting/retrying. */
async function withRetry<T>(fn: () => Promise<T>, deadlineAt: number): Promise<T> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      if (attempt === maxAttempts - 1) break;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) break;
      // Only rate limits carry a meaningful "try again in Xs" hint worth waiting out; other
      // transient errors (timeout/connection/5xx) aren't on a fixed cooldown, so retry right away.
      if (err instanceof Groq.RateLimitError) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(rateLimitWaitMs(err), remaining)));
      }
    }
  }
  throw lastErr;
}

/** Streams one chat-completion turn, forwarding text deltas live and accumulating tool calls. */
async function streamTurn(
  messages: Message[],
  tools: Groq.Chat.Completions.ChatCompletionTool[],
  toolChoice: Groq.Chat.Completions.ChatCompletionToolChoiceOption,
  onToken: (text: string) => void,
  deadlineAt: number,
): Promise<{ content: string; toolCalls: { id: string; name: string; args: string }[] }> {
  // The client's own `timeout` option appears to only guard until the response starts, not a
  // stream that goes silent mid-flight (observed: a stalled stream produced zero chunks for 60s+
  // with no error) — so enforce a hard deadline covering the whole call via AbortSignal instead.
  // Shrinks as the overall deadline approaches, so a single call can't eat the whole budget.
  const callTimeoutMs = Math.max(1_000, Math.min(PER_CALL_TIMEOUT_MS, deadlineAt - Date.now()));
  const stream = await groq.chat.completions.create(
    {
      model: env.groqModel,
      messages,
      tools,
      tool_choice: toolChoice,
      stream: true,
    },
    { signal: AbortSignal.timeout(callTimeoutMs) },
  );

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

// Hard ceiling on phase 1's total wall-clock time, independent of how many iterations/retries
// that involves — so a question that keeps hitting rate limits, or one where the model just
// can't find the right tool combination, still resolves in a reasonable time instead of the sum
// of several 30s-timeout-plus-retries iterations stretching out to minutes.
const OVERALL_DEADLINE_MS = 45_000;

const FALLBACK_NO_INFO = "I wasn't able to find enough information to answer that.";
const FALLBACK_ERROR = "Sorry, I ran into a problem finding an answer to that — please try asking again in a moment.";

export async function streamChatAnswer(question: string, handlers: StreamChatAnswerHandlers): Promise<void> {
  try {
    await runChatLoop(question, handlers);
  } catch (err) {
    // Whatever went wrong (exhausted retries, an unexpected Groq error, ...), the user should
    // still get a calm, in-character answer rather than a raw technical failure — a graceful
    // "couldn't find it" beats a red error box every time.
    // eslint-disable-next-line no-console
    console.error('Ask AI failed:', err);
    handlers.onFinal({ text: FALLBACK_ERROR, references: [] });
  }
}

async function runChatLoop(question: string, handlers: StreamChatAnswerHandlers): Promise<void> {
  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: question },
  ];

  let finalText = '';
  const startedAt = Date.now();
  const deadlineAt = startedAt + OVERALL_DEADLINE_MS;

  // Phase 1: let the model call data tools as needed, streaming any text it writes along the
  // way (including interim commentary), until it responds with plain text and no tool calls.
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (Date.now() >= deadlineAt) break;

    const { content, toolCalls } = await withRetry(
      () => streamTurn(messages, DATA_TOOL_DEFINITIONS, 'auto', handlers.onToken, deadlineAt),
      deadlineAt,
    );
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
      const args = safeParseArgs(tc.args);
      handlers.onStatus(describeToolCall(tc.name, args));
      const result = await executeDataTool(tc.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  finalText = finalText.trim();
  if (!finalText) {
    handlers.onFinal({ text: FALLBACK_NO_INFO, references: [] });
    return;
  }

  // Phase 2: force a structured `answer` tool call (no further data tools offered) purely to
  // extract citations for the UI — the visible answer text itself was already streamed above.
  // References are a nice-to-have, so this is deliberately best-effort: one attempt, no retry —
  // it's not worth adding latency to a working answer just to chase citation chips.
  messages.push({ role: 'assistant', content: finalText });
  messages.push({ role: 'user', content: 'Now call the answer tool listing every movie/person you cited.' });

  let references: ChatReference[] = [];
  try {
    const response = await groq.chat.completions.create(
      {
        model: env.groqModel,
        messages,
        tools: [ANSWER_TOOL],
        tool_choice: { type: 'function', function: { name: ANSWER_TOOL_NAME } },
        stream: false,
      },
      { signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS) },
    );

    const toolCall = response.choices[0]?.message.tool_calls?.[0];
    if (toolCall) {
      const parsed = safeParseArgs(toolCall.function.arguments) as { references?: ChatReference[] };
      references = Array.isArray(parsed.references) ? parsed.references : [];
    }
  } catch {
    references = [];
  }

  handlers.onFinal({ text: finalText, references });
}
