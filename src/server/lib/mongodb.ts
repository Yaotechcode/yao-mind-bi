import { MongoClient, type Db, type Collection } from 'mongodb';

// =============================================================================
// Environment variable validation
// =============================================================================

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

// =============================================================================
// Cached connection
//
// Netlify Functions are short-lived and may create a new module instance per
// invocation. The module-level cache prevents opening a new MongoClient on
// every request while still working correctly when the module IS reused across
// warm invocations.
//
// MONGODB_URI must use the standard (non-SRV) format to avoid querySrv failures:
//   mongodb://user:pass@h1:27017,h2:27017,h3:27017/db?authSource=admin&replicaSet=rs
// =============================================================================

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (_db) return _db;

  const uri = requireEnv('MONGODB_URI');
  const dbName = requireEnv('MONGODB_DB_NAME');

  _client = new MongoClient(uri, {
    // Keep the connection pool small — each function instance holds at most one
    // socket open so we don't exhaust the Atlas free-tier connection limit.
    maxPoolSize: 1,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 10000,
  });

  await _client.connect();
  _db = _client.db(dbName);
  return _db;
}

/** Convenience wrapper — returns a typed collection handle. */
export async function getCollection<T extends object = Record<string, unknown>>(
  name: string
): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}
