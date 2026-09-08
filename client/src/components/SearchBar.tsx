import { FormEvent, useState } from 'react';

interface SearchBarProps {
  initialValue?: string;
  placeholder?: string;
  onSearch: (value: string) => void;
}

export function SearchBar({ initialValue = '', placeholder, onSearch }: SearchBarProps) {
  const [value, setValue] = useState(initialValue);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSearch(value.trim());
  }

  return (
    <form className="search-bar" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder ?? 'Search...'}
        aria-label="Search"
      />
      <button type="submit">Search</button>
    </form>
  );
}
