/**
 * ============================================================================
 * Cockroach — User Model
 * ============================================================================
 * Production-grade User schema with:
 *  - Argon2id password hashing (OWASP-recommended params)
 *  - Multi-layered session objects with device binding
 *  - Device fingerprint tracking
 *  - Embedded rate-limit logs (capped)
 *  - Verified badge system (celebrity / brand / government / creator)
 *
 * Dependencies: mongoose, argon2
 * ============================================================================
 */

import mongoose, { Schema, Document, Model } from 'mongoose';
import * as argon2 from 'argon2';

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/** Verified badge types — mirrors Twitter/Instagram badge tiers */
export enum BadgeType {
  NONE = 'none',
  CREATOR = 'creator',
  BRAND = 'brand',
  CELEBRITY = 'celebrity',
  GOVERNMENT = 'government',
}

export enum AccountStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DEACTIVATED = 'deactivated',
  PENDING_VERIFICATION = 'pending_verification',
}

export interface IDeviceFingerprint {
  hash: string;
  label: string;
  firstSeen: Date;
  lastSeen: Date;
  trusted: boolean;
}

export interface ISession {
  sessionId: string;
  refreshTokenHash: string;
  deviceFingerprint: string;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
  expiresAt: Date;
  isRevoked: boolean;
  revokedAt?: Date;
  revokedReason?: string;
}

export interface IRateLimitLog {
  endpoint: string;
  ipAddress: string;
  timestamp: Date;
  blocked: boolean;
}

// Legacy VerifiedBadgeSchema is removed in favor of isVerified field directly on the user

export interface IUser extends Document {
  username: string;
  email: string;
  gender: 'male' | 'female' | 'other';
  role: 'user' | 'admin';
  passwordHash: string;
  displayName: string;
  bio: string;
  location: string;
  website: string;
  contactNumber: string;
  avatarUrl: string;
  coverImageUrl: string;
  isPrivate: boolean;
  hideOnlineStatus: boolean;
  blockedUsers: mongoose.Types.ObjectId[];
  notificationPreferences: {
    pauseAll: boolean;
    likes: boolean;
    comments: boolean;
    drops: boolean;
    followers: boolean;
  };
  dateOfBirth?: Date;

  // Security
  isVerified: boolean;
  deviceFingerprints: IDeviceFingerprint[];
  sessions: ISession[];
  rateLimitLogs: IRateLimitLog[];
  failedLoginAttempts: number;
  lockoutUntil?: Date;
  lastLoginAt?: Date;
  lastPasswordChangeAt?: Date;
  accountStatus: AccountStatus;

  // Denormalized counters (atomic updates via $inc)
  followersCount: number;
  followingCount: number;
  postsCount: number;

  // Timestamps (auto-managed by Mongoose)
  createdAt: Date;
  updatedAt: Date;

  // Instance methods
  verifyPassword(candidatePassword: string): Promise<boolean>;
  isLockedOut(): boolean;
  recordFailedLogin(): Promise<void>;
  resetFailedLogins(): Promise<void>;
}

export interface IUserModel extends Model<IUser> {
  findByEmail(email: string): Promise<IUser | null>;
  findByUsername(username: string): Promise<IUser | null>;
}

// ---------------------------------------------------------------------------
// Sub-Schemas
// ---------------------------------------------------------------------------

const DeviceFingerprintSchema = new Schema<IDeviceFingerprint>(
  {
    hash: { type: String, required: true },
    label: { type: String, default: 'Unknown Device' },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    trusted: { type: Boolean, default: false },
  },
  { _id: false },
);

const SessionSchema = new Schema<ISession>(
  {
    sessionId: { type: String, required: true },
    refreshTokenHash: { type: String, required: true },
    deviceFingerprint: { type: String, required: true },
    ipAddress: { type: String, required: true },
    userAgent: { type: String, required: true, maxlength: 512 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    isRevoked: { type: Boolean, default: false },
    revokedAt: { type: Date },
    revokedReason: { type: String, maxlength: 256 },
  },
  { _id: false },
);

const RateLimitLogSchema = new Schema<IRateLimitLog>(
  {
    endpoint: { type: String, required: true },
    ipAddress: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    blocked: { type: Boolean, default: false },
  },
  { _id: false },
);

// Legacy VerifiedBadgeSchema removed

// ---------------------------------------------------------------------------
// Main User Schema
// ---------------------------------------------------------------------------

const UserSchema = new Schema<IUser, IUserModel>(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      trim: true,
      lowercase: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username cannot exceed 30 characters'],
      match: [/^[a-z0-9_]+$/, 'Username may only contain lowercase letters, numbers, and underscores'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email format'],
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other'],
      required: [true, 'Gender is required'],
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    passwordHash: {
      type: String,
      required: true,
      select: false, // Never returned in queries by default
    },
    displayName: {
      type: String,
      required: [true, 'Display name is required'],
      trim: true,
      maxlength: [50, 'Display name cannot exceed 50 characters'],
    },
    bio: {
      type: String,
      default: '',
      maxlength: [280, 'Bio cannot exceed 280 characters'],
    },
    location: { type: String, default: '', maxlength: 100 },
    website: { type: String, default: '', maxlength: 200 },
    contactNumber: { type: String, default: '', maxlength: 20 },
    avatarUrl: { type: String, default: '' },
    coverImageUrl: { type: String, default: '' },
    isPrivate: { type: Boolean, default: false },
    hideOnlineStatus: { type: Boolean, default: false },
    blockedUsers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    notificationPreferences: {
      pauseAll: { type: Boolean, default: false },
      likes: { type: Boolean, default: true },
      comments: { type: Boolean, default: true },
      drops: { type: Boolean, default: true },
      followers: { type: Boolean, default: true },
    },
    dateOfBirth: { type: Date },

    // Security sub-documents
    isVerified: {
      type: Boolean,
      default: false,
    },
    deviceFingerprints: {
      type: [DeviceFingerprintSchema],
      default: [],
      validate: [
        (val: IDeviceFingerprint[]) => val.length <= 20,
        'Maximum 20 device fingerprints allowed',
      ],
    },
    sessions: {
      type: [SessionSchema],
      default: [],
      select: false, // Never leaked in public queries
      validate: [
        (val: ISession[]) => val.length <= 10,
        'Maximum 10 concurrent sessions allowed',
      ],
    },
    rateLimitLogs: {
      type: [RateLimitLogSchema],
      default: [],
      select: false,
    },

    // Brute-force protection
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockoutUntil: { type: Date, select: false },
    lastLoginAt: { type: Date },
    lastPasswordChangeAt: { type: Date },
    accountStatus: {
      type: String,
      enum: Object.values(AccountStatus),
      default: AccountStatus.ACTIVE,
    },

    // Denormalized counters — updated via atomic $inc operations
    followersCount: { type: Number, default: 0, min: 0 },
    followingCount: { type: Number, default: 0, min: 0 },
    postsCount: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        // Strip sensitive fields from any JSON serialization
        delete ret.passwordHash;
        delete ret.sessions;
        delete ret.rateLimitLogs;
        delete ret.failedLoginAttempts;
        delete ret.lockoutUntil;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// ---------------------------------------------------------------------------
// Indexes — Optimized for heavy-read access patterns
// ---------------------------------------------------------------------------
/**
 * Architectural Rationale:
 * - `username` index uses collation `{ locale: 'en', strength: 2 }` to enforce true case-insensitivity
 *   at the database level, preventing spoofing (e.g., "Kashish" vs "kashish").
 * - `sessions` fields are indexed to allow fast revocation lookups (e.g., during logout).
 */
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ username: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
UserSchema.index({ 'sessions.sessionId': 1 });
UserSchema.index({ 'sessions.refreshTokenHash': 1 });
UserSchema.index({ accountStatus: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// Pre-save Hook — Argon2id password hashing
// ---------------------------------------------------------------------------
/**
 * Architectural Rationale:
 * We use Argon2id over bcrypt because it provides superior resistance against GPU cracking
 * and side-channel attacks. The memory cost is set to 64MB to heavily penalize brute-force attempts.
 */
UserSchema.pre('save', async function () {
  // Only hash if password field was modified
  if (!this.isModified('passwordHash')) return;

  // Argon2id with OWASP-recommended parameters:
  //   memoryCost: 65536 KB (64 MB), timeCost: 3, parallelism: 4
  this.passwordHash = await argon2.hash(this.passwordHash, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
    hashLength: 32,
  });

  this.lastPasswordChangeAt = new Date();
});

// ---------------------------------------------------------------------------
// Instance Methods
// ---------------------------------------------------------------------------

/** Constant-time password verification */
UserSchema.methods.verifyPassword = async function (
  candidatePassword: string,
): Promise<boolean> {
  return argon2.verify(this.passwordHash, candidatePassword);
};

/** Check if account is locked due to brute-force attempts */
UserSchema.methods.isLockedOut = function (): boolean {
  if (!this.lockoutUntil) return false;
  if (new Date() > this.lockoutUntil) {
    // Lockout expired — will be cleared on next successful login
    return false;
  }
  return true;
};

/** Record failed login attempt; lock account after 5 failures */
UserSchema.methods.recordFailedLogin = async function (): Promise<void> {
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

  this.failedLoginAttempts += 1;

  if (this.failedLoginAttempts >= MAX_ATTEMPTS) {
    this.lockoutUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
  }

  await this.save();
};

/** Reset failed login counter on successful auth */
UserSchema.methods.resetFailedLogins = async function (): Promise<void> {
  this.failedLoginAttempts = 0;
  this.lockoutUntil = undefined;
  this.lastLoginAt = new Date();
  await this.save();
};

// ---------------------------------------------------------------------------
// Static Methods
// ---------------------------------------------------------------------------

UserSchema.statics.findByEmail = function (email: string) {
  return this.findOne({ email: email.toLowerCase().trim() })
    .select('+passwordHash +sessions +failedLoginAttempts +lockoutUntil');
};

UserSchema.statics.findByUsername = function (username: string) {
  return this.findOne({ username: username.toLowerCase().trim() });
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const User = mongoose.model<IUser, IUserModel>('User', UserSchema);
