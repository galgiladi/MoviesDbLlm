import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: Number(process.env.PORT ?? 4000),
  esNode: process.env.ES_NODE ?? 'http://localhost:9200',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
};
