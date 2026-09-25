import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Per-user state of a conversation (unread, pin, mute, archive, clear, delete).
 * The chat list of a user is a single indexed query on this collection.
 * Shard key suggestion: { user: 1 }.
 */
const memberSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    peer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    unreadCount: { type: Number, default: 0, min: 0 },
    lastReadMessageId: { type: Schema.Types.ObjectId, default: null },
    lastMessageAt: { type: Date, default: null },
    pinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
    archived: { type: Boolean, default: false },
    mutedUntil: { type: Date, default: null },
    // Messages created before this date are hidden for this user ("Clear chat").
    clearedAt: { type: Date, default: null },
    // "Delete chat": hidden from the list until a new message arrives.
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true },
);

memberSchema.index({ conversation: 1, user: 1 }, { unique: true });
memberSchema.index({ user: 1, hidden: 1, archived: 1, pinned: -1, lastMessageAt: -1, _id: -1 });
memberSchema.index({ user: 1, peer: 1 });

export const ConversationMember = mongoose.model('ConversationMember', memberSchema);
