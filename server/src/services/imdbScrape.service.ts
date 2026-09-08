import axios from 'axios';
import * as cheerio from 'cheerio';

export interface ScrapedActor {
  name: string;
}

export interface ScrapedMovie {
  id: string;
  title: string;
  year?: number;
  genres: string[];
  runtimeMinutes?: number;
  score?: number;
  numVotes?: number;
  description: string;
  imdbUrl: string;
  posterUrl?: string;
  actors: ScrapedActor[];
}

export class InvalidImdbUrlError extends Error {}
export class ImdbScrapeError extends Error {}

function extractImdbId(url: string): string {
  const match = url.match(/title\/(tt\d+)/i);
  if (!match) {
    throw new InvalidImdbUrlError('URL does not look like an IMDb title page (expected .../title/tt.../)');
  }
  return match[1];
}

function parseDurationToMinutes(duration?: string): number | undefined {
  if (!duration) return undefined;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const total = hours * 60 + minutes;
  return total > 0 ? total : undefined;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function scrapeImdbMovie(rawUrl: string): Promise<ScrapedMovie> {
  const imdbId = extractImdbId(rawUrl);
  const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;

  let html: string;
  try {
    const response = await axios.get<string>(imdbUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    });
    html = response.data;
  } catch (err) {
    throw new ImdbScrapeError(`Failed to fetch IMDb page: ${(err as Error).message}`);
  }

  const $ = cheerio.load(html);
  const script = $('script[type="application/ld+json"]').first().html();
  if (!script) {
    throw new ImdbScrapeError('Could not find structured data on the IMDb page');
  }

  let data: any;
  try {
    data = JSON.parse(script);
  } catch {
    throw new ImdbScrapeError('Could not parse structured data on the IMDb page');
  }

  const genres = asArray<string>(data.genre);
  const actors = asArray<any>(data.actor)
    .filter((a) => a && a.name)
    .map((a) => ({ name: String(a.name) }));

  const year = data.datePublished ? Number(String(data.datePublished).slice(0, 4)) : undefined;

  return {
    id: imdbId,
    title: data.name ?? imdbId,
    year: Number.isFinite(year) ? year : undefined,
    genres,
    runtimeMinutes: parseDurationToMinutes(data.duration),
    score: data.aggregateRating?.ratingValue ? Number(data.aggregateRating.ratingValue) : undefined,
    numVotes: data.aggregateRating?.ratingCount ? Number(data.aggregateRating.ratingCount) : undefined,
    description: data.description ?? '',
    imdbUrl,
    posterUrl: typeof data.image === 'string' ? data.image : undefined,
    actors,
  };
}
