import { Router } from 'express';
import { postChat } from '../controllers/chat.controller';

export const chatRouter = Router();

chatRouter.post('/', postChat);
