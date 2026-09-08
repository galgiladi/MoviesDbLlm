import fs from 'fs';
import readline from 'readline';
import zlib from 'zlib';

/**
 * Streams a gzipped TSV file (IMDb dataset format) and yields each row as a
 * plain object keyed by the header column names. Avoids loading the whole
 * (multi-GB uncompressed) file into memory.
 */
export async function* streamTsvGz(filePath: string): AsyncGenerator<Record<string, string>> {
  const input = fs.createReadStream(filePath);
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });

  let header: string[] | null = null;
  for await (const line of rl) {
    const cols = line.split('\t');
    if (!header) {
      header = cols;
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = cols[i] ?? '';
    }
    yield row;
  }
}

export function nullable(value: string | undefined): string | undefined {
  if (value === undefined || value === '\\N' || value === '') return undefined;
  return value;
}

export function toIntOrUndefined(value: string | undefined): number | undefined {
  const v = nullable(value);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function toFloatOrUndefined(value: string | undefined): number | undefined {
  return toIntOrUndefined(value);
}

export function parseGenres(value: string | undefined): string[] {
  const v = nullable(value);
  if (!v) return [];
  return v.split(',').map((g) => g.trim()).filter(Boolean);
}

/** IMDb's `characters` column is a JSON-array-ish string, e.g. ["Neo"] or "\N". */
export function parseFirstCharacter(value: string | undefined): string | undefined {
  const v = nullable(value);
  if (!v) return undefined;
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0];
  } catch {
    // not JSON, fall through
  }
  return undefined;
}
