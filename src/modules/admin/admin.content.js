import mongoose from 'mongoose';

import { ApiError } from '../../utils/ApiError.js';
import { checkContent, tokens } from '../../utils/contentFilter.js';
import { toObjectId } from '../../utils/validators.js';
import { AuditLog } from '../audit/audit.service.js';
import { invalidateGroup } from '../groups/group.access.js';
import { Group, GroupMember } from '../groups/group.model.js';
import { GroupMessage, groupPreviewText } from '../groups/groupMessage.model.js';
import { buildChain } from '../groups/groupMessage.service.js';
import { CONTENT_RULES, getSetting, updateSetting } from '../platform/platform.service.js';
import { Report } from '../reports/report.model.js';
import { invalidateAccess } from '../subscription/subscription.service.js';
import { User } from '../users/user.model.js';
import { DAY, internalId, like, paged, pageResult } from './admin.common.js';

const { ObjectId } = mongoose.Types;
const idSince = (ms) => ObjectId.createFromTime(Math.floor((Date.now() - ms) / 1000));
export const shortMsgId = (id) => `MSG-${String(id).slice(-6).toUpperCase()}`;

async function names(userIds, groupIds) {
  const [users, groups] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('name').lean(),
    Group.find({ _id: { $in: groupIds } }).select('name').lean(),
  ]);
  return {
    user: (id) => users.find((u) => String(u._id) === String(id))?.name ?? 'Deleted user',
    group: (id) => groups.find((g) => String(g._id) === String(id))?.name ?? 'Deleted group',
  };
}

// ---------------------------------------------------------------------------
// Message monitoring (metadata; private content never shown)
// ---------------------------------------------------------------------------
export async function monitorMessages(query) {
  const p = paged(query);
  const f = (query.filter ?? 'all').toLowerCase();
  const and = [{ type: { $ne: 'system' } }];
  if (f === 'flagged') {
    const ids = await Report.distinct('message', { type: 'message', message: { $ne: null } });
    and.push({ _id: { $in: ids } });
  }
  if (f === 'forwarded') and.push({ 'forward.rootId': { $exists: true } });
  if (f === 'files') and.push({ type: { $in: ['image', 'video', 'audio', 'voice', 'file'] } });
  if (f === 'private') and.push({ visibility: { $ne: 'public' } });
  if (query.groupId) and.push({ group: toObjectId(query.groupId) });
  if (query.q?.trim()) {
    const [users, groups] = await Promise.all([
      User.find({ name: like(query.q) }).select('_id').limit(200).lean(),
      Group.find({ name: like(query.q) }).select('_id').limit(200).lean(),
    ]);
    and.push({
      $or: [{ sender: { $in: users.map((u) => u._id) } }, { group: { $in: groups.map((g) => g._id) } }, { visibility: 'public', text: like(query.q) }],
    });
  }
  const filter = { $and: and };
  const day = idSince(DAY);
  const [rows, total, count24, private24, forwards24, blocked24] = await Promise.all([
    GroupMessage.find(filter).select('group sender type text visibility forward status media.name permissions.viewOnce createdAt').sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    GroupMessage.countDocuments(filter),
    GroupMessage.countDocuments({ _id: { $gte: day }, type: { $ne: 'system' } }),
    GroupMessage.countDocuments({ _id: { $gte: day }, type: { $ne: 'system' }, visibility: { $ne: 'public' } }),
    GroupMessage.countDocuments({ _id: { $gte: day }, 'forward.rootId': { $exists: true } }),
    AuditLog.countDocuments({ action: 'content_blocked', _id: { $gte: day } }),
  ]);
  const reported = new Set((await Report.distinct('message', { message: { $in: rows.map((r) => r._id) } })).map(String));
  const n = await names(rows.map((r) => r.sender), rows.map((r) => r.group));
  const items = rows.map((m) => ({
    id: String(m._id),
    shortId: shortMsgId(m._id),
    at: m.createdAt,
    sender: n.user(m.sender),
    senderId: String(m.sender),
    group: n.group(m.group),
    groupId: String(m.group),
    type: m.type,
    visibility: m.visibility,
    // Moderators see public text only; private / highly protected stay encrypted.
    content: m.visibility === 'public' && !m.permissions?.viewOnce ? groupPreviewText(m) : null,
    forwarded: Boolean(m.forward?.rootId),
    rootId: String(m.forward?.rootId ?? m._id),
    flagged: reported.has(String(m._id)),
    deleted: m.status !== 'active',
  }));
  return {
    ...pageResult(items, total, p),
    stats: { messages24h: count24, privateShare: count24 ? Math.round((private24 / count24) * 100) : 0, forwards24h: forwards24, autoBlocked24h: blocked24 },
  };
}

// ---------------------------------------------------------------------------
// Forward chains
// ---------------------------------------------------------------------------
export async function listChains(query) {
  const p = paged(query);
  const f = (query.filter ?? 'all').toLowerCase();
  const and = [{ forwardCount: { $gt: 0 }, 'forward.rootId': { $exists: false } }];
  if (f === 'flagged') and.push({ _id: { $in: await Report.distinct('snapshot.forwardRootId', { 'snapshot.forwardRootId': { $ne: null } }) } });
  if (f === 'active') and.push({ status: 'active' });
  if (f === 'deleted') and.push({ status: 'deleted_for_everyone' });
  if (f === 'frozen') and.push({ forwardFrozen: true });
  const q = query.q?.trim();
  if (q) {
    if (/^[a-f0-9]{24}$/i.test(q)) {
      const m = await GroupMessage.findById(q).select('forward').lean();
      and.push({ _id: m?.forward?.rootId ?? toObjectId(q) });
    } else {
      const tail = q.toUpperCase().replace(/^MSG-/, '');
      if (/^[A-F0-9]{4,24}$/.test(tail)) and.push({ $expr: { $eq: [{ $toUpper: { $substrCP: [{ $toString: '$_id' }, 24 - tail.length, tail.length] } }, tail] } });
      else and.push({ text: like(q), visibility: 'public' });
    }
  }
  const filter = { $and: and };
  const [rows, total] = await Promise.all([
    GroupMessage.find(filter).select('group sender type text visibility status forwardCount forwardFrozen createdAt').sort({ forwardCount: -1, _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    GroupMessage.countDocuments(filter),
  ]);
  const reports = await Report.aggregate([{ $match: { 'snapshot.forwardRootId': { $in: rows.map((r) => r._id) } } }, { $group: { _id: '$snapshot.forwardRootId', n: { $sum: 1 } } }]);
  const rmap = new Map(reports.map((r) => [String(r._id), r.n]));
  const n = await names(rows.map((r) => r.sender), rows.map((r) => r.group));
  return pageResult(
    rows.map((m) => ({
      id: String(m._id),
      shortId: shortMsgId(m._id),
      sender: n.user(m.sender),
      group: n.group(m.group),
      preview: m.visibility === 'public' ? groupPreviewText(m) : 'Encrypted content',
      copies: m.forwardCount,
      status: m.status,
      frozen: Boolean(m.forwardFrozen),
      reports: rmap.get(String(m._id)) ?? 0,
      at: m.createdAt,
    })),
    total,
    p,
  );
}

function flatten(node, rootId, out = []) {
  out.push({
    messageId: node.messageId,
    shortId: shortMsgId(node.messageId),
    rootId: String(rootId),
    parentId: node.parentId,
    from: node.from,
    to: node.to,
    groupId: node.groupId,
    recipients: node.recipients,
    depth: node.depth,
    at: node.time,
    status: node.deleted ? 'DELETED_FOR_EVERYONE' : 'ACTIVE',
  });
  for (const c of node.children) flatten(c, rootId, out);
  return out;
}

export async function chainDetail(messageId) {
  const m = await GroupMessage.findById(messageId).select('forward forwardFrozen').lean();
  if (!m) throw ApiError.notFound('Message not found');
  const rootId = m.forward?.rootId ?? m._id;
  const [{ tree, totals }, root, reports] = await Promise.all([
    buildChain(rootId),
    GroupMessage.findById(rootId).select('forwardFrozen status visibility text type media.name').lean(),
    Report.countDocuments({ 'snapshot.forwardRootId': rootId }),
  ]);
  const shortTree = (n) => ({ ...n, messageId: shortMsgId(n.messageId), fullId: n.messageId, parentId: n.parentId ? shortMsgId(n.parentId) : null, children: n.children.map(shortTree) });
  return {
    rootId: String(rootId),
    shortRootId: shortMsgId(rootId),
    preview: root?.visibility === 'public' ? groupPreviewText(root) : 'Encrypted content',
    frozen: Boolean(root?.forwardFrozen),
    reports,
    totals,
    tree: shortTree(tree),
    nodes: flatten(tree, rootId),
  };
}

// ---------------------------------------------------------------------------
// Content moderation: blocked message log
// ---------------------------------------------------------------------------
export async function blockedLog(query) {
  const p = paged(query);
  const rule = query.rule && query.rule !== 'all' ? query.rule : null;
  const filter = { action: 'content_blocked', ...(rule ? { 'meta.rule': rule } : {}) };
  if (query.q?.trim()) {
    const [users, groups] = await Promise.all([
      User.find({ name: like(query.q) }).select('_id').limit(200).lean(),
      Group.find({ name: like(query.q) }).select('_id').limit(200).lean(),
    ]);
    filter.$or = [{ actor: { $in: users.map((u) => u._id) } }, { group: { $in: groups.map((g) => g._id) } }];
  }
  const today = idSince(DAY);
  const [rows, total, blockedToday, byRule, repeatOffenders, cs] = await Promise.all([
    AuditLog.find(filter).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    AuditLog.countDocuments(filter),
    AuditLog.countDocuments({ action: 'content_blocked', _id: { $gte: today } }),
    AuditLog.aggregate([{ $match: { action: 'content_blocked', _id: { $gte: today } } }, { $group: { _id: '$meta.rule', n: { $sum: 1 } } }]),
    User.countDocuments({ warnings: { $gte: 3 }, status: { $ne: 'deleted' } }),
    getSetting('content'),
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r.actor) } }).select('name warnings').lean();
  const umap = new Map(users.map((u) => [String(u._id), u]));
  const n = await names([], rows.map((r) => r.group).filter(Boolean));
  const ruleCount = (r) => byRule.filter((x) => r.includes(x._id)).reduce((s, x) => s + x.n, 0);
  return {
    ...pageResult(
      rows.map((r) => ({
        id: String(r._id),
        at: r.createdAt,
        userId: String(r.actor),
        user: umap.get(String(r.actor))?.name ?? 'Deleted user',
        groupId: r.group ? String(r.group) : null,
        group: r.group ? n.group(r.group) : 'Direct chat',
        text: r.meta?.text ?? '',
        rule: r.meta?.rule ?? 'unknown',
        warnings: umap.get(String(r.actor))?.warnings ?? 0,
      })),
      total,
      p,
    ),
    stats: { blockedToday, numbers: ruleCount(['numbers', 'numberWords']), abuse: ruleCount(['abuse']), usersWith3Warnings: repeatOffenders },
    maxWarnings: cs.maxWarnings,
  };
}

// ---------------------------------------------------------------------------
// Content / number / abuse settings + engine test
// ---------------------------------------------------------------------------
export const getContent = () => getSetting('content');

export async function updateContent(patch) {
  if (patch.globalRules) patch.globalRules = patch.globalRules.filter((r) => CONTENT_RULES.includes(r));
  if (patch.abuseWords) patch.abuseWords = [...new Set(patch.abuseWords.map((w) => w.trim().toUpperCase()).filter(Boolean))].slice(0, 2000);
  return updateSetting('content', patch);
}

/** Admin "Test the engine": runs the live rules on a sample text. */
export async function testContent(text, rules) {
  const cs = await getSetting('content');
  const enabled = rules?.length ? rules : cs.globalRules;
  const rule = checkContent(text, {
    enabled: cs.abuseEnabled === false ? enabled.filter((r) => r !== 'abuse') : enabled,
    abuseWords: cs.abuseWords,
    hinglish: cs.hinglish,
    misspellings: cs.misspellings,
    sensitivity: cs.sensitivity,
    hindiNumbers: cs.hindiNumbers,
    normalization: cs.normalization !== false,
  });
  return { allowed: !rule, rule, tokens: tokens(text, { normalize: cs.normalization !== false }) };
}

// ---------------------------------------------------------------------------
// Security settings: Global | Group | User
// ---------------------------------------------------------------------------
const GROUP_KEYS = {
  publicForwarding: 'publicForwarding',
  privateForwarding: 'privateForwarding',
  chainDeletion: 'chainDeletion',
  downloadDisabled: 'downloadDisabled',
  externalShareDisabled: 'externalShareDisabled',
  copyDisabled: 'copyDisabledProtected',
  secureViewer: 'openInAppOnly',
  screenshotProtection: 'screenshotProtection',
  screenRecordingProtection: 'screenRecordingProtection',
  dynamicWatermark: 'dynamicWatermark',
};

export async function getSecurity(scope, targetId) {
  const global = await getSetting('security');
  if (scope === 'group') {
    const g = await Group.findById(targetId).select('name settings').lean();
    if (!g) throw ApiError.notFound('Group not found');
    const sec = g.settings?.security ?? {};
    const mode = g.settings?.messages?.messageMode ?? 'user_select';
    const values = { ...global };
    for (const [k, gk] of Object.entries(GROUP_KEYS)) if (sec[gk] !== undefined) values[k] = sec[gk];
    values.publicMessages = mode !== 'private';
    values.privateMessages = mode !== 'public';
    return { scope, target: { id: String(g._id), name: g.name }, values };
  }
  if (scope === 'user') {
    const u = await User.findById(targetId).select('name securityOverrides').lean();
    if (!u) throw ApiError.notFound('User not found');
    return { scope, target: { id: String(u._id), name: u.name, internalId: internalId(u._id) }, values: { ...global, ...(u.securityOverrides ?? {}) } };
  }
  return { scope: 'global', target: null, values: global };
}

export async function updateSecurity(scope, targetId, values) {
  if (scope === 'group') {
    const set = {};
    for (const [k, gk] of Object.entries(GROUP_KEYS)) if (values[k] !== undefined) set[`settings.security.${gk}`] = values[k];
    if (values.publicMessages !== undefined || values.privateMessages !== undefined) {
      const cur = await getSecurity('group', targetId);
      const pub = values.publicMessages ?? cur.values.publicMessages;
      const priv = values.privateMessages ?? cur.values.privateMessages;
      if (!pub && !priv) throw ApiError.badRequest('Keep public or private messages on');
      set['settings.messages.messageMode'] = pub && priv ? 'user_select' : pub ? 'public' : 'private';
    }
    const r = await Group.updateOne({ _id: targetId }, { $set: set });
    if (!r.matchedCount) throw ApiError.notFound('Group not found');
    await invalidateGroup(targetId);
    return getSecurity('group', targetId);
  }
  if (scope === 'user') {
    const u = await User.findById(targetId).select('securityOverrides').lean();
    if (!u) throw ApiError.notFound('User not found');
    await User.updateOne({ _id: targetId }, { $set: { securityOverrides: { ...(u.securityOverrides ?? {}), ...values } } });
    await invalidateAccess(targetId); // overrides are read from the cached access on every send
    return getSecurity('user', targetId);
  }
  await updateSetting('security', values);
  return getSecurity('global');
}

// ---------------------------------------------------------------------------
// Location management (all groups)
// ---------------------------------------------------------------------------
const STALE_MS = 30 * 60_000;

export async function locationOverview(query) {
  const p = paged(query);
  const now = Date.now();
  const filter = { status: 'active', 'location.lat': { $ne: null } };
  if (query.groupId) filter.group = toObjectId(query.groupId);
  if (query.status === 'live') Object.assign(filter, { 'location.mode': 'live', 'location.updatedAt': { $gte: new Date(now - STALE_MS) } });
  if (query.status === 'stale') Object.assign(filter, { 'location.mode': 'live', 'location.updatedAt': { $lt: new Date(now - STALE_MS) } });
  if (query.status === 'join') filter['location.mode'] = 'join';
  const [rows, total, live, joinOnly, off, mandatoryGroups, locationGroups, settings] = await Promise.all([
    GroupMember.find(filter).select('group user location').sort({ 'location.updatedAt': -1 }).skip(p.skip).limit(p.limit).lean(),
    GroupMember.countDocuments(filter),
    User.countDocuments({ status: 'active', 'locationSettings.mode': 'live' }),
    User.countDocuments({ status: 'active', 'locationSettings.mode': 'join' }),
    User.countDocuments({ status: 'active', 'locationSettings.mode': 'none' }),
    Group.countDocuments({ status: 'active', 'settings.location.requirement': 'mandatory' }),
    Group.find({ status: { $ne: 'deleted' }, 'settings.location.requirement': { $ne: 'off' } }).select('name settings.location.requirement').sort({ name: 1 }).limit(500).lean(),
    getSetting('location'),
  ]);
  const n = await names(rows.map((r) => r.user), rows.map((r) => r.group));
  return {
    ...pageResult(
      rows.map((r) => {
        const at = r.location?.updatedAt ? new Date(r.location.updatedAt).getTime() : 0;
        return {
          userId: String(r.user),
          user: n.user(r.user),
          groupId: String(r.group),
          group: n.group(r.group),
          lat: r.location.lat,
          lng: r.location.lng,
          place: r.location.place ?? null,
          mode: r.location.mode,
          at: r.location.updatedAt ?? null,
          status: r.location.mode === 'live' ? (now - at <= STALE_MS ? 'Live' : 'Stale') : r.location.mode === 'join' ? 'Join' : 'Off',
        };
      }),
      total,
      p,
    ),
    stats: { live, joinOnly, off, mandatoryGroups },
    groups: locationGroups.map((g) => ({ id: String(g._id), name: g.name, requirement: g.settings.location.requirement })),
    settings,
  };
}

export const updateLocationSettings = (patch) => updateSetting('location', patch);
