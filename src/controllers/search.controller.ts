import { Request, Response } from 'express';
import { User } from '../models/User.model';
import FollowerGraph from '../models/FollowerGraph.model';

// GET /api/search/users?query=
/**
 * Performs a dynamic partial-text search against usernames and display names.
 * 
 * Architectural Rationale:
 * We use a `$regex` search instead of a MongoDB `$text` index because we need partial word matching
 * (e.g. typing "kash" should return "kashish"). MongoDB `$text` indexes only match full words or stem roots.
 * To protect against regex injection (ReDoS attacks), we sanitize the query string to escape special characters.
 */
export const searchUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const query = (req.query.query as string || '').trim();

    if (!query || query.length < 1) {
      res.status(200).json({ success: true, data: [] });
      return;
    }

    const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(safeQuery, 'i');

    const queryParams: any = {
      $and: [
        { role: { $ne: 'admin' } },
        { $or: [{ username: { $regex: regex } }, { displayName: { $regex: regex } }] }
      ]
    };

    const genderFilter = req.query.genderFilter as string;
    if (genderFilter === 'male' || genderFilter === 'female') {
      queryParams.$and.push({ gender: genderFilter });
    } else if (req.user?.communityPreference && req.user.communityPreference !== 'everyone' && genderFilter !== 'everyone') {
      queryParams.$and.push({ gender: req.user.communityPreference });
    }

    const users = await User.find(queryParams)
      .select('username displayName avatarUrl followersCount isVerified')
      .limit(20)
      .lean();

    // Attach isFollowing + isFollower flags for the requesting user
    const requestingUserId = req.user?._id;
    let followingSet = new Set<string>(); // users I follow
    let followerSet  = new Set<string>(); // users who follow me
    if (requestingUserId && users.length > 0) {
      const userIds = users.map((u) => (u as any)._id);
      const [outEdges, inEdges] = await Promise.all([
        FollowerGraph.find({ followerId: requestingUserId, followingId: { $in: userIds } }).select('followingId').lean(),
        FollowerGraph.find({ followingId: requestingUserId, followerId: { $in: userIds } }).select('followerId').lean(),
      ]);
      followingSet = new Set(outEdges.map((e) => e.followingId.toString()));
      followerSet  = new Set(inEdges.map((e) => e.followerId.toString()));
    }

    const result = users.map((u) => ({
      ...u,
      isFollowing: followingSet.has((u as any)._id.toString()),
      isFollower:  followerSet.has((u as any)._id.toString()),
    }));

    res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error('[SEARCH] searchUsers error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
};

// GET /api/search/trending — Recommended users and trending tags
/**
 * Fetches globally trending tags and recommended users.
 * 
 * Architectural Rationale:
 * Trending tags are currently statically mocked for the MVP. In a full production system, 
 * this would query a Redis sorted set populated by a background worker aggregating tag frequency.
 * Recommended users are simply sorted by `followersCount` (a denormalized, indexed field) 
 * for maximum read performance.
 */
export const getTrending = async (req: Request, res: Response): Promise<void> => {
  try {
    const queryParams: any = { role: { $ne: 'admin' } };
    
    if (req.user?.communityPreference && req.user.communityPreference !== 'everyone') {
      queryParams.gender = req.user.communityPreference;
    }

    // Return top users by follower count as "recommended to follow", excluding admins
    const recommendedUsers = await User.find(queryParams)
      .select('username displayName avatarUrl followersCount isVerified')
      .sort({ followersCount: -1 })
      .limit(10);

    const trendingTags = [
      { tag: '#CockroachApp', posts: 1200 },
      { tag: '#FlutterDev', posts: 8500 },
      { tag: '#GenZ', posts: 45000 },
      { tag: '#OpenSource', posts: 22000 },
      { tag: '#BuildInPublic', posts: 11300 },
      { tag: '#Dart', posts: 6700 },
    ];

    res.status(200).json({
      success: true,
      data: {
        trendingTags,
        recommendedUsers,
      },
    });
  } catch (err) {
    console.error('[SEARCH] getTrending error:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to fetch trending data' });
  }
};
