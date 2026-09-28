import mongoose from 'mongoose';

const { Schema } = mongoose;

/** "Request extension / premium" from the app, decided by the platform admin. */
const extensionRequestSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['extension', 'premium'], default: 'extension' },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    days: { type: Number, default: 7 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const ExtensionRequest = mongoose.model('ExtensionRequest', extensionRequestSchema);
