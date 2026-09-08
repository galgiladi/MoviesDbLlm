import { Router } from 'express';
import { addMovieFromImdbUrl, getMovie, listMovies, updateMovie } from '../controllers/movies.controller';

export const moviesRouter = Router();

moviesRouter.get('/', listMovies);
moviesRouter.get('/:id', getMovie);
moviesRouter.post('/', addMovieFromImdbUrl);
moviesRouter.patch('/:id', updateMovie);
