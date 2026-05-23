import { Request, Response } from 'express';
import { User } from '../models/User.model';
import FollowerGraph from '../models/FollowerGraph.model';
import Post from '../models/Post.model';
import Notification, { NotificationType } from '../models/Notification.model';
import { emitToUser } from '../socket';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import path from 'path';
import mongoose from 'mongoose';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

// ---------------------------------------------------------------------------
// Helper: Timeout Wrapper for S3 Uploads
// ---------------------------------------------------------------------------
const withTimeout = <T>(promise: Promise<T>, ms: number = 10000): Promise<T> => {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('S3 Operation timed out')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

// GET /api/users/:username — Public profile
/**
 * Fetches a user's public profile and computes the follower relationship to the requesting user.
 * 
 * Architectural Rationale:
 * We query by `username` instead of `_id` because usernames are meant to be the public identifier
 * in URLs (e.g. `cockroach.app/kashish`). `username` is lowercased to ensure case-insensitive matching.
 */
export const getUserProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.params.username);

    const user = await User.findOne({ username: username.toLowerCase() }).select(
      'username displayName bio location website avatarUrl coverImageUrl followersCount followingCount postsCount isVerified isPrivate createdAt role'
    );

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const requestingUserId = req.user?._id;
    const isOwnProfile = requestingUserId?.toString() === user._id.toString();

    // Hide admins from regular users
    if (user.role === 'admin' && !isOwnProfile) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Batch both FollowerGraph checks in parallel for performance
    let isFollowing = false;  // Am I (requester) following this profile?
    let isFollower  = false;  // Is this profile following me (requester)?

    if (requestingUserId && !isOwnProfile) {
      const [outEdge, inEdge] = await Promise.all([
        FollowerGraph.findOne({ followerId: requestingUserId, followingId: user._id }).lean(),
        FollowerGraph.findOne({ followerId: user._id, followingId: requestingUserId }).lean(),
      ]);
      isFollowing = !!outEdge;
      isFollower  = !!inEdge;
    }

    res.status(200).json({
      success: true,
      data: {
        ...user.toJSON(),
        isFollowing,
        isFollower,
        isOwnProfile,
      },
    });
  } catch (err) {
    console.error('[USER] getUserProfile error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
};

// GET /api/users/:username/posts — User's posts
export const getUserPosts = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.params.username);

    const user = await User.findOne({ username: username.toLowerCase() }).select('_id role');
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (user.role === 'admin' && req.user?._id?.toString() !== user._id.toString()) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const posts = await Post.find({ author: user._id })
      .populate('author', 'username displayName avatarUrl')
      .sort({ createdAt: -1 })
      .limit(50);

    res.status(200).json({ success: true, data: posts });
  } catch (err) {
    console.error('[USER] getUserPosts error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to fetch user posts' });
  }
};

// POST /api/users/:username/follow — Toggle follow
/**
 * Toggles the follow status between the authenticated user and a target user.
 * 
 * Architectural Rationale:
 * We use a dedicated `FollowerGraph` collection rather than embedding `followers` arrays in the User model.
 * Embedded arrays have a 16MB document size limit and degrade performance as they grow.
 * A separate graph collection allows infinite scaling and fast indexed queries.
 * We also denormalize `followersCount` and `followingCount` onto the User model for fast O(1) profile reads.
 */
export const toggleFollow = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.params.username);
    const followerId = req.user?._id;

    if (!followerId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    const targetUser = await User.findOne({ username: username.toLowerCase() }).select('_id role');
    if (!targetUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (targetUser.role === 'admin') {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (followerId.toString() === targetUser._id.toString()) {
      res.status(400).json({ success: false, error: 'Cannot follow yourself' });
      return;
    }

    const existingFollow = await FollowerGraph.findOne({
      followerId,
      followingId: targetUser._id,
    });

    if (existingFollow) {
      // Unfollow
      // Rationale: These operations are separated. If we needed strict ACID compliance, we would use a Mongoose transaction.
      // However, for social features, eventual consistency is acceptable and transactions reduce throughput.
      await FollowerGraph.deleteOne({ followerId, followingId: targetUser._id });
      await User.updateOne({ _id: targetUser._id }, { $inc: { followersCount: -1 } });
      await User.updateOne({ _id: followerId }, { $inc: { followingCount: -1 } });
      
      // Remove follow notification (non-blocking cleanup)
      await Notification.deleteOne({ recipient: targetUser._id, actor: followerId, type: NotificationType.FOLLOW });

      res.status(200).json({ success: true, data: { isFollowing: false } });
    } else {
      // Follow
      await FollowerGraph.create({ followerId, followingId: targetUser._id });
      await User.updateOne({ _id: targetUser._id }, { $inc: { followersCount: 1 } });
      await User.updateOne({ _id: followerId }, { $inc: { followingCount: 1 } });
      // Create follow notification (don't await — non-blocking)
      Notification.create({ recipient: targetUser._id, actor: followerId, type: NotificationType.FOLLOW }).then(notif => {
        emitToUser(targetUser._id.toString(), 'new_notification', notif);
      }).catch(() => {});

      res.status(200).json({ success: true, data: { isFollowing: true } });
    }
  } catch (err: unknown) {
    const e = err as { code?: number; message?: string };
    // Handle duplicate key error (race condition — user already follows)
    // Rationale: If two requests hit this endpoint simultaneously, the unique compound index on
    // FollowerGraph (followerId + followingId) will throw a 11000 error, preventing duplicate follows.
    if (e.code === 11000) {
      res.status(409).json({ success: false, error: 'Already following this user' });
      return;
    }
    console.error('[USER] toggleFollow error:', e.message);
    res.status(500).json({ success: false, error: 'Failed to update follow status' });
  }
};

// PUT /api/users/profile — Update own profile
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { displayName, bio, location, website, contactNumber, gender } = req.body;
    const updates: Record<string, unknown> = {};

    if (displayName !== undefined) updates['displayName'] = String(displayName).trim().slice(0, 50);
    if (bio !== undefined) updates['bio'] = String(bio).trim().slice(0, 280);
    if (location !== undefined) updates['location'] = String(location).trim().slice(0, 100);
    if (website !== undefined) updates['website'] = String(website).trim().slice(0, 200);
    if (contactNumber !== undefined) updates['contactNumber'] = String(contactNumber).trim().slice(0, 20);
    if (gender !== undefined && ['male', 'female', 'other'].includes(gender)) updates['gender'] = gender;

    // Handle file uploads to S3
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const bucket = process.env.AWS_S3_BUCKET_NAME || 'cockroach-app-bucket';

    if (files) {
      if (files['avatar']?.[0]) {
        const file = files['avatar'][0];
        const ext = path.extname(file.originalname);
        const key = `avatars/${userId}_${crypto.randomBytes(8).toString('hex')}${ext}`;
        try {
          await withTimeout(s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          })), 30000); // Increased timeout to 30s
          updates['avatarUrl'] = `https://${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
        } catch (s3Err) {
          console.error('[USER] S3 Avatar Upload Error:', s3Err);
          res.status(502).json({ success: false, error: 'Failed to upload avatar to S3', details: (s3Err as Error).message });
          return;
        }
      }

      if (files['coverImage']?.[0]) {
        const file = files['coverImage'][0];
        const ext = path.extname(file.originalname);
        const key = `covers/${userId}_${crypto.randomBytes(8).toString('hex')}${ext}`;
        try {
          await withTimeout(s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          })), 30000); // Increased timeout to 30s
          updates['coverImageUrl'] = `https://${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
        } catch (s3Err) {
          console.error('[USER] S3 Cover Upload Error:', s3Err);
          res.status(502).json({ success: false, error: 'Failed to upload cover image to S3', details: (s3Err as Error).message });
          return;
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('username displayName bio location website avatarUrl followersCount followingCount postsCount');

    res.status(200).json({ success: true, data: updated });
    } catch (err) {
      console.error('[USER] updateProfile error:', err);
      res.status(500).json({ success: false, error: 'Failed to update profile', details: (err as Error).message });
    }
};

// GET /api/users/settings - get preferences
export const getSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const user = await User.findById(userId).select('email contactNumber gender isPrivate hideOnlineStatus notificationPreferences');
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    console.error('[USER] getSettings error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
};

// PUT /api/users/settings — Update user preferences
export const updateSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const { isPrivateProfile, hideOnlineStatus, blockedUsers, notificationPreferences } = req.body;
    const updates: Record<string, unknown> = {};

    if (isPrivateProfile !== undefined) updates['isPrivate'] = Boolean(isPrivateProfile);
    if (hideOnlineStatus !== undefined) updates['hideOnlineStatus'] = Boolean(hideOnlineStatus);
    if (blockedUsers !== undefined && Array.isArray(blockedUsers)) updates['blockedUsers'] = blockedUsers;
    
    if (notificationPreferences !== undefined) {
      const current = await User.findById(userId).select('notificationPreferences');
      updates['notificationPreferences'] = {
        ...current?.notificationPreferences,
        ...notificationPreferences
      };
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }

    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('isPrivate hideOnlineStatus blockedUsers notificationPreferences');

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    console.error('[USER] updateSettings error:', err);
    res.status(500).json({ success: false, error: 'Failed to update settings', details: (err as Error).message });
  }
};

// ---------------------------------------------------------------------------
// GET /api/users/inbox/mutuals
// ---------------------------------------------------------------------------
export const getMutuals = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    // 1. Find all users I am following
    const followingEdges = await FollowerGraph.find({ followerId: userId }).select('followingId').lean();
    const followingIds = followingEdges.map(e => e.followingId);

    // 2. Out of those, find who is following me back
    const mutualEdges = await FollowerGraph.find({
      followingId: userId,
      followerId: { $in: followingIds }
    }).select('followerId').lean();
    const mutualIds = mutualEdges.map(e => e.followerId);

    // 3. Populate user data (excluding admins)
    const mutuals = await User.find({ _id: { $in: mutualIds }, role: { $ne: 'admin' } })
      .select('username displayName avatarUrl isVerified gender')
      .lean();

    res.status(200).json({ success: true, data: mutuals });
  } catch (err) {
    console.error('[USER] getMutuals error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to fetch mutual followers' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/users/:username/followers
// ---------------------------------------------------------------------------
export const getFollowers = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.params.username).toLowerCase();
    const requestingUserId = req.user?._id;

    const target = await User.findOne({ username }).select('_id role');
    if (!target || (target.role === 'admin' && requestingUserId?.toString() !== target._id.toString())) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    // All edges where someone follows this user
    const edges = await FollowerGraph.find({ followingId: target._id })
      .select('followerId')
      .lean();

    const followerIds = edges.map((e) => e.followerId);

    const users = await User.find({ _id: { $in: followerIds }, role: { $ne: 'admin' } })
      .select('username displayName avatarUrl followersCount isVerified')
      .lean();

    // Attach isFollowing + isFollower flags for the requester
    let followingSet = new Set<string>(); // users I follow
    let followerSet  = new Set<string>(); // users who follow me
    if (requestingUserId && followerIds.length > 0) {
      const [myOutEdges, myInEdges] = await Promise.all([
        FollowerGraph.find({ followerId: requestingUserId, followingId: { $in: followerIds } }).select('followingId').lean(),
        FollowerGraph.find({ followingId: requestingUserId, followerId: { $in: followerIds } }).select('followerId').lean(),
      ]);
      followingSet = new Set(myOutEdges.map((e) => e.followingId.toString()));
      followerSet  = new Set(myInEdges.map((e) => e.followerId.toString()));
    }

    const result = users.map((u) => ({
      ...u,
      isFollowing: followingSet.has((u._id as mongoose.Types.ObjectId).toString()),
      isFollower:  followerSet.has((u._id as mongoose.Types.ObjectId).toString()),
    }));

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[USER] getFollowers error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to fetch followers' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/users/:username/following
// ---------------------------------------------------------------------------
export const getFollowing = async (req: Request, res: Response): Promise<void> => {
  try {
    const username = String(req.params.username).toLowerCase();
    const requestingUserId = req.user?._id;

    const target = await User.findOne({ username }).select('_id role');
    if (!target || (target.role === 'admin' && requestingUserId?.toString() !== target._id.toString())) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    // All edges where this user follows someone
    const edges = await FollowerGraph.find({ followerId: target._id })
      .select('followingId')
      .lean();

    const followingIds = edges.map((e) => e.followingId);

    const users = await User.find({ _id: { $in: followingIds }, role: { $ne: 'admin' } })
      .select('username displayName avatarUrl followersCount isVerified')
      .lean();

    // Attach isFollowing + isFollower flags for the requester
    let followingSet = new Set<string>(); // users I follow
    let followerSet  = new Set<string>(); // users who follow me
    if (requestingUserId && followingIds.length > 0) {
      const [myOutEdges, myInEdges] = await Promise.all([
        FollowerGraph.find({ followerId: requestingUserId, followingId: { $in: followingIds } }).select('followingId').lean(),
        FollowerGraph.find({ followingId: requestingUserId, followerId: { $in: followingIds } }).select('followerId').lean(),
      ]);
      followingSet = new Set(myOutEdges.map((e) => e.followingId.toString()));
      followerSet  = new Set(myInEdges.map((e) => e.followerId.toString()));
    }

    const result = users.map((u) => ({
      ...u,
      isFollowing: followingSet.has((u._id as mongoose.Types.ObjectId).toString()),
      isFollower:  followerSet.has((u._id as mongoose.Types.ObjectId).toString()),
    }));

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[USER] getFollowing error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to fetch following' });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/users/account — Delete account permanently
// ---------------------------------------------------------------------------
export const deleteAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    // Start a cleanup process
    await Post.deleteMany({ author: userId });
    await FollowerGraph.deleteMany({ $or: [{ followerId: userId }, { followingId: userId }] });
    await Notification.deleteMany({ $or: [{ recipient: userId }, { actor: userId }] });
    await User.findByIdAndDelete(userId);

    // Note: We don't delete S3 assets here to speed up response, can be handled via a background cron job.
    res.status(200).json({ success: true, message: 'Account deleted successfully' });
  } catch (err) {
    console.error('[USER] deleteAccount error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/users/verify-request
// ---------------------------------------------------------------------------
export const verifyRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    
    // In a real app, this would save a VerificationRequest document to the DB.
    // For now, we just acknowledge receipt.
    res.status(200).json({ success: true, message: 'Verification request submitted successfully' });
  } catch (err) {
    console.error('[USER] verifyRequest error:', err);
    res.status(500).json({ success: false, error: 'Failed to submit request' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/users/blocked
// ---------------------------------------------------------------------------
export const getBlockedUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const user = await User.findById(userId).populate('blockedUsers', 'username displayName avatarUrl isVerified');
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    res.status(200).json({ success: true, data: user.blockedUsers || [] });
  } catch (err) {
    console.error('[USER] getBlockedUsers error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch blocked users' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/users/unblock/:id
// ---------------------------------------------------------------------------
export const unblockUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    const targetId = req.params.id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    await User.findByIdAndUpdate(userId, { $pull: { blockedUsers: targetId } });
    
    res.status(200).json({ success: true, message: 'User unblocked successfully' });
  } catch (err) {
    console.error('[USER] unblockUser error:', err);
    res.status(500).json({ success: false, error: 'Failed to unblock user' });
  }
};
