import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Encrypted file for Private / Highly Protected content. Stored outside the
 * public uploads folder with AES-256-GCM; readable only through a short-lived
 * viewer token after a permission check. There is never a public URL.
 */
const secureFileSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    mimeType: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video', 'audio', 'voice', 'file'], required: true },
    size: { type: Number, required: true },
    width: Number,
    height: Number,
    duration: Number,
    path: { type: String, required: true }, // relative to SECURE_UPLOAD_DIR
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    // Set when attached to a message; one file belongs to one message.
    message: { type: Schema.Types.ObjectId, ref: 'GroupMessage', default: null },
    group: { type: Schema.Types.ObjectId, ref: 'Group', default: null },
    revokedAt: { type: Date, default: null }, // message deleted / expired
  },
  { timestamps: true },
);

secureFileSchema.index({ message: 1 });

export const SecureFile = mongoose.model('SecureFile', secureFileSchema);

export const FILE_ACTIONS = [
  'uploaded',
  'token_issued',
  'viewed',
  'denied',
  'download_blocked',
  'share_blocked',
  'print_blocked',
  'copy_blocked',
  'open_with_blocked',
  'screenshot_attempt',
];

const accessLogSchema = new Schema(
  {
    file: { type: Schema.Types.ObjectId, ref: 'SecureFile', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: FILE_ACTIONS, required: true },
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

accessLogSchema.index({ file: 1, _id: -1 });

export const FileAccessLog = mongoose.model('FileAccessLog', accessLogSchema);
