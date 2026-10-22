import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createZipArchive, } from '../packages/article-processing/src/index.js';
import { ContainedDatabase } from '../packages/db/src/index.js';

export function createBackup(dataDir, outputArchivePath) {
  const db = new ContainedDatabase(dataDir);
  const dbPayload = Buffer.from(JSON.stringify(db.read((s) => s), null, 2), 'utf8');
  const dbSha256 = crypto.createHash('sha256').update(dbPayload).digest('hex');

  const blobEntries = [];
  const manifestBlobs = [];

  if (fs.existsSync(db.blobs.blobDir)) {
    for (const file of fs.readdirSync(db.blobs.blobDir)) {
      if (!file.endsWith('.bin')) continue;
      const blobId = file.slice(0, -4);
      const buf = fs.readFileSync(path.join(db.blobs.blobDir, file));
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      manifestBlobs.push({ blob_id: blobId, size_bytes: buf.length, sha256 });
      blobEntries.push({ name: `blobs/${file}`, data: buf });
    }
  }

  const manifest = {
    backup_version: '2.0',
    created_at: new Date().toISOString(),
    schema_version: db.read((s) => s.schema_version),
    db_sha256: dbSha256,
    blobs: manifestBlobs,
  };

  const archiveBuf = createZipArchive([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'db.json', data: dbPayload },
    ...blobEntries,
  ]);

  fs.mkdirSync(path.dirname(path.resolve(outputArchivePath)), { recursive: true });
  // Write backup with restrictive 0o600 permissions (Section 9.3)
  fs.writeFileSync(outputArchivePath, archiveBuf, { mode: 0o600 });
  fs.chmodSync(outputArchivePath, 0o600);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const outPath = process.argv[2] || path.join(dataDir, `backup-${Date.now()}.zip`);
  const manifest = createBackup(dataDir, outPath);
  console.log(JSON.stringify({ event: 'backup.complete', outPath, manifest }, null, 2));
}
