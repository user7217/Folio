# Offline Support & Mutation Sync Protocol

## 1. Service Worker & Caching

- `/manifest.webmanifest` and `/sw.js` provide installable PWA support and cache the application shell plus user-opened items within the configured storage cap (`offlineStorageCapMb`).

## 2. Mutation Queue & Merge Rules (`POST /api/sync`)

Each client mutation carries `{ mutation_id (UUIDv7), entity, entity_id, base_version, op, payload }`:
- **Idempotency**: Deduplicated by `(user_id, mutation_id)`.
- **`item_state` (`is_read`, `is_favorite`, `lifecycle`)**: Applied directly if `base_version === current.version`; otherwise merged via Last-Writer-Wins and recorded as `merged`.
- **Reading Progress (`progress_percent`, `progress_page`)**: Takes `Math.max(server, client)` unless `reset_progress: true` is set.
- **Tags (`add_tag`, `remove_tag`)**: Merged as set operations.
- **Annotations**: `create_annotation` is idempotent by client ID. `update_annotation` or `delete_annotation` with a stale `base_version` creates a `SyncConflict` record preserving both client and server snapshots.
