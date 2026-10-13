import { logger } from '../config/logger.js';
import { connectDb, disconnectDb, isConnected, ping } from './sql/connection.js';
import { syncAll } from './sql/ddl.js';
import { allModels } from './sql/model.js';

/**
 * MySQL database (MYSQL_URL). On start the tables of every model are created / updated
 * (new columns and indexes are added; nothing is dropped).
 */
export async function connectDatabase({ sync = true } = {}) {
  await connectDb();
  if (sync) {
    // every model module registers itself when imported
    await import('./models.js');
    await syncAll(allModels());
    logger.info({ tables: allModels().length }, 'MySQL tables ready');
  }
}

export const disconnectDatabase = disconnectDb;
export const databaseReady = isConnected;
export const pingDatabase = ping;
