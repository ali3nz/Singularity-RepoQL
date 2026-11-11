// Windows launcher: dist/server.mjs only auto-starts when import.meta.url === `file://${argv[1]}`,
// which never matches on Windows paths. Start the exported app explicitly.
import { serve } from '@hono/node-server';
import { createApp } from './dist/server.mjs';

const { app, config, knowledgeTelemetry } = createApp();
await knowledgeTelemetry.initialize();
const server = serve(
  { fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? '127.0.0.1' },
  (info) => console.log(`Knowledge service listening on http://127.0.0.1:${info.port}`),
);
const stop = async () => { await knowledgeTelemetry.shutdown(); server.close(() => process.exit(0)); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
