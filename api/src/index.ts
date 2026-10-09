import { serve } from '@hono/node-server';
import { createSunnie } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`sunnie: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const sunnie = createSunnie(config);
  const { log } = sunnie.deps;
  const server = serve(
    { fetch: sunnie.app.fetch, hostname: config.server.host, port: config.server.port },
    (address) => {
      log.info('sunnie is up', {
        url: `http://${address.address}:${address.port}`,
        model: config.agent.defaultModel,
        router: sunnie.deps.router.name,
        approvals: sunnie.deps.risk.name,
        recall: sunnie.deps.recall.name,
        semanticRecall: sunnie.deps.semantic?.spec ?? 'off',
        heartbeat: config.heartbeat.enabled ? `every ${config.heartbeat.intervalMinutes} min` : 'off',
        home: config.home,
        computer: sunnie.deps.computer.describe(),
      });
    },
  );

  sunnie.heartbeat.start();

  // One stray rejection (a socket that died mid-write, say) must not end every run in flight.
  process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    server.close();
    void sunnie.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main();
