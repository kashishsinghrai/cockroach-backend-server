/**
 * ============================================================================
 * Cockroach — Zero-Trust Authentication Middleware
 * ============================================================================
 * Enforces:
 *  1. Valid JWT access token (signature + expiry)
 *  2. Device fingerprint binding (token fingerprint === request fingerprint)
 *  3. Active, non-revoked session in the database
 *  4. Account is not suspended/deactivated/locked
 *
 * Dependencies: ../utils/crypto, ../models/User.model
 * ============================================================================
 */

import { Request, Response, NextFunction } from 'express';
import {
  verifyAccessToken,
  extractDeviceFingerprint,
  AccessTokenPayload,
} from '../utils/crypto';
import { User, IUser, ISession, AccountStatus } from '../models/User.model';

// ---------------------------------------------------------------------------
// Extend Express Request to carry authenticated user context
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      /** Authenticated user document (without sensitive fields) */
      user?: IUser;
      /** The current active session object */
      currentSession?: ISession;
      /** Decoded JWT payload */
      tokenPayload?: AccessTokenPayload;
      /** Device fingerprint for the current request */
      deviceFingerprint?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Error Responses — generic messages to prevent information leakage
// ---------------------------------------------------------------------------

const UNAUTHORIZED = { success: false, error: 'Authentication required' };
const FORBIDDEN_DEVICE = { success: false, error: 'Device verification failed' };
const SESSION_INVALID = { success: false, error: 'Session expired or revoked' };
const ACCOUNT_LOCKED = { success: false, error: 'Account is temporarily locked' };
const ACCOUNT_INACTIVE = { success: false, error: 'Account is not active' };

// ---------------------------------------------------------------------------
// Core Middleware
// ---------------------------------------------------------------------------

/**
 * Zero-trust authentication middleware.
 *
 * Performs a 4-layer verification chain:
 *   Layer 1: Extract and verify JWT from Authorization header
 *   Layer 2: Extract current device fingerprint and compare with token-bound fingerprint
 *   Layer 3: Validate session exists in DB, is not revoked, and not expired
 *   Layer 4: Verify account status (active, not locked/suspended)
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // -----------------------------------------------------------------------
    // Layer 1: JWT Extraction & Verification
    // -----------------------------------------------------------------------
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    const token = authHeader.slice(7); // Strip "Bearer "
    if (!token || token.length === 0) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    let decoded: AccessTokenPayload;
    try {
      decoded = verifyAccessToken(token);
    } catch {
      // Covers: expired, malformed, wrong signature — all return 401
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    // -----------------------------------------------------------------------
    // Layer 2: Device Fingerprint Binding
    // -----------------------------------------------------------------------
    const currentFingerprint = extractDeviceFingerprint(req);

    if (decoded.fingerprint !== currentFingerprint) {
      // Token was likely stolen and used from a different device
      res.status(403).json(FORBIDDEN_DEVICE);
      return;
    }

    // -----------------------------------------------------------------------
    // Layer 3: Session Validation (Database lookup)
    // -----------------------------------------------------------------------
    const user = await User.findById(decoded.userId)
      .select('+sessions +failedLoginAttempts +lockoutUntil')
      .lean(false); // Need a full Mongoose document for methods

    if (!user) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    // Find the specific session by sessionId
    const session = user.sessions.find(
      (s: ISession) =>
        s.sessionId === decoded.sessionId &&
        !s.isRevoked &&
        new Date(s.expiresAt) > new Date(),
    );

    if (!session) {
      res.status(401).json(SESSION_INVALID);
      return;
    }

    // Verify session's fingerprint matches the current request
    if (session.deviceFingerprint !== currentFingerprint) {
      res.status(403).json(FORBIDDEN_DEVICE);
      return;
    }

    // -----------------------------------------------------------------------
    // Layer 4: Account Status Checks
    // -----------------------------------------------------------------------
    if (user.isLockedOut()) {
      res.status(423).json(ACCOUNT_LOCKED);
      return;
    }

    if (user.accountStatus !== AccountStatus.ACTIVE) {
      res.status(403).json(ACCOUNT_INACTIVE);
      return;
    }

    // -----------------------------------------------------------------------
    // Attach context to request for downstream handlers
    // -----------------------------------------------------------------------
    req.user = user;
    req.currentSession = session;
    req.tokenPayload = decoded;
    req.deviceFingerprint = currentFingerprint;

    next();
  } catch {
    // Catch-all: never leak internal errors
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Optional: Require specific account status.
 * Use as: router.get('/admin', authenticate, requireStatus(AccountStatus.ACTIVE), handler)
 */
export function requireStatus(...statuses: AccountStatus[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !statuses.includes(req.user.accountStatus)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

/**
 * Optional: Require verified badge.
 * Use as: router.post('/live', authenticate, requireVerified, handler)
 */
export function requireVerified(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user?.isVerified) {
    res.status(403).json({ success: false, error: 'Verified badge required' });
    return;
  }
  next();
}
