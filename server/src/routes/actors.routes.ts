import { Router } from 'express';
import { getActor, listActors } from '../controllers/actors.controller';

export const actorsRouter = Router();

actorsRouter.get('/', listActors);
actorsRouter.get('/:id', getActor);
