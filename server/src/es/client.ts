import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env';

export const esClient = new Client({ node: env.esNode });
