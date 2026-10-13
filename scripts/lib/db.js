/** Direct MySQL access for the test scripts (MYSQL_URL from .env, or another database). */
import mysql from 'mysql2/promise';

/** MYSQL_URL with another database name (e.g. a throw-away test database). */
export const withDatabase = (url, db) => url.replace(/\/([^/?]*)(\?|$)/, `/${db}$2`);

export async function sql(query, params = [], url = process.env.MYSQL_URL) {
  const conn = await mysql.createConnection({ uri: url, timezone: 'Z' });
  try {
    const [rows] = await conn.query(query, params);
    return rows;
  } finally {
    await conn.end();
  }
}
