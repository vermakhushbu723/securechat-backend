import { ApiError } from '../../utils/ApiError.js';
import { getSetting } from '../platform/platform.service.js';
import { User } from '../users/user.model.js';

/**
 * Search permissions (admin "Search Permissions" + group "Member search"):
 *  - platform: 1-to-1 user search on/off, group member search on/off (everyone)
 *  - user: the admin can turn search off for one person (both kinds)
 *  - group: the group admin (or the platform admin) can stop members searching its member list;
 *    group owner / admins can still search their own group.
 */
export const SEARCH_OFF_ADMIN = 'Search is turned off by the SecureChat team.';
export const SEARCH_OFF_USER = 'The SecureChat team turned off search for your account.';
export const SEARCH_OFF_GROUP = 'The group admin turned off member search in this group.';

export async function searchPermission(userId) {
  const [sys, u] = await Promise.all([getSetting('system'), User.findById(userId).select('searchBlocked').lean()]);
  const blocked = Boolean(u?.searchBlocked);
  const users = sys.userSearch !== false && !blocked;
  const members = sys.groupMemberSearch !== false && !blocked;
  const reason = (on, platform) => (on ? null : blocked ? SEARCH_OFF_USER : platform === false ? SEARCH_OFF_ADMIN : null);
  return {
    users,
    members,
    usersReason: reason(users, sys.userSearch),
    membersReason: reason(members, sys.groupMemberSearch),
  };
}

export async function assertUserSearch(userId) {
  const p = await searchPermission(userId);
  if (!p.users) throw ApiError.forbidden(p.usersReason ?? SEARCH_OFF_ADMIN, 'SEARCH_DISABLED');
}

/** Group member search: platform + user rule, then the group's own setting (admins exempt). */
export async function memberSearchBlock(userId, group, member) {
  const p = await searchPermission(userId);
  if (!p.members) return p.membersReason ?? SEARCH_OFF_ADMIN;
  const isGroupAdmin = member?.role === 'owner' || member?.role === 'admin';
  if (group?.settings?.members?.memberSearch === false && !isGroupAdmin) return SEARCH_OFF_GROUP;
  return null;
}
