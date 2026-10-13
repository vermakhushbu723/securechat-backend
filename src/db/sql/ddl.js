import { logger } from '../../config/logger.js';
import { exec } from './connection.js';

/**
 * Creates the MySQL table of a model, adds columns that are new in the schema and builds
 * missing indexes. Safe to run on every start (`npm run db:sync` / server boot).
 */
const q = (n) => `\`${n}\``;

export async function syncTable(info) {
  const ordered = [...info.columns].sort((a, b) => (a.name === '_id' ? -1 : b.name === '_id' ? 1 : 0));
  const cols = ordered.map((c) => `${q(c.name)} ${c.sql}${c.name === '_id' ? '' : ' NULL'}`);
  await exec(
    `CREATE TABLE IF NOT EXISTS ${q(info.table)} (\n  ${cols.join(',\n  ')},\n  PRIMARY KEY (\`_id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
  );

  const existing = await exec('SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [info.table]);
  const have = new Set(existing.map((r) => r.name));
  const added = [];
  for (const c of info.columns) {
    if (have.has(c.name)) continue;
    await exec(`ALTER TABLE ${q(info.table)} ADD COLUMN ${q(c.name)} ${c.sql} NULL`);
    added.push(c.name);
  }

  const idx = await exec('SELECT DISTINCT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [info.table]);
  const haveIdx = new Set(idx.map((r) => r.name));
  const built = [];
  for (const i of info.indexes) {
    if (haveIdx.has(i.name)) continue;
    await exec(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(info.table)} (${i.cols.join(', ')})`);
    built.push(i.name);
  }
  if (added.length || built.length) logger.info({ table: info.table, added, built }, 'MySQL table synced');
  return { table: info.table, added, built };
}

/** Every registered model's table. */
export async function syncAll(models) {
  const out = [];
  for (const m of models) out.push(await syncTable(m.info));
  return out;
}
