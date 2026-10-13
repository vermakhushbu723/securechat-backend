import { AsyncLocalStorage } from 'node:async_hooks';

import mysql from 'mysql2/promise';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * MySQL connection pool. Every model query goes through `exec()`; inside `transaction()`
 * the same connection is reused (AsyncLocalStorage), so read-modify-write updates lock
 * their rows with SELECT ... FOR UPDATE.
 */
let pool = null;
const txStore = new AsyncLocalStorage();

export function getPool() {
  if (!pool) throw new Error('MySQL is not connected (call connectDb first)');
  return pool;
}

export async function connectDb(url = env.MYSQL_URL) {
  if (pool) return pool;
  pool = mysql.createPool({
    uri: url,
    connectionLimit: env.MYSQL_POOL_SIZE,
    waitForConnections: true,
    // UTC everywhere: DATETIME columns hold UTC, JS Dates convert both ways.
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    charset: 'utf8mb4', // table columns use utf8mb4_0900_as_cs (case-sensitive like MongoDB)
    // affectedRows = rows matched (Mongo "matchedCount"), changedRows = modified.
    flags: ['FOUND_ROWS'],
    enableKeepAlive: true,
  });
  const [[row]] = await pool.query('SELECT DATABASE() AS db, VERSION() AS version');
  logger.info({ db: row.db, version: row.version }, 'MySQL connected');
  return pool;
}

export async function disconnectDb() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

export const isConnected = () => Boolean(pool);

/** Runs SQL on the current transaction's connection, or on the pool. */
export async function exec(sql, params = []) {
  const conn = txStore.getStore() ?? getPool();
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } catch (err) {
    throw mapSqlError(err, sql);
  }
}

/** All queries inside `fn` run in one transaction (nested calls join the outer one). */
export async function transaction(fn) {
  const current = txStore.getStore();
  if (current) return fn();
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await txStore.run(conn, fn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function ping() {
  await exec('SELECT 1');
  return true;
}

/** Duplicate key -> the same shape as MongoDB's E11000 (callers check `err.code === 11000`). */
function mapSqlError(err, sql) {
  if (err?.errno === 1062) {
    const m = /for key '(?:[^.']+\.)?([^']+)'/.exec(err.sqlMessage ?? '');
    const e = new Error(`E11000 duplicate key error: ${err.sqlMessage}`);
    e.code = 11000;
    e.keyPattern = { [m?.[1]?.replace(/^ux_[^_]+_/, '') ?? 'field']: 1 };
    e.sqlMessage = err.sqlMessage;
    return e;
  }
  err.sql = sql?.slice(0, 500);
  return err;
}
