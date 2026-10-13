/**
 * Copies every collection from the old MongoDB (MONGO_URI) into MySQL (MYSQL_URL).
 * IDs, dates and every field stay the same, so the apps, links and sessions keep working.
 * Safe to run again: rows with the same _id are overwritten (nothing is deleted in MySQL).
 *
 *   node scripts/migrate-mongo-to-mysql.js              all collections
 *   node scripts/migrate-mongo-to-mysql.js users groups  only these tables
 *
 * MongoDB is only read. At the end the row counts of both databases are compared.
 */
import 'dotenv/config';

import dns from 'node:dns';

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../src/db/database.js';
import { closeRedis } from '../src/db/redis.js';
import { allModels } from '../src/db/sql/model.js';

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI (the old MongoDB) is not set in .env');
  process.exit(1);
}
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map((x) => x.trim()).filter(Boolean));

const only = new Set(process.argv.slice(2));
const BATCH = 500;

await connectDatabase(); // creates the MySQL tables
const mongo = await mongoose.createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20_000 }).asPromise();
console.log(`\nMongoDB "${mongo.name}" -> MySQL\n`);

const summary = [];
let failed = false;
for (const model of allModels()) {
  const name = model.tableName;
  if (only.size && !only.has(name)) continue;
  const coll = mongo.db.collection(name);
  const total = await coll.countDocuments();
  let copied = 0;
  const started = Date.now();
  try {
    const cursor = coll.find({}).sort({ _id: 1 }).batchSize(BATCH);
    let batch = [];
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= BATCH) {
        copied += await model.importRaw(batch);
        batch = [];
        process.stdout.write(`\r  ${name}: ${copied} / ${total}`);
      }
    }
    if (batch.length) copied += await model.importRaw(batch);
    const inMysql = await model.estimatedDocumentCount();
    const ok = inMysql >= total;
    if (!ok) failed = true;
    summary.push({ table: name, mongodb: total, mysql: inMysql, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) });
    process.stdout.write(`\r  ${name}: ${copied} / ${total} copied  (MySQL now ${inMysql})${ok ? '' : '  <-- MISSING ROWS'}\n`);
  } catch (err) {
    failed = true;
    summary.push({ table: name, mongodb: total, mysql: 'error', ok: false, error: err.message });
    console.log(`\n  ${name}: FAILED - ${err.message}`);
  }
}

console.log('\nSummary');
console.table(summary);
await mongo.close();
await disconnectDatabase();
await closeRedis();
console.log(failed ? '\nSome tables did not copy completely - see above.' : '\nAll data copied to MySQL.');
process.exit(failed ? 1 : 0);
