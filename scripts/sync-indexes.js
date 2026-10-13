/** Creates / updates every MySQL table (new columns, missing indexes). Safe to run any time. */
import { connectDatabase, disconnectDatabase } from '../src/db/database.js';
import { closeRedis } from '../src/db/redis.js';
import { syncAll } from '../src/db/sql/ddl.js';
import { allModels } from '../src/db/sql/model.js';

await connectDatabase({ sync: false });
await import('../src/db/models.js');
for (const r of await syncAll(allModels())) {
  console.log(`${r.table}: ready`, r.added.length ? `(new columns: ${r.added.join(', ')})` : '', r.built.length ? `(new indexes: ${r.built.join(', ')})` : '');
}
await disconnectDatabase();
await closeRedis();
