import { Route, Routes } from 'react-router-dom';
import { NavBar } from './components/NavBar';
import { MoviesPage } from './pages/MoviesPage';
import { MovieDetailPage } from './pages/MovieDetailPage';
import { AddMoviePage } from './pages/AddMoviePage';
import { ActorsPage } from './pages/ActorsPage';
import { ActorDetailPage } from './pages/ActorDetailPage';

export function App() {
  return (
    <>
      <NavBar />
      <main>
        <Routes>
          <Route path="/" element={<MoviesPage />} />
          <Route path="/movies/add" element={<AddMoviePage />} />
          <Route path="/movies/:id" element={<MovieDetailPage />} />
          <Route path="/actors" element={<ActorsPage />} />
          <Route path="/actors/:id" element={<ActorDetailPage />} />
        </Routes>
      </main>
    </>
  );
}
