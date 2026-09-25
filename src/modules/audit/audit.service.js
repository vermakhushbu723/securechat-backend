import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';

const { Schema } = mongoose;

/** Security audit log: deletions, removals, role / settings changes, content blocks. */
const auditSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    group: { type: Schema.Types.ObjectId, ref: 'Group', default: null },
    target: { type: Schema.Types.ObjectId, default: null },
    meta: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditSchema.index({ group: 1, _id: -1 });
auditSchema.index({ actor: 1, _id: -1 });
auditSchema.index({ action: 1, _id: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);

/** Fire-and-forget: auditing must never break the user action. */
export function audit(actor, action, { group, target, meta } = {}) {
  AuditLog.create({ actor, action, group, target, meta }).catch((err) =>
    logger.warn({ err: err.message, action }, 'Audit write failed'),
  );
}
