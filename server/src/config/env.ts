import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: Number(process.env.PORT ?? 4000),
  esNode: process.env.ES_NODE ?? 'http://localhost:9200',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  groqModel: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
};
