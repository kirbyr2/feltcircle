import { loadConfig } from './config.js';
import { startServer, SERVER_VERSION } from './server.js';

const config = loadConfig();

// `node server.mjs backup [file]` — consistent online snapshot of the database (safe while the server runs).
if (process.argv[2] === 'backup') {
  const { backupDatabase } = await import('./db.js');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = process.argv[3] || `${config.dataDir}/backups/feltcircle-${stamp}.sqlite`;
  backupDatabase(config.dbFile, target);
  console.log(`Backup written to ${target}`);
  process.exit(0);
}

const server = await startServer(config);
console.log(`FeltCircle server ${SERVER_VERSION} listening on http://${config.host}:${server.port}`);
console.log(`  database: ${config.dbFile}`);
console.log(`  static:   ${config.staticDir ?? '(not serving the web app)'}`);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await server.close();
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
