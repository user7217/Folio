import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractZipSafely } from '../packages/article-processing/src/index.ts';
import type { BackupManifest } from './backup.ts';

export function restoreBackup(archivePath: string, targetDataDir: string): BackupManifest {
  const archiveBuf = fs.readFileSync(archivePath);
  const entries = extractZipSafely(archiveBuf, { maxEntries: 5000, maxExpandedBytes: 250 * 1024 * 1024 });

  const manifestBuf = entries.get('manifest.json');
  const dbBuf = entries.get('db.json');
  if (!manifestBuf || !dbBuf) {
    throw new Error('Invalid backup archive: missing manifest.json or db.json');
  }

  const manifest = JSON.parse(manifestBuf.toString('utf8')) as BackupManifest;
  const actualDbSha = crypto.createHash('sha256').update(dbBuf).digest('hex');
  if (actualDbSha !== manifest.db_sha256) {
    throw new Error('Backup integrity check failed: db.json SHA-256 mismatch');
  }

  const resolvedTarget = path.resolve(targetDataDir);
  const blobDir = path.join(resolvedTarget, 'blobs');
  fs.mkdirSync(blobDir, { recursive: true });

  for (const b of manifest.blobs) {
    const entryBuf = entries.get(`blobs/${b.blob_id}.bin`);
    if (!entryBuf) {
      throw new Error(`Missing blob in backup archive: ${b.blob_id}`);
    }
    const sha = crypto.createHash('sha256').update(entryBuf).digest('hex');
    if (sha !== b.sha256) {
      throw new Error(`Blob SHA-256 mismatch for ${b.blob_id}`);
    }
    fs.writeFileSync(path.join(blobDir, `${b.blob_id}.bin`), entryBuf, { mode: 0o600 });
  }

  fs.writeFileSync(path.join(resolvedTarget, 'db.json'), dbBuf, { mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const archivePath = process.argv[2];
  const targetDir = process.argv[3] || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  if (!archivePath) {
    console.error('Usage: node scripts/restore.ts <backup-archive.zip> [target-data-dir]');
    process.exit(1);
  }
  const manifest = restoreBackup(archivePath, targetDir);
  console.log(JSON.stringify({ event: 'restore.complete', targetDir, manifest }, null, 2));
}
