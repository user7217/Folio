# Import & Export Specification

## 1. Versioned JSON Schema (`schema_version: "2.0"`)

```json
{
  "schema_version": "2.0",
  "exported_at": "2026-10-14T13:15:00.000Z",
  "user_id": "0199e3...",
  "items": [],
  "states": [],
  "tags": [],
  "item_tags": [],
  "collections": [],
  "annotations": [],
  "feeds": []
}
```

## 2. Supported Formats

- **Imports (`POST /api/import`)**: `json` (`schema_version: "2.0"` or `"1.0"`), `bookmarks_html`, `pocket_html`, `csv`, `opml`, and `txt`.
- **Dry-Run Mode**: Pass `{ "dryRun": true }` to validate records and receive `{ imported, updated, duplicate, skipped, failed }` counts without mutating the database.
- **Exports (`POST /api/export`)**: Runs asynchronously via `export.generate` worker jobs for `json`, `csv`, and `opml`, scoped strictly to the requesting user and downloaded via expiring token links (`GET /api/export/:id/download?token=...`).
