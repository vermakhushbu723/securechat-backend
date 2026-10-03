import { invalidateUser } from '../../services/cache.service.js';
import { emitToGroup, invalidateGroup } from '../groups/group.access.js';
import { Group } from '../groups/group.model.js';
import { getSetting, updateSetting } from '../platform/platform.service.js';
import { emitToUser } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { toSelfUser, User } from '../users/user.model.js';
import { internalId, like, paged, pageResult, USER_FIELDS, userRows } from './admin.common.js';

/** Admin "Search Permissions" screen. */
export async function overview(query) {
  const p = paged(query);
  const userFilter = { searchBlocked: true, status: { $ne: 'deleted' } };
  if (query.q?.trim()) userFilter.$or = [{ name: like(query.q) }, { phone: like(query.q) }, { email: like(query.q) }];
  const groupFilter = { status: { $ne: 'deleted' }, 'settings.members.memberSearch': false };
  const [sys, users, usersTotal, groups, groupsTotal] = await Promise.all([
    getSetting('system'),
    User.find(userFilter).select(USER_FIELDS).sort({ updatedAt: -1 }).skip(p.skip).limit(p.limit).lean(),
    User.countDocuments(userFilter),
    Group.find(groupFilter).select('name memberCount createdBy status').sort({ updatedAt: -1 }).limit(100).lean(),
    Group.countDocuments(groupFilter),
  ]);
  const creators = await User.find({ _id: { $in: groups.map((g) => g.createdBy) } }).select('name').lean();
  return {
    global: { userSearch: sys.userSearch !== false, groupMemberSearch: sys.groupMemberSearch !== false },
    users: pageResult(await userRows(users), usersTotal, p),
    groups: {
      total: groupsTotal,
      items: groups.map((g) => ({
        id: String(g._id),
        name: g.name,
        memberCount: g.memberCount,
        status: g.status,
        createdBy: creators.find((c) => String(c._id) === String(g.createdBy))?.name ?? 'Deleted user',
      })),
    },
  };
}

export async function setGlobal(patch) {
  const v = await updateSetting('system', patch);
  return { userSearch: v.userSearch !== false, groupMemberSearch: v.groupMemberSearch !== false };
}

export async function setUserSearch(userId, allowed) {
  const u = await User.findByIdAndUpdate(userId, { $set: { searchBlocked: !allowed } }, { returnDocument: 'after', lean: true });
  if (!u) throw ApiError.notFound('User not found');
  await invalidateUser(userId);
  emitToUser(String(userId), 'user:updated', toSelfUser(u));
  return { id: String(u._id), name: u.name, internalId: internalId(u._id), searchAllowed: allowed };
}

export async function setGroupMemberSearch(groupId, enabled) {
  const g = await Group.findByIdAndUpdate(groupId, { $set: { 'settings.members.memberSearch': enabled } }, { returnDocument: 'after', lean: true });
  if (!g || g.status === 'deleted') throw ApiError.notFound('Group not found');
  await invalidateGroup(groupId);
  emitToGroup(String(groupId), 'group:updated', { groupId: String(groupId) });
  return { id: String(g._id), name: g.name, memberSearch: enabled };
}
