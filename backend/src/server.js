import app from './app.js';
import { startJobs } from './jobs.js';

startJobs(app.log);
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.LISTEN_HOST ?? '0.0.0.0' });
