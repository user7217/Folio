# Backup & Restore Procedure

## 1. Creating a Backup

Run the backup script to package `db.json`, all binary blobs in `DATA_DIR/blobs/*.bin`, and a cryptographic `manifest.json` containing SHA-256 digests:

```bash
node scripts/backup.ts /Users/harsha1/Documents/pocket_clone/data/backup-latest.zip
```

Backup archives are written with restrictive `0600` file permissions.

## 2. Restoring into a Fresh Database Directory

```bash
node scripts/restore.ts /Users/harsha1/Documents/pocket_clone/data/backup-latest.zip /Users/harsha1/Documents/pocket_clone/data-restored
```

`scripts/restore.ts` enforces zip-slip and zip-bomb limits, verifies the SHA-256 digest of `db.json` and every blob against `manifest.json`, and atomically writes the restored files.
