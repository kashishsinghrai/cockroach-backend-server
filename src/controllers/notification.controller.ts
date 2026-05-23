import { Request, Response } from 'express';
import Notification, { NotificationType } from '../models/Notification.model';
import FollowerGraph from '../models/FollowerGraph.model';

// GET /api/notifications — get authenticated user's notifications
/**
 * Fetches the user's notification feed.
 * 
 * Architectural Rationale:
 * We populate `actor` and `post` references so the frontend doesn't need to make N+1 queries.
 * As soon as the notifications are fetched, we mark them all as `read: true` via a non-blocking
 * `updateMany` call. This "fire-and-forget" approach ensures the read latency is not impacted 
 * by the database write operation.
 * 
 * We also batch-query FollowerGraph to attach `isFollowing` + `isFollower` onto each actor,
 * enabling the frontend to render correct Follow/Follow Back/Following buttons in a single pass.
 */
export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const notifications = await Notification.find({ recipient: userId })
      .populate('actor', 'username displayName avatarUrl isVerified')
      .populate('post', 'content mediaUrls')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Mark all as read (fire-and-forget)
    Notification.updateMany({ recipient: userId, read: false }, { $set: { read: true } }).catch(() => {});

    // Batch-attach isFollowing + isFollower per actor so the UI can show correct button state
    const actorIds = [
      ...new Set(
        notifications
          .map((n) => (n.actor as any)?._id?.toString())
          .filter(Boolean)
      ),
    ];

    let followingSet = new Set<string>(); // actors I follow
    let followerSet  = new Set<string>(); // actors who follow me
    if (actorIds.length > 0) {
      const [outEdges, inEdges] = await Promise.all([
        FollowerGraph.find({ followerId: userId, followingId: { $in: actorIds } }).select('followingId').lean(),
        FollowerGraph.find({ followingId: userId, followerId: { $in: actorIds } }).select('followerId').lean(),
      ]);
      followingSet = new Set(outEdges.map((e) => e.followingId.toString()));
      followerSet  = new Set(inEdges.map((e) => e.followerId.toString()));
    }

    const result = notifications.map((n) => {
      const actor = n.actor as any;
      const actorId = actor?._id?.toString() ?? '';
      return {
        ...n,
        actor: actor
          ? {
              ...actor,
              isFollowing: followingSet.has(actorId),
              isFollower:  followerSet.has(actorId),
            }
          : actor,
      };
    });

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[NOTIFICATIONS] getNotifications error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
};

// GET /api/notifications/unread-count — badge count
/**
 * Returns the count of unread notifications for the bottom navigation badge.
 * 
 * Architectural Rationale:
 * A separate lightweight endpoint using `countDocuments` is significantly faster than
 * sending full notification objects just to count them. This is polled by the frontend.
 */
export const getUnreadCount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const count = await Notification.countDocuments({ recipient: userId, read: false });
    res.status(200).json({ success: true, data: { count } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to get unread count' });
  }
};

// PUT /api/notifications/:id/read — mark a notification as read
export const markAsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    
    const notificationId = req.params.id;
    await Notification.findOneAndUpdate(
      { _id: notificationId, recipient: userId },
      { $set: { read: true } }
    );
    
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
};
