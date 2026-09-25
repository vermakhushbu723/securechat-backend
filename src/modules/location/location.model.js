import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Every location a user shared (join / live / manual) - Location History screen. */
const locationHistorySchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    place: { type: String, default: null },
    accuracy: { type: Number, default: null },
    source: { type: String, enum: ['join', 'live', 'manual'], default: 'manual' },
    group: { type: Schema.Types.ObjectId, ref: 'Group', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

locationHistorySchema.index({ user: 1, _id: -1 });
// Keep 90 days of history.
locationHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });

export const LocationHistory = mongoose.model('LocationHistory', locationHistorySchema);
