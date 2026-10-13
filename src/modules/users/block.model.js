import mongoose from 'mongoose';
import { sqlModel } from '../../db/sql/model.js';

const { Schema } = mongoose;

/** Separate collection instead of an array on User: unbounded and index friendly. */
const blockSchema = new Schema(
  {
    blocker: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blocked: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

blockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
blockSchema.index({ blocked: 1 });

export const Block = sqlModel('Block', blockSchema);
