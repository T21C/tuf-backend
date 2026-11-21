import { parentPort, workerData } from 'node:worker_threads';
import mysql from 'mysql2/promise';

type WatchData = {
  flag: SharedArrayBuffer;
  jobId: number;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

const data = workerData as WatchData;
const flag = new Int32Array(data.flag);
let stopped = false;

parentPort?.on('message', (message) => {
  if (message === 'stop') stopped = true;
});

const connection = await mysql.createConnection({
  host: data.host,
  port: data.port,
  user: data.user,
  password: data.password,
  database: data.database,
});

try {
  while (!stopped) {
    const [rows] = await connection.query(
      'SELECT status FROM badge_jobs WHERE id = ? LIMIT 1',
      [data.jobId],
    );
    const status = Array.isArray(rows)
      ? (rows[0] as { status?: string } | undefined)?.status
      : undefined;
    if (status === 'cancelled') {
      Atomics.store(flag, 0, 1);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
} finally {
  await connection.end();
}
