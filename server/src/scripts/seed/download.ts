import fs from 'fs';
import path from 'path';
import axios from 'axios';

const BASE_URL = 'https://datasets.imdbws.com';
const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', '.cache');

const FILES = ['title.basics.tsv.gz', 'title.ratings.tsv.gz', 'title.principals.tsv.gz', 'name.basics.tsv.gz'];

async function downloadFile(name: string) {
  const dest = path.join(CACHE_DIR, name);
  if (fs.existsSync(dest)) {
    console.log(`Skipping ${name} (already downloaded)`);
    return;
  }

  console.log(`Downloading ${name} ...`);
  const response = await axios.get(`${BASE_URL}/${name}`, { responseType: 'stream' });

  const tmpDest = `${dest}.tmp`;
  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(tmpDest);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  fs.renameSync(tmpDest, dest);
  console.log(`Downloaded ${name}`);
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const file of FILES) {
    // Sequential to keep memory/bandwidth usage predictable for these large files.
    // eslint-disable-next-line no-await-in-loop
    await downloadFile(file);
  }
  console.log('All IMDb dataset files are ready.');
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});
