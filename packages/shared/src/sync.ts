import type { Annotation, ClientMutation, LifecycleState, SyncResultStatus, UserItemState } from './index.ts';

export interface StateMergeOutcome {
  status: SyncResultStatus;
  reason: string | null;
  updatedState: UserItemState;
}

/**
 * Applies the Section 8.11 offline sync merge rules for `item_state`:
 * - read, favorite, archived: Apply the mutation if the field has not changed since `base_version`.
 *   Otherwise, last-writer-wins by server receive time, recorded as `merged`.
 * - Reading progress: Take the greater position, unless the mutation is an explicit reset (`reset_progress: true`).
 */
export function mergeItemStateMutation(
  currentState: UserItemState,
  mutation: ClientMutation,
  nowIso: string = new Date().toISOString()
): StateMergeOutcome {
  const payload = mutation.payload || {};
  const isStaleVersion = mutation.base_version < currentState.version;
  let wasMerged = false;

  const next: UserItemState = {
    ...currentState,
    version: currentState.version + 1,
    updated_at: nowIso,
  };

  if (typeof payload.is_read === 'boolean') {
    if (isStaleVersion && currentState.is_read !== payload.is_read) {
      wasMerged = true;
    }
    next.is_read = payload.is_read;
  }

  if (typeof payload.is_favorite === 'boolean') {
    if (isStaleVersion && currentState.is_favorite !== payload.is_favorite) {
      wasMerged = true;
    }
    next.is_favorite = payload.is_favorite;
  }

  if (payload.lifecycle === 'active' || payload.lifecycle === 'archived' || payload.lifecycle === 'trashed') {
    if (isStaleVersion && currentState.lifecycle !== payload.lifecycle) {
      wasMerged = true;
    }
    next.lifecycle = payload.lifecycle as LifecycleState;
  }

  if (typeof payload.progress_percent === 'number') {
    const incomingProgress = Math.max(0, Math.min(100, payload.progress_percent));
    const explicitReset = payload.reset_progress === true;
    if (explicitReset) {
      next.progress_percent = incomingProgress;
      if (isStaleVersion) wasMerged = true;
    } else {
      if (incomingProgress < currentState.progress_percent) {
        wasMerged = true;
      }
      next.progress_percent = Math.max(currentState.progress_percent, incomingProgress);
    }
    next.last_read_at = nowIso;
  }

  if (typeof payload.progress_page === 'number') {
    const explicitReset = payload.reset_progress === true;
    next.progress_page = explicitReset
      ? payload.progress_page
      : Math.max(currentState.progress_page ?? 1, payload.progress_page);
  }

  return {
    status: wasMerged || isStaleVersion ? 'merged' : 'applied',
    reason: wasMerged || isStaleVersion ? 'lww_or_monotonic_progress_merge' : null,
    updatedState: next,
  };
}

export interface AnnotationMergeOutcome {
  status: SyncResultStatus;
  reason: string | null;
  updatedAnnotation?: Annotation;
  conflict?: {
    clientPayload: Record<string, unknown>;
    serverSnapshot: Record<string, unknown>;
  };
}

/**
 * Applies Section 8.11 annotation sync rules:
 * - Annotation edit/delete with a stale `base_version` on a changed annotation creates a `conflict` record
 *   and preserves both versions for the user; never overwrites silently.
 */
export function evaluateAnnotationMutation(
  existing: Annotation | null,
  mutation: ClientMutation
): AnnotationMergeOutcome {
  if (mutation.op === 'create_annotation') {
    if (existing) {
      // Idempotent by client-generated ID
      return {
        status: 'applied',
        reason: 'idempotent_existing_annotation',
        updatedAnnotation: existing,
      };
    }
    return {
      status: 'applied',
      reason: null,
    };
  }

  if (!existing) {
    return {
      status: 'rejected',
      reason: 'annotation_not_found',
    };
  }

  if (mutation.base_version < existing.version) {
    return {
      status: 'conflict',
      reason: 'stale_base_version_on_changed_annotation',
      conflict: {
        clientPayload: mutation.payload,
        serverSnapshot: {
          id: existing.id,
          note: existing.note,
          exact_quote: existing.exact_quote,
          color: existing.color,
          version: existing.version,
          updated_at: existing.updated_at,
        },
      },
    };
  }

  return {
    status: 'applied',
    reason: null,
  };
}
