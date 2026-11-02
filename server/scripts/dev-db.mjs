// Ensures the local development database is reachable before `npm run dev`.
//
// The project uses a user-owned PostgreSQL 16 cluster in AppData on port 5433
// (the Windows service on 5432 has a different password). Remote/production
// databases are left alone — this script only starts a LOCAL cluster.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('\n[db] DATABASE_URL is not set. Copy server/.env.example to server/.env and fill it in.\n');
  process.exit(1);
}

let target;
try {
  target = new URL(url);
} catch {
  console.error('\n[db] DATABASE_URL is not a valid PostgreSQL connection string.\n');
  process.exit(1);
}

const host = target.hostname;
const port = Number(target.port || 5432);
const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';

function canConnect(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForConnection(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await canConnect()) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return canConnect();
}

// Only manage a local cluster. Never touch a hosted database.
if (!isLocal || (await canConnect())) {
  process.exit(0);
}

const localPg = {
  bin: process.env.LOCAL_PG_BIN || path.join(os.homedir(), 'AppData', 'Local', 'PostgreSQL', '16', 'bin'),
  data: process.env.LOCAL_PG_DATA || path.join(os.homedir(), 'AppData', 'Local', 'PostgreSQL', '16', 'data'),
};
const pgCtl = path.join(localPg.bin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');

if (!existsSync(pgCtl) || !existsSync(localPg.data)) {
  console.error(
    `\n[db] Cannot reach PostgreSQL at ${host}:${port}.\n` +
      '     Start your database, or set DATABASE_URL in server/.env to a running instance.\n' +
      '     The expected local PostgreSQL 16 cluster was not found in AppData.\n',
  );
  process.exit(1);
}

console.log(`[db] PostgreSQL is not running on ${host}:${port} - starting the local cluster...`);
const logFile = path.join(localPg.data, '..', 'pg.log');
const started = spawnSync(
  pgCtl,
  ['-D', localPg.data, '-o', `-p ${port}`, '-l', logFile, 'start'],
  { stdio: 'inherit' },
);

if (!(await waitForConnection(15))) {
  console.error(
    `\n[db] PostgreSQL did not start on ${host}:${port} (pg_ctl exit code ${started.status ?? 'unknown'}).\n` +
      `     See ${logFile} for details.\n`,
  );
  process.exit(1);
}

console.log(`[db] Local PostgreSQL is ready on ${host}:${port}`);
