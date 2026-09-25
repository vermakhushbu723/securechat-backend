import { Router } from 'express';
import { z } from 'zod';

import { requireAuth } from '../../middlewares/auth.js';
import { limiters, rateLimit } from '../../middlewares/rateLimit.js';
import { validate } from '../../middlewares/validate.js';
import { verifyAccessToken } from '../../utils/jwt.js';
import { objectId } from '../../utils/validators.js';
import { logFileAction, openDecryptedStream, verifyFileToken } from '../files/file.service.js';
import { SecureFile } from '../files/secureFile.model.js';
import * as location from '../location/location.service.js';
import * as reports from '../reports/report.service.js';
import * as groups from './group.service.js';
import * as s from './group.schema.js';
import * as msgs from './groupMessage.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });
const idParam = z.object({ id: objectId });
const memberParam = z.object({ id: objectId, userId: objectId });
const codeParam = z.object({ code: z.string().trim().min(4).max(20) });

/** Sets req.user when a valid bearer token is present, never rejects. */
function optionalAuth(req, _res, next) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      req.user = { id: verifyAccessToken(token).sub };
    } catch {
      // anonymous preview
    }
  }
  next();
}

// ---------------------------------------------------------------------------
// /groups
// ---------------------------------------------------------------------------
export const groupRouter = Router();

groupRouter.post('/', validate({ body: s.createGroupInput }), async (req, res) => {
  ok(res, await groups.createGroup(req.user.id, req.valid.body), 201);
});
groupRouter.get('/', validate({ query: s.listGroupsQuery }), async (req, res) => {
  ok(res, await groups.listGroups(req.user.id, req.valid.query));
});
groupRouter.get('/stats', async (req, res) => ok(res, await groups.groupStats(req.user.id)));
groupRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  ok(res, await groups.getGroupDetail(req.user.id, req.valid.params.id));
});
groupRouter.patch('/:id', validate({ params: idParam, body: s.updateInfoInput }), async (req, res) => {
  ok(res, await groups.updateGroupInfo(req.user.id, req.valid.params.id, req.valid.body));
});
groupRouter.patch('/:id/settings', validate({ params: idParam, body: s.settingsInput }), async (req, res) => {
  ok(res, await groups.updateGroupSettings(req.user.id, req.valid.params.id, req.valid.body));
});
groupRouter.delete('/:id', validate({ params: idParam }), async (req, res) => {
  ok(res, await groups.deleteGroup(req.user.id, req.valid.params.id));
});
groupRouter.post('/:id/leave', validate({ params: idParam }), async (req, res) => {
  ok(res, await groups.leaveGroup(req.user.id, req.valid.params.id));
});
groupRouter.patch('/:id/me', validate({ params: idParam, body: s.myStateInput }), async (req, res) => {
  ok(res, await groups.updateMyState(req.user.id, req.valid.params.id, req.valid.body));
});
groupRouter.post('/:id/clear', validate({ params: idParam }), async (req, res) => {
  ok(res, await groups.clearGroupChat(req.user.id, req.valid.params.id));
});

// Members
groupRouter.get('/:id/members', validate({ params: idParam, query: z.object({ q: z.string().max(50).optional() }) }), async (req, res) => {
  ok(res, await groups.listMembers(req.user.id, req.valid.params.id, req.valid.query));
});
groupRouter.get('/:id/members/:userId', validate({ params: memberParam }), async (req, res) => {
  ok(res, await groups.memberProfile(req.user.id, req.valid.params.id, req.valid.params.userId));
});
groupRouter.patch('/:id/members/:userId', validate({ params: memberParam, body: s.memberUpdateInput }), async (req, res) => {
  ok(res, await groups.updateMember(req.user.id, req.valid.params.id, req.valid.params.userId, req.valid.body));
});
groupRouter.delete('/:id/members/:userId', validate({ params: memberParam }), async (req, res) => {
  ok(res, await groups.removeMember(req.user.id, req.valid.params.id, req.valid.params.userId));
});

// Join requests
groupRouter.get('/:id/requests', validate({ params: idParam }), async (req, res) => {
  ok(res, await groups.listJoinRequests(req.user.id, req.valid.params.id));
});
groupRouter.post('/:id/requests/:userId/:decision', validate({
  params: z.object({ id: objectId, userId: objectId, decision: z.enum(['approve', 'decline']) }),
}), async (req, res) => {
  const { id, userId, decision } = req.valid.params;
  ok(res, await groups.decideJoinRequest(req.user.id, id, userId, decision === 'approve'));
});

// Invite links
groupRouter.get('/:id/invites', validate({ params: idParam }), async (req, res) => {
  ok(res, await groups.listInvites(req.user.id, req.valid.params.id));
});
groupRouter.post('/:id/invites', validate({ params: idParam, body: s.inviteOptions }), async (req, res) => {
  ok(res, await groups.newInvite(req.user.id, req.valid.params.id, req.valid.body), 201);
});
groupRouter.post('/:id/invites/reset', validate({ params: idParam, body: s.inviteOptions }), async (req, res) => {
  ok(res, await groups.resetInvites(req.user.id, req.valid.params.id, req.valid.body), 201);
});
groupRouter.delete('/:id/invites/:code', validate({ params: z.object({ id: objectId, code: z.string().max(20) }) }), async (req, res) => {
  ok(res, await groups.revokeInvite(req.user.id, req.valid.params.id, req.valid.params.code));
});

// Messages
groupRouter.get('/:id/messages', validate({ params: idParam, query: s.messagesQuery }), async (req, res) => {
  ok(res, await msgs.listMessages(req.user.id, req.valid.params.id, req.valid.query));
});
groupRouter.post('/:id/messages', rateLimit(limiters.message), validate({ params: idParam }), async (req, res) => {
  const input = s.sendGroupMessageInput.parse({ ...req.body, groupId: req.valid.params.id });
  const { message, duplicate } = await msgs.sendGroupMessage(req.user.id, input);
  ok(res, message, duplicate ? 200 : 201);
});
groupRouter.post('/:id/read', validate({ params: idParam, body: z.strictObject({ upToMessageId: objectId }) }), async (req, res) => {
  ok(res, await msgs.markGroupRead(req.user.id, { groupId: req.valid.params.id, upToMessageId: req.valid.body.upToMessageId }));
});
groupRouter.get('/:id/search', validate({ params: idParam, query: s.searchQuery }), async (req, res) => {
  ok(res, await msgs.searchMessages(req.user.id, req.valid.params.id, req.valid.query));
});
groupRouter.get('/:id/media', validate({ params: idParam, query: s.mediaQuery }), async (req, res) => {
  ok(res, await msgs.listMedia(req.user.id, req.valid.params.id, req.valid.query));
});
groupRouter.get('/:id/locations', validate({ params: idParam }), async (req, res) => {
  ok(res, await location.groupLocations(req.user.id, req.valid.params.id));
});

// ---------------------------------------------------------------------------
// /invites (preview works without login - the join page shows it first)
// ---------------------------------------------------------------------------
export const inviteRouter = Router();

inviteRouter.get('/:code', optionalAuth, validate({ params: codeParam }), async (req, res) => {
  ok(res, await groups.invitePreview(req.valid.params.code, req.user?.id));
});
inviteRouter.post('/:code/join', requireAuth, rateLimit(limiters.action), validate({ params: codeParam, body: s.joinInput }), async (req, res) => {
  ok(res, await groups.joinByInvite(req.user.id, req.valid.params.code, req.valid.body));
});

// ---------------------------------------------------------------------------
// /group-messages/:id (message level screens: options, info, chain, deletion)
// ---------------------------------------------------------------------------
export const groupMessageRouter = Router();

groupMessageRouter.get('/starred', async (req, res) => ok(res, await msgs.listStarred(req.user.id)));
groupMessageRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.getMessage(req.user.id, req.valid.params.id));
});
groupMessageRouter.get('/:id/info', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.messageInfo(req.user.id, req.valid.params.id));
});
groupMessageRouter.get('/:id/chain', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.forwardChain(req.user.id, req.valid.params.id));
});
groupMessageRouter.get('/:id/forward-details', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.forwardDetails(req.user.id, req.valid.params.id));
});
groupMessageRouter.get('/:id/delete-preview', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.deletePreview(req.user.id, req.valid.params.id));
});
groupMessageRouter.get('/:id/deletion', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.deletionStatus(req.user.id, req.valid.params.id));
});
groupMessageRouter.post('/:id/open', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.openViewOnce(req.user.id, req.valid.params.id));
});
groupMessageRouter.patch('/:id', validate({ params: idParam, body: z.strictObject({ text: z.string().trim().min(1).max(4096) }) }), async (req, res) => {
  ok(res, await msgs.editGroupMessage(req.user.id, { messageId: req.valid.params.id, text: req.valid.body.text }));
});
groupMessageRouter.delete('/:id', validate({
  params: idParam,
  query: z.object({ scope: z.enum(['me', 'everyone']).default('me'), chain: z.enum(['true', 'false']).default('true') }),
}), async (req, res) => {
  const { scope, chain } = req.valid.query;
  ok(res, await msgs.deleteGroupMessage(req.user.id, { messageId: req.valid.params.id, scope, chain: chain === 'true' }));
});
groupMessageRouter.post('/:id/reactions', validate({ params: idParam, body: z.strictObject({ emoji: z.string().min(1).max(16).nullable() }) }), async (req, res) => {
  ok(res, await msgs.reactGroupMessage(req.user.id, { messageId: req.valid.params.id, emoji: req.valid.body.emoji }));
});
groupMessageRouter.post('/:id/star', validate({ params: idParam, body: z.strictObject({ starred: z.boolean() }) }), async (req, res) => {
  ok(res, await msgs.starGroupMessage(req.user.id, { messageId: req.valid.params.id, starred: req.valid.body.starred }));
});
groupMessageRouter.post('/forward', rateLimit(limiters.message), validate({ body: s.forwardInput }), async (req, res) => {
  ok(res, await msgs.forwardGroupMessages(req.user.id, req.valid.body), 201);
});

// ---------------------------------------------------------------------------
// /files - protected files (secure viewer)
// ---------------------------------------------------------------------------
export const fileRouter = Router();

fileRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.fileInfo(req.user.id, req.valid.params.id));
});
fileRouter.post('/:id/token', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.issueFileToken(req.user.id, req.valid.params.id, req.ip));
});
fileRouter.get('/:id/access-log', validate({ params: idParam }), async (req, res) => {
  ok(res, await msgs.fileAccessLog(req.user.id, req.valid.params.id));
});
fileRouter.patch('/:id/permissions', validate({ params: idParam, body: s.filePermissionsInput }), async (req, res) => {
  ok(res, await msgs.updateFilePermissions(req.user.id, req.valid.params.id, req.valid.body));
});
fileRouter.post('/:id/events', validate({ params: idParam, body: s.fileEventInput }), async (req, res) => {
  ok(res, await msgs.logFileEvent(req.user.id, req.valid.params.id, req.valid.body.action, req.ip));
});

/**
 * Streams a decrypted protected file. Auth is the short-lived viewer token
 * (media elements cannot send headers). Never cached, never "attachment".
 */
export async function streamSecureFile(req, res) {
  const token = String(req.query.token ?? '');
  const { userId, fileId } = verifyFileToken(token);
  const file = await SecureFile.findById(fileId).lean();
  if (!file || file.revokedAt) return res.status(410).json({ ok: false, error: { code: 'FILE_REVOKED', message: 'This file is no longer available' } });
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Length', file.size);
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''protected`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  logFileAction(file._id, userId, 'viewed', req.ip).catch(() => {});
  const stream = openDecryptedStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// /location & /reports
// ---------------------------------------------------------------------------
export const locationRouter = Router();

locationRouter.get('/me', async (req, res) => ok(res, await location.getMyLocation(req.user.id)));
locationRouter.put('/settings', validate({ body: s.locationSettingsInput }), async (req, res) => {
  ok(res, await location.updateLocationSettings(req.user.id, req.valid.body));
});
locationRouter.post('/update', rateLimit(limiters.action), validate({ body: s.locationUpdateInput }), async (req, res) => {
  ok(res, await location.updateMyLocation(req.user.id, req.valid.body));
});
locationRouter.get('/history', validate({ query: s.historyQuery }), async (req, res) => {
  ok(res, await location.locationHistory(req.user.id, req.valid.query.range));
});
locationRouter.delete('/history', async (req, res) => ok(res, await location.clearLocationHistory(req.user.id)));

export const reportRouter = Router();

reportRouter.post('/', rateLimit(limiters.action), validate({ body: s.reportInput }), async (req, res) => {
  ok(res, await reports.createReport(req.user.id, req.valid.body), 201);
});
reportRouter.get('/mine', async (req, res) => ok(res, await reports.myReports(req.user.id)));
