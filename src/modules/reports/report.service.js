import { getPublicUser, getPublicUsers } from '../../services/cache.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { audit } from '../audit/audit.service.js';
import { requireGroupAccess } from '../groups/group.access.js';
import { Group } from '../groups/group.model.js';
import { groupPreviewText } from '../groups/groupMessage.model.js';
import { loadMessageForUser } from '../groups/groupMessage.service.js';
import { block } from '../users/user.service.js';
import { Report } from './report.model.js';

export async function createReport(userId, input) {
  const doc = { reporter: userId, type: input.type, reasons: input.reasons, details: input.details };

  if (input.type === 'message') {
    const { m, group } = await loadMessageForUser(input.messageId, userId);
    const sender = await getPublicUser(m.sender);
    Object.assign(doc, {
      group: m.group,
      message: m._id,
      targetUser: m.sender,
      snapshot: {
        text: m.permissions?.viewOnce ? '[view once]' : groupPreviewText(m),
        type: m.type,
        visibility: m.visibility,
        senderName: sender?.displayName,
        groupName: group.name,
        forwardRootId: m.forward?.rootId ?? m._id,
      },
    });
  } else if (input.type === 'user') {
    if (String(input.userId) === String(userId)) throw ApiError.badRequest('You cannot report yourself');
    if (!(await getPublicUser(input.userId))) throw ApiError.notFound('User not found');
    Object.assign(doc, { targetUser: input.userId, group: input.groupId ?? null });
  } else {
    const { group } = await requireGroupAccess(input.groupId, userId, { allowSuspended: true });
    Object.assign(doc, { group: input.groupId, snapshot: { groupName: group.name } });
  }

  if (input.alsoBlock && doc.targetUser && String(doc.targetUser) !== String(userId)) {
    await block(userId, doc.targetUser);
    doc.alsoBlocked = true;
  }
  const report = await Report.create(doc);
  audit(userId, 'report_created', { group: doc.group, target: report._id, meta: { type: input.type } });
  return (await toDTOs([report.toObject()]))[0];
}

async function toDTOs(rows) {
  const users = await getPublicUsers(rows.map((r) => r.targetUser).filter(Boolean));
  const groups = await Group.find({ _id: { $in: rows.map((r) => r.group).filter(Boolean) } }).select('name').lean();
  const gmap = new Map(groups.map((g) => [String(g._id), g.name]));
  return rows.map((r) => ({
    id: String(r._id),
    type: r.type,
    reasons: r.reasons,
    details: r.details,
    status: r.status,
    resolution: r.resolution,
    alsoBlocked: r.alsoBlocked,
    targetName: r.targetUser ? users.get(String(r.targetUser))?.displayName ?? 'Member' : null,
    groupName: r.group ? gmap.get(String(r.group)) ?? r.snapshot?.groupName ?? null : null,
    messagePreview: r.snapshot?.text ?? null,
    createdAt: r.createdAt,
  }));
}

export async function myReports(userId) {
  const rows = await Report.find({ reporter: userId }).sort({ _id: -1 }).limit(200).lean();
  return toDTOs(rows);
}
