import { getPublicUsers } from '../../services/cache.service.js';

export const userMapFor = (messages, extraIds = []) =>
  getPublicUsers([...messages.flatMap((m) => [m.sender, m.replyTo?.sender].filter(Boolean)), ...extraIds].map(String));

function mediaDTO(media) {
  if (!media) return null;
  if (media.secureFileId) {
    // Protected: no URL at all - the secure viewer asks for a short-lived token.
    return {
      secure: true,
      fileId: String(media.secureFileId),
      mimeType: media.mimeType,
      name: media.name ?? null,
      size: media.size ?? 0,
      width: media.width ?? null,
      height: media.height ?? null,
      duration: media.duration ?? null,
    };
  }
  return {
    secure: false,
    url: media.url,
    thumbUrl: media.thumbUrl ?? null,
    mimeType: media.mimeType,
    name: media.name ?? null,
    size: media.size ?? 0,
    width: media.width ?? null,
    height: media.height ?? null,
    duration: media.duration ?? null,
  };
}

/**
 * Serializes a group message for one viewer.
 * - view-once content is never included for other members (they open it via /open)
 * - "admins only" files are withheld from regular members
 * - status (✓ / ✓✓ / blue ✓✓) is computed for the sender from the group read pointers
 */
export function toGroupMessageDTO(m, viewerId, { users = new Map(), pointers = null, viewerIsAdmin = false, revealed = false } = {}) {
  const viewer = String(viewerId);
  const senderId = String(m.sender);
  const mine = senderId === viewer;
  const deleted = m.status === 'deleted_for_everyone';
  const expired = m.status === 'expired';
  const perms = m.permissions ?? {};
  const openedByViewer = (m.openedBy ?? []).some((u) => String(u) === viewer);
  const viewOnceHidden = perms.viewOnce && !mine && !revealed;
  const adminOnlyHidden = perms.whoCanView === 'admins' && !mine && !viewerIsAdmin && Boolean(m.media);
  const withheld = !deleted && !expired && (viewOnceHidden || adminOnlyHidden);
  const hideContent = deleted || expired || withheld;
  const sender = users.get(senderId);
  const replySender = m.replyTo?.sender ? users.get(String(m.replyTo.sender)) : null;

  let status = null;
  if (mine && pointers && m.type !== 'system') {
    const id = String(m._id);
    status = pointers.read && id <= pointers.read ? 'read' : pointers.delivered && id <= pointers.delivered ? 'delivered' : 'sent';
  }

  return {
    id: String(m._id),
    groupId: String(m.group),
    clientMsgId: m.clientMsgId,
    senderId,
    senderName: sender?.displayName ?? 'Member',
    senderAvatar: sender?.avatarUrl ?? null,
    type: m.type,
    text: hideContent ? '' : m.text,
    media: hideContent && !withheld ? null : withheld ? (m.media ? { secure: true, withheld: true, mimeType: m.media.mimeType, name: null, size: 0 } : null) : mediaDTO(m.media),
    location: hideContent ? null : (m.location ?? null),
    contact: hideContent ? null : (m.contact ?? null),
    visibility: m.visibility,
    permissions: {
      allowDownload: m.visibility === 'public' && perms.allowDownload !== false,
      allowScreenshot: m.visibility === 'public' && perms.allowScreenshot !== false,
      allowShare: m.visibility === 'public' && Boolean(perms.allowShare),
      allowPrint: m.visibility === 'public' && Boolean(perms.allowPrint),
      canForward: m.visibility === 'public',
      canCopy: m.visibility === 'public',
      watermark: m.visibility === 'highly_protected',
      whoCanView: perms.whoCanView ?? 'members',
      viewOnce: Boolean(perms.viewOnce),
      expiresAt: perms.expiresAt ?? null,
      accessExpiresAt: perms.accessExpiresAt ?? null,
    },
    viewOnce: Boolean(perms.viewOnce),
    opened: Boolean(perms.viewOnce) && (mine || openedByViewer),
    withheld,
    withheldReason: withheld ? (viewOnceHidden ? (openedByViewer ? 'opened' : 'view_once') : 'admins_only') : null,
    silent: Boolean(m.silent),
    replyTo: !hideContent && m.replyTo?.id
      ? {
          id: String(m.replyTo.id),
          senderId: String(m.replyTo.sender),
          senderName: replySender?.displayName ?? m.replyTo.senderName ?? 'Member',
          type: m.replyTo.type,
          text: m.replyTo.text,
          visibility: m.replyTo.visibility ?? 'public',
        }
      : null,
    forwarded: Boolean(m.forward),
    forwardDepth: m.forward?.depth ?? 0,
    forwardCount: m.forwardCount ?? 0,
    reactions: hideContent ? [] : (m.reactions ?? []).map((r) => ({ userId: String(r.user), emoji: r.emoji })),
    edited: Boolean(m.editedAt),
    deleted,
    expired,
    deletedReason: m.deletedReason ?? null,
    starred: (m.starredBy ?? []).some((u) => String(u) === viewer),
    status,
    system: m.system ? { event: m.system.event, actorId: m.system.actor ? String(m.system.actor) : null } : null,
    createdAt: m.createdAt,
  };
}
