import { Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { streamChatAnswer } from '../services/chat.service';

function writeEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export const postChat = asyncHandler(async (req: Request, res: Response) => {
  const { question } = req.body ?? {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    throw new HttpError(400, 'question is required');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    await streamChatAnswer(question.trim(), {
      onToken: (text) => writeEvent(res, 'token', { text }),
      onFinal: (answer) => writeEvent(res, 'final', answer),
    });
  } catch (err) {
    writeEvent(res, 'error', { message: 'Failed to generate an answer.' });
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.end();
});
