import { app } from './app';
import { env } from './config/env';
import { ensureIndices } from './es/indices';

async function main() {
  await ensureIndices();
  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
