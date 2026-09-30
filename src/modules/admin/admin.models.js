import mongoose from 'mongoose';

const { Schema } = mongoose;

// ---------------------------------------------------------------------------
// Admin / staff accounts (separate from app users)
// ---------------------------------------------------------------------------
export const STAFF_ROLES = ['super_admin', 'moderator', 'support'];
export const PERMISSIONS = ['users', 'groups', 'messages', 'subscriptions', 'reports', 'settings'];

const staffSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: STAFF_ROLES, default: 'moderator' },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    twoFactor: { type: Boolean, default: true }, // code by email after the password
    tokenVersion: { type: Number, default: 0 }, // +1 logs out every session
    lastActiveAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

export const Staff = mongoose.model('Staff', staffSchema);

export const staffDTO = (s) => ({
  id: String(s._id),
  name: s.name,
  email: s.email,
  role: s.role,
  status: s.status,
  twoFactor: s.twoFactor,
  lastActiveAt: s.lastActiveAt,
  createdAt: s.createdAt,
});

// ---------------------------------------------------------------------------
// Admin audit log: every admin / staff action (Audit Logs screen)
// ---------------------------------------------------------------------------
const adminLogSchema = new Schema(
  {
    staff: { type: Schema.Types.ObjectId, ref: 'Staff', default: null }, // null = API key / system
    staffName: { type: String, required: true },
    action: { type: String, required: true },
    category: { type: String, enum: ['auth', 'users', 'groups', 'messages', 'subscriptions', 'reports', 'settings', 'staff'], required: true },
    target: { type: String, default: null }, // label shown in the log ("Rahul Sharma", "Group Alpha")
    targetId: { type: String, default: null },
    ip: { type: String, default: null },
    meta: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

adminLogSchema.index({ category: 1, _id: -1 });
adminLogSchema.index({ targetId: 1, _id: -1 });

export const AdminLog = mongoose.model('AdminLog', adminLogSchema);

// ---------------------------------------------------------------------------
// Premium plans + coupons
// ---------------------------------------------------------------------------
const planSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    period: { type: String, enum: ['month', 'year', 'week', 'custom'], default: 'month' },
    durationDays: { type: Number, required: true, min: 1, max: 3650 },
    features: { type: [String], default: [] },
    visible: { type: Boolean, default: true },
    popular: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Plan = mongoose.model('Plan', planSchema);

const couponSchema = new Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    description: { type: String, trim: true, maxlength: 120, default: '' },
    percentOff: { type: Number, required: true, min: 1, max: 100 },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan', default: null }, // null = every plan
    expiresAt: { type: Date, default: null },
    maxUses: { type: Number, default: 0 }, // 0 = unlimited
    uses: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Coupon = mongoose.model('Coupon', couponSchema);

// ---------------------------------------------------------------------------
// Broadcast notifications
// ---------------------------------------------------------------------------
export const AUDIENCES = ['all', 'trial', 'premium', 'expired', 'group_admins'];
export const CHANNELS = ['push', 'in_app', 'email', 'sms'];

const notificationSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    body: { type: String, required: true, trim: true, maxlength: 500 },
    audience: { type: String, enum: AUDIENCES, default: 'all' },
    channels: { type: [{ type: String, enum: CHANNELS }], default: ['push', 'in_app'] },
    status: { type: String, enum: ['scheduled', 'sending', 'sent', 'cancelled', 'failed'], default: 'scheduled' },
    scheduledAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    recipients: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 }, // users reached on at least one channel
    emailed: { type: Number, default: 0 },
    skipped: { type: [String], default: [] }, // channels without a provider (e.g. SMS)
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ status: 1, scheduledAt: 1 });

export const Notification = mongoose.model('Notification', notificationSchema);
