import { pathToFileURL } from 'node:url';
import { ContainedDatabase } from '../packages/db/src/index.ts';

export function runMigrations(dataDir?: string) {
  const db = new ContainedDatabase(dataDir);
  const applied = db.migrate();
  return {
    dataDir: db.dataDir,
    schemaVersion: db.read((s) => s.schema_version),
    migrations: applied,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = runMigrations(process.env.DATA_DIR);
  console.log(JSON.stringify({ event: 'migrations.complete', ...res }, null, 2));
}
