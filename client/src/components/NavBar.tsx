import { NavLink } from 'react-router-dom';

const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'nav-link nav-link-active' : 'nav-link');

export function NavBar() {
  return (
    <header className="nav-bar">
      <div className="nav-inner">
        <NavLink to="/" className="brand">
          🎬 Movie Explorer
        </NavLink>
        <nav className="nav-links">
          <NavLink to="/" end className={linkClass}>
            Movies
          </NavLink>
          <NavLink to="/movies/add" className={linkClass}>
            Add Movie
          </NavLink>
          <NavLink to="/actors" className={linkClass}>
            Actors
          </NavLink>
        </nav>
      </div>
    </header>
  );
}
