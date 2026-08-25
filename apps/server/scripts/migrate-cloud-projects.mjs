import fs from 'node:fs/promises';
import process from 'node:process';
import { Pool } from 'pg';

const connectionString = process.env.LICLICK_CLOUD_DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error('LICLICK_CLOUD_DATABASE_URL is required for cloud project migrations.');
}

const migrations = await Promise.all([
  fs.readFile(new URL('../sql/001_project_documents_postgres.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../sql/002_shared_control_plane.sql', import.meta.url), 'utf8'),
]);
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('liclick-project-schema-v1'))");
  for (const migration of migrations) await client.query(migration);
  await client.query('COMMIT');
  process.stdout.write('Cloud project schema migration completed.\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
