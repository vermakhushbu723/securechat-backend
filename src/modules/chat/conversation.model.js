import mongoose from 'mongoose';

const { Schema } = mongoose;

const lastMessageSchema = new Schema(
  {
    id: { type: Schema.Types.ObjectId },
    sender: { type: Schema.Types.ObjectId },
    type: { type: String },
    text: { type: String },
    deleted: { type: Boolean, default: false },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
    createdAt: { type: Date },
  },
  { _id: false },
);

/**
 * One document per pair of users. `pairKey` = sorted "idA:idB" and is unique,
 * so concurrent "start chat" requests always resolve to the same conversation.
 * Shard key suggestion: { _id: 'hashed' }.
 */
const conversationSchema = new Schema(
  {
    type: { type: String, enum: ['direct'], default: 'direct' },
    pairKey: { type: String, required: true, unique: true },
    participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    lastMessage: { type: lastMessageSchema, default: null },
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1 });

export const Conversation = mongoose.model('Conversation', conversationSchema);

export const pairKeyOf = (a, b) => [String(a), String(b)].sort().join(':');
