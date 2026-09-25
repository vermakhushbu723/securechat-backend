import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Message / member / group reports for moderators ("My Reports" for the reporter). */
const reportSchema = new Schema(
  {
    reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['message', 'user', 'group'], required: true },
    group: { type: Schema.Types.ObjectId, ref: 'Group', default: null },
    message: { type: Schema.Types.ObjectId, ref: 'GroupMessage', default: null },
    targetUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reasons: { type: [String], default: [] },
    details: { type: String, maxlength: 1000, default: '' },
    alsoBlocked: { type: Boolean, default: false },
    // Evidence snapshot so moderators still see it after deletion.
    snapshot: {
      type: new Schema(
        { text: String, type: String, visibility: String, senderName: String, groupName: String, forwardRootId: Schema.Types.ObjectId },
        { _id: false },
      ),
      default: undefined,
    },
    status: { type: String, enum: ['open', 'reviewing', 'resolved', 'rejected'], default: 'open' },
    resolution: { type: String, default: '' },
  },
  { timestamps: true },
);

reportSchema.index({ reporter: 1, _id: -1 });
reportSchema.index({ status: 1, _id: -1 });

export const Report = mongoose.model('Report', reportSchema);
