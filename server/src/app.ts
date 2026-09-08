import cors from 'cors';
import express from 'express';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { moviesRouter } from './routes/movies.routes';
import { actorsRouter } from './routes/actors.routes';
import { chatRouter } from './routes/chat.routes';

export const app = express();

app.use(cors({ origin: env.clientOrigin }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/movies', moviesRouter);
app.use('/api/actors', actorsRouter);
app.use('/api/chat', chatRouter);

app.use(errorHandler);
