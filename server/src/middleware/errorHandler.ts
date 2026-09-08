import { NextFunction, Request, Response } from 'express';
import { InvalidImdbUrlError, ImdbScrapeError } from '../services/imdbScrape.service';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof InvalidImdbUrlError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof ImdbScrapeError) {
    return res.status(502).json({ error: err.message });
  }

  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
