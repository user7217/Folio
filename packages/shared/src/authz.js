

/**
 * Central authorization policy evaluator `can(actor, policy, resource)`.
 * - Enforces authentication, session/token revocation, role checks, and ownership/membership checks.
 * - Never reveals whether a private resource exists to an unauthorized user (returns 404 for private resources).
 */
export function can(
  actor,
  policy,
  ctx = {}
) {
  if (policy === 'public') {
    return { allowed: true, statusCode: 200, reason: 'public_route' };
  }

  if (actor.sessionRevoked || actor.tokenRevoked || !actor.user) {
    return { allowed: false, statusCode: 401, reason: 'unauthenticated_or_revoked' };
  }

  // Extension tokens are strictly capture-scoped
  if (actor.authType === 'extension_token' && policy !== 'extension_or_authenticated') {
    return { allowed: false, statusCode: 403, reason: 'extension_token_scope_exceeded' };
  }

  if (policy === 'authenticated' || policy === 'extension_or_authenticated') {
    return { allowed: true, statusCode: 200, reason: 'authenticated' };
  }

  if (policy === 'admin') {
    if (actor.user.role === 'admin') {
      return { allowed: true, statusCode: 200, reason: 'admin_role' };
    }
    return { allowed: false, statusCode: 403, reason: 'admin_required' };
  }

  const userId = actor.user.id;

  if (policy === 'item:read') {
    if (!ctx.item) {
      return { allowed: false, statusCode: 404, reason: 'not_found' };
    }
    if (ctx.item.owner_id === userId) {
      return { allowed: true, statusCode: 200, reason: 'item_owner' };
    }
    if (ctx.itemSharedCollectionRoles && ctx.itemSharedCollectionRoles.length > 0) {
      return { allowed: true, statusCode: 200, reason: 'shared_collection_member' };
    }
    // Do not reveal existence of another user's item
    return { allowed: false, statusCode: 404, reason: 'not_found' };
  }

  if (policy === 'item:write' || policy === 'item:owner') {
    if (!ctx.item) {
      return { allowed: false, statusCode: 404, reason: 'not_found' };
    }
    if (ctx.item.owner_id === userId) {
      return { allowed: true, statusCode: 200, reason: 'item_owner' };
    }
    if (ctx.itemSharedCollectionRoles && ctx.itemSharedCollectionRoles.length > 0) {
      return { allowed: false, statusCode: 403, reason: 'owner_required' };
    }
    return { allowed: false, statusCode: 404, reason: 'not_found' };
  }

  if (policy === 'collection:read') {
    if (!ctx.collection) {
      return { allowed: false, statusCode: 404, reason: 'not_found' };
    }
    if (ctx.collection.owner_id === userId || ctx.collectionMember) {
      return { allowed: true, statusCode: 200, reason: 'collection_member' };
    }
    return { allowed: false, statusCode: 404, reason: 'not_found' };
  }

  if (policy === 'collection:edit') {
    if (!ctx.collection) {
      return { allowed: false, statusCode: 404, reason: 'not_found' };
    }
    if (ctx.collection.owner_id === userId) {
      return { allowed: true, statusCode: 200, reason: 'collection_owner' };
    }
    if (ctx.collectionMember) {
      if (ctx.collectionMember.role === 'owner' || ctx.collectionMember.role === 'editor') {
        return { allowed: true, statusCode: 200, reason: 'collection_editor' };
      }
      return { allowed: false, statusCode: 403, reason: 'editor_role_required' };
    }
    return { allowed: false, statusCode: 404, reason: 'not_found' };
  }

  if (policy === 'collection:owner') {
    if (!ctx.collection) {
      return { allowed: false, statusCode: 404, reason: 'not_found' };
    }
    if (ctx.collection.owner_id === userId) {
      return { allowed: true, statusCode: 200, reason: 'collection_owner' };
    }
    if (ctx.collectionMember) {
      return { allowed: false, statusCode: 403, reason: 'owner_role_required' };
    }
    return { allowed: false, statusCode: 404, reason: 'not_found' };
  }

  if (policy === 'annotation:write') {
    if (!ctx.annotation) {
      return { allowed: false, statusCode: 404, reason: 'not_found' };
    }
    if (ctx.annotation.user_id === userId) {
      return { allowed: true, statusCode: 200, reason: 'annotation_owner' };
    }
    return { allowed: false, statusCode: 404, reason: 'not_found' };
  }

  if (policy === 'feed:owner') {
    if (!ctx.feed || ctx.feed.owner_id !== userId) {
      return { allowed: false, statusCode: 404, reason: 'not_found' };
    }
    return { allowed: true, statusCode: 200, reason: 'feed_owner' };
  }

  if (policy === 'export:owner') {
    if (!ctx.exportArtifact || ctx.exportArtifact.user_id !== userId) {
      return { allowed: false, statusCode: 404, reason: 'not_found' };
    }
    return { allowed: true, statusCode: 200, reason: 'export_owner' };
  }

  return { allowed: false, statusCode: 403, reason: 'default_deny' };
}
