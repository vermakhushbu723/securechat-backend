import { getPublicUsers } from '../../services/cache.service.js';
import { emitToUsers } from '../../socket/emitter.js';
import { ApiError } from '../../utils/ApiError.js';
import { adminIds, emitToGroup, isAdmin, requireGroupAccess } from '../groups/group.access.js';
import { Group, GroupMember } from '../groups/group.model.js';
import { User } from '../users/user.model.js';
import { LocationHistory } from './location.model.js';

const RANGE_MS = { today: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };

function liveActive(settings, now = new Date()) {
  if (settings?.mode !== 'live') return false;
  return !settings.liveUntil || new Date(settings.liveUntil) > now;
}

/** Live = fresh update (2x interval, min 15 min), Stale = older / join-only, Off = not shared. */
function statusOf(loc, intervalMin = 10, now = Date.now()) {
  if (!loc || loc.lat == null || loc.mode === 'none') return 'Off';
  const fresh = Math.max(intervalMin * 2, 15) * 60_000;
  return loc.mode === 'live' && now - new Date(loc.updatedAt).getTime() <= fresh ? 'Live' : 'Stale';
}

async function locationGroups(userId) {
  const memberships = await GroupMember.find({ user: userId, status: 'active' }).select('group location').lean();
  const groups = await Group.find({
    _id: { $in: memberships.map((m) => m.group) },
    status: 'active',
    'settings.location.requirement': { $ne: 'off' },
  })
    .select('name avatarUrl settings.location')
    .lean();
  const mm = new Map(memberships.map((m) => [String(m.group), m]));
  return groups.map((g) => ({ group: g, member: mm.get(String(g._id)) }));
}

export async function getMyLocation(userId) {
  const [user, last, groups] = await Promise.all([
    User.findById(userId).select('locationSettings').lean(),
    LocationHistory.findOne({ user: userId }).sort({ _id: -1 }).lean(),
    locationGroups(userId),
  ]);
  const settings = user?.locationSettings ?? { mode: 'join', intervalMin: 10 };
  return {
    settings: { mode: settings.mode, intervalMin: settings.intervalMin, liveUntil: settings.liveUntil ?? null, liveActive: liveActive(settings) },
    last: last && { lat: last.lat, lng: last.lng, place: last.place, accuracy: last.accuracy, source: last.source, at: last.createdAt },
    groups: groups.map(({ group, member }) => ({
      groupId: String(group._id),
      name: group.name,
      avatarUrl: group.avatarUrl,
      requirement: group.settings.location.requirement,
      visibility: group.settings.location.visibility,
      shareMode: group.settings.location.shareMode,
      sharing: member?.location?.mode ?? 'none',
      status: statusOf(member?.location, group.settings.location.liveIntervalMin),
    })),
  };
}

export async function updateLocationSettings(userId, { mode, intervalMin, liveForMinutes }) {
  const liveUntil = mode === 'live' && liveForMinutes ? new Date(Date.now() + liveForMinutes * 60_000) : null;
  await User.updateOne({ _id: userId }, { $set: { locationSettings: { mode, intervalMin, liveUntil } } });
  if (mode === 'none') {
    // Stop sharing everywhere; members of mandatory groups show as "Off" to admins.
    await GroupMember.updateMany({ user: userId, status: 'active', location: { $ne: null } }, { $set: { 'location.mode': 'none' } });
    await broadcastOff(userId);
  }
  return getMyLocation(userId);
}

async function broadcastOff(userId) {
  for (const { group } of await locationGroups(userId)) {
    await emitLocation(group, { userId: String(userId), status: 'Off' });
  }
}

async function emitLocation(group, payload) {
  const vis = group.settings.location.visibility;
  const event = { groupId: String(group._id), ...payload };
  if (vis === 'groupMembers') emitToGroup(String(group._id), 'group:location', event);
  else if (vis === 'adminOnly') emitToUsers(await adminIds(group._id), 'group:location', event);
}

/** Live / manual update: stored in history and pushed to every group that uses location. */
export async function updateMyLocation(userId, { lat, lng, place, accuracy, source }) {
  const user = await User.findById(userId).select('locationSettings displayName name').lean();
  const settings = user?.locationSettings ?? { mode: 'join' };
  if (settings.mode === 'none') throw ApiError.forbidden('Location sharing is off in your settings', 'LOCATION_OFF');
  const live = liveActive(settings);
  await LocationHistory.create({ user: userId, lat, lng, place, accuracy, source: live && source === 'live' ? 'live' : 'manual' });

  const now = new Date();
  const mode = live ? 'live' : 'join';
  const targets = await locationGroups(userId);
  for (const { group } of targets) {
    await GroupMember.updateOne(
      { group: group._id, user: userId },
      { $set: { location: { lat, lng, place, accuracy, mode, updatedAt: now } } },
    );
    await emitLocation(group, {
      userId: String(userId),
      lat,
      lng,
      place: place ?? null,
      updatedAt: now,
      status: statusOf({ lat, mode, updatedAt: now }, group.settings.location.liveIntervalMin),
    });
  }
  return { updatedGroups: targets.length, mode };
}

export async function locationHistory(userId, range) {
  const since = new Date(Date.now() - RANGE_MS[range]);
  const rows = await LocationHistory.find({ user: userId, createdAt: { $gte: since } }).sort({ _id: -1 }).limit(500).lean();
  const groups = await Group.find({ _id: { $in: rows.map((r) => r.group).filter(Boolean) } }).select('name').lean();
  const gmap = new Map(groups.map((g) => [String(g._id), g.name]));
  return {
    items: rows.map((r) => ({
      lat: r.lat,
      lng: r.lng,
      place: r.place,
      accuracy: r.accuracy,
      source: r.source,
      groupName: r.group ? gmap.get(String(r.group)) ?? null : null,
      at: r.createdAt,
    })),
    stats: { updates: rows.length, live: rows.filter((r) => r.source === 'live').length, joins: rows.filter((r) => r.source === 'join').length },
  };
}

export async function clearLocationHistory(userId) {
  const r = await LocationHistory.deleteMany({ user: userId });
  return { deleted: r.deletedCount };
}

/** Members location of one group - respects the group's visibility setting. */
export async function groupLocations(userId, groupId) {
  const { group, member } = await requireGroupAccess(groupId, userId, { allowSuspended: true });
  const loc = group.settings.location;
  if (loc.requirement === 'off') throw ApiError.forbidden('Location is disabled in this group', 'LOCATION_DISABLED');
  const allowed = loc.visibility === 'groupMembers' || (loc.visibility === 'adminOnly' && isAdmin(member));
  if (!allowed) {
    return { allowed: false, visibility: loc.visibility, groupName: group.name, members: [] };
  }
  const rows = await GroupMember.find({ group: groupId, status: 'active' }).select('user role location').limit(2000).lean();
  const users = await getPublicUsers(rows.map((r) => r.user));
  const members = rows.map((r) => ({
    userId: String(r.user),
    displayName: users.get(String(r.user))?.displayName ?? 'Member',
    avatarUrl: users.get(String(r.user))?.avatarUrl ?? null,
    role: r.role,
    isMe: String(r.user) === String(userId),
    status: statusOf(r.location, loc.liveIntervalMin),
    lat: r.location?.mode === 'none' ? null : (r.location?.lat ?? null),
    lng: r.location?.mode === 'none' ? null : (r.location?.lng ?? null),
    place: r.location?.place ?? null,
    updatedAt: r.location?.updatedAt ?? null,
  }));
  return {
    allowed: true,
    visibility: loc.visibility,
    requirement: loc.requirement,
    groupName: group.name,
    counts: {
      live: members.filter((m) => m.status === 'Live').length,
      stale: members.filter((m) => m.status === 'Stale').length,
      off: members.filter((m) => m.status === 'Off').length,
    },
    members,
  };
}
