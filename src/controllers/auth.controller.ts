/**
 * Cockroach — Auth Controller
 * 
 * Architectural Rationale:
 * This system implements a dual-token architecture (Stateless JWT Access Token + Stateful Refresh Token)
 * to balance performance and security.
 * - Access Tokens (15m expiry): Completely stateless, allowing fast local validation by microservices without DB hits.
 * - Refresh Tokens (7d expiry): Stored statefully in MongoDB (`user.sessions`), allowing us to instantly revoke
 *   compromised sessions or enforce max concurrent session limits without waiting for token expiry.
 */

import { Request, Response } from 'express';
import { User, ISession, AccountStatus } from '../models/User.model';
import {
  generateTokenPair, generateSessionId, extractDeviceFingerprint,
  extractClientIP, hashSHA256, verifyRefreshToken,
} from '../utils/crypto';

// Token lifetimes are configured to match security vs UX trade-offs. 
// A 7-day refresh ensures active users rarely need to log in manually, 
// while limiting the window of vulnerability if a device is stolen.
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 10;
const INVALID_CREDS = 'Invalid email or password';

// -- REGISTER --
/**
 * Registers a new user, hashes their password, and initiates their first session.
 * 
 * Payload: { username, email, password, displayName }
 */
export async function register(req: Request, res: Response): Promise<void> {
  try {
    let { username, email, password, displayName, gender } = req.body;
    
    // Rationale: Usernames are critical for routing and indexing. We aggressively sanitize
    // them (lowercasing, replacing spaces with underscores, stripping special chars) to prevent
    // URL-encoding bugs, impersonation attacks, and routing conflicts in the frontend.
    if (username) {
      username = username.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    }

    if (!username || !email || !password || !displayName || !gender) {
      res.status(400).json({ success: false, error: 'Missing required fields' }); return;
    }
    if (!['male', 'female', 'other'].includes(gender)) {
      res.status(400).json({ success: false, error: 'Invalid gender' }); return;
    }
    if (password.length < 8 || password.length > 128) {
      res.status(400).json({ success: false, error: 'Password must be 8-128 characters' }); return;
    }

    const exists = await User.findOne({
      $or: [{ email: email.toLowerCase().trim() }, { username: username.toLowerCase().trim() }],
    });
    if (exists) { res.status(409).json({ success: false, error: 'Account already exists' }); return; }

    const fp = extractDeviceFingerprint(req);
    const ip = extractClientIP(req);
    const ua = (req.headers['user-agent'] || 'unknown').slice(0, 512);
    const sid = generateSessionId();

    const user = new User({
      username: username.toLowerCase().trim(),
      email: email.toLowerCase().trim(),
      gender: gender,
      communityPreference: gender === 'male' || gender === 'female' ? gender : 'everyone',
      passwordHash: password, // Argon2id pre-save hook hashes this
      displayName: displayName.trim(),
      accountStatus: AccountStatus.ACTIVE,
      deviceFingerprints: [{ hash: fp, label: ua.slice(0, 64), firstSeen: new Date(), lastSeen: new Date(), trusted: true }],
    });

    const tokens = generateTokenPair(user._id.toString(), sid, fp);
    user.sessions.push({
      sessionId: sid, refreshTokenHash: hashSHA256(tokens.refreshToken),
      deviceFingerprint: fp, ipAddress: ip, userAgent: ua,
      createdAt: new Date(), expiresAt: new Date(Date.now() + REFRESH_TTL_MS), isRevoked: false,
    });
    user.lastLoginAt = new Date();
    await user.save();

    res.status(201).json({
      success: true,
      data: {
        user: { id: user._id, username: user.username, email: user.email, displayName: user.displayName, gender: user.gender, communityPreference: user.communityPreference, avatarUrl: user.avatarUrl, role: user.role },
        tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: '15m' },
      },
    });
  } catch (err: unknown) {
    const e = err as { code?: number; message?: string };
    if (e.code === 11000) { res.status(409).json({ success: false, error: 'Account already exists' }); return; }
    console.error('[AUTH] Register error:', e.message);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
}

// -- LOGIN --
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;
    if (!email || !password) { res.status(400).json({ success: false, error: 'Email and password required' }); return; }

    const user = await User.findOne({ email: email.toLowerCase().trim() })
      .select('+passwordHash +sessions +failedLoginAttempts +lockoutUntil +rateLimitLogs +deviceFingerprints');
      
    if (!user) { res.status(401).json({ success: false, error: INVALID_CREDS }); return; }
    if (user.isLockedOut()) { res.status(423).json({ success: false, error: 'Account locked. Try again later.' }); return; }
    if (user.accountStatus === AccountStatus.SUSPENDED) { res.status(403).json({ success: false, error: 'Account suspended' }); return; }
    if (user.accountStatus === AccountStatus.DEACTIVATED) { res.status(403).json({ success: false, error: 'Account deactivated' }); return; }

    const valid = await user.verifyPassword(password);
    if (!valid) {
      await user.recordFailedLogin();
      if (!user.rateLimitLogs) user.rateLimitLogs = [];
      user.rateLimitLogs.push({ endpoint: '/api/auth/login', ipAddress: extractClientIP(req), timestamp: new Date(), blocked: user.failedLoginAttempts >= 5 });
      if (user.rateLimitLogs.length > 100) user.rateLimitLogs = user.rateLimitLogs.slice(-50);
      await user.save();
      res.status(401).json({ success: false, error: INVALID_CREDS }); return;
    }

    await user.resetFailedLogins();

    const fp = extractDeviceFingerprint(req);
    const ip = extractClientIP(req);
    const ua = (req.headers['user-agent'] || 'unknown').slice(0, 512);
    const sid = generateSessionId();
    const tokens = generateTokenPair(user._id.toString(), sid, fp);

    // Enforce max sessions by purging expired/revoked ones first
    if (!user.sessions) user.sessions = [];
    user.sessions = user.sessions.filter((s: ISession) => !s.isRevoked && new Date(s.expiresAt) > new Date());
    
    if (user.sessions.length >= MAX_SESSIONS) {
      // Sort descending by creation date (newest first), and keep only MAX_SESSIONS - 1
      user.sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      user.sessions = user.sessions.slice(0, MAX_SESSIONS - 1);
    }

    user.sessions.push({
      sessionId: sid, refreshTokenHash: hashSHA256(tokens.refreshToken),
      deviceFingerprint: fp, ipAddress: ip, userAgent: ua,
      createdAt: new Date(), expiresAt: new Date(Date.now() + REFRESH_TTL_MS), isRevoked: false,
    });

    const dev = user.deviceFingerprints.find((d) => d.hash === fp);
    if (dev) { dev.lastSeen = new Date(); }
    else { user.deviceFingerprints.push({ hash: fp, label: ua.slice(0, 64), firstSeen: new Date(), lastSeen: new Date(), trusted: false }); }

    await user.save();

    res.status(200).json({
      success: true,
      data: {
        user: { id: user._id, username: user.username, email: user.email, displayName: user.displayName, gender: user.gender, communityPreference: user.communityPreference, avatarUrl: user.avatarUrl, isVerified: user.isVerified, role: user.role },
        tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: '15m' },
      },
    });
  } catch (err: unknown) {
    console.error('[AUTH] Login error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
}

// -- REFRESH TOKEN --
export async function refreshToken(req: Request, res: Response): Promise<void> {
  try {
    const { refreshToken: incoming } = req.body;
    if (!incoming) { res.status(400).json({ success: false, error: 'Refresh token required' }); return; }

    let decoded;
    try { decoded = verifyRefreshToken(incoming); }
    catch { res.status(401).json({ success: false, error: 'Invalid refresh token' }); return; }

    const user = await User.findById(decoded.userId).select('+sessions');
    if (!user) { res.status(401).json({ success: false, error: 'Invalid refresh token' }); return; }

    const tokenHash = hashSHA256(incoming);
    const session = user.sessions.find(
      (s: ISession) => s.sessionId === decoded!.sessionId && s.refreshTokenHash === tokenHash && !s.isRevoked,
    );

    if (!session) {
      // Token reuse attack — nuke all sessions
      user.sessions.forEach((s: ISession) => { if (!s.isRevoked) { s.isRevoked = true; s.revokedAt = new Date(); s.revokedReason = 'token_reuse_attack'; } });
      await user.save();
      console.warn(`[SECURITY] Token reuse detected for user ${user._id}. All sessions revoked.`);
      res.status(401).json({ success: false, error: 'Session invalidated' }); return;
    }

    if (new Date(session.expiresAt) <= new Date()) {
      session.isRevoked = true; session.revokedAt = new Date(); session.revokedReason = 'expired';
      await user.save();
      res.status(401).json({ success: false, error: 'Session expired' }); return;
    }

    const fp = extractDeviceFingerprint(req);
    if (session.deviceFingerprint !== fp) {
      session.isRevoked = true; session.revokedAt = new Date(); session.revokedReason = 'fingerprint_mismatch';
      await user.save();
      res.status(403).json({ success: false, error: 'Device verification failed' }); return;
    }

    // Rotate tokens
    const newTokens = generateTokenPair(user._id.toString(), session.sessionId, fp);
    session.refreshTokenHash = hashSHA256(newTokens.refreshToken);
    session.expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    session.ipAddress = extractClientIP(req);
    session.userAgent = (req.headers['user-agent'] || 'unknown').slice(0, 512);
    await user.save();

    res.status(200).json({
      success: true,
      data: { tokens: { accessToken: newTokens.accessToken, refreshToken: newTokens.refreshToken, expiresIn: '15m' } },
    });
  } catch (err: unknown) {
    console.error('[AUTH] Refresh error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Token refresh failed' });
  }
}

// -- LOGOUT --
export async function logout(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user || !req.currentSession) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const dbUser = await User.findById(req.user._id).select('+sessions');
    if (!dbUser) { res.status(401).json({ success: false, error: 'User not found' }); return; }
    const s = dbUser.sessions.find((s: ISession) => s.sessionId === req.currentSession!.sessionId);
    if (s) { s.isRevoked = true; s.revokedAt = new Date(); s.revokedReason = 'user_logout'; await dbUser.save(); }
    res.status(200).json({ success: true, message: 'Logged out' });
  } catch (err: unknown) {
    console.error('[AUTH] Logout error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
}

// -- LOGOUT ALL (panic button) --
export async function logoutAll(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const dbUser = await User.findById(req.user._id).select('+sessions');
    if (!dbUser) { res.status(401).json({ success: false, error: 'User not found' }); return; }
    let count = 0;
    dbUser.sessions.forEach((s: ISession) => { if (!s.isRevoked) { s.isRevoked = true; s.revokedAt = new Date(); s.revokedReason = 'user_logout_all'; count++; } });
    await dbUser.save();
    res.status(200).json({ success: true, message: `${count} sessions revoked` });
  } catch (err: unknown) {
    console.error('[AUTH] Logout-all error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to revoke sessions' });
  }
}

// -- CHANGE PASSWORD --
export async function changePassword(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) { res.status(401).json({ success: false, error: 'Auth required' }); return; }
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, error: 'Both current and new passwords are required' }); return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      res.status(400).json({ success: false, error: 'New password must be 8-128 characters' }); return;
    }

    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    const isValid = await user.verifyPassword(currentPassword);
    if (!isValid) { res.status(401).json({ success: false, error: 'Incorrect current password' }); return; }

    user.passwordHash = newPassword; // Will be hashed by pre-save hook
    await user.save();

    res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (err: unknown) {
    console.error('[AUTH] Change password error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
}
