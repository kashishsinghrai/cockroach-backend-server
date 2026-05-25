import { Request, Response } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Post from '../models/Post.model';
import Comment from '../models/Comment.model';
import { User } from '../models/User.model';
import FollowerGraph from '../models/FollowerGraph.model';
import Notification, { NotificationType } from '../models/Notification.model';
import { extractAudioFromVideo, mergeVideoWithAudioUrl } from '../utils/ffmpeg.util';
import { emitToUser } from '../socket';
import crypto from 'crypto';
import path from 'path';
import mongoose from 'mongoose';
import { cacheUtil } from '../utils/cache';

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
// ---------------------------------------------------------------------------
// CREATE POST
// ---------------------------------------------------------------------------
export const createPost = async (req: Request, res: Response): Promise<void> => {
  try {
    const { content, useAudioUrl, originalAudioId, replySetting, poll, youtubeUrl } = req.body;
    const userId = req.user?._id;
    const authorGender = req.user?.gender;

    if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }
    // A Drop is valid if it has text, an image, a video, or a poll
    let parsedPoll: any = undefined;
    if (poll) {
      try {
        parsedPoll = typeof poll === 'string' ? JSON.parse(poll) : poll;
      } catch (e) {
        console.error('Failed to parse poll:', e);
      }
    }

    if (!content?.trim() && !req.file && !parsedPoll) {
      res.status(400).json({ message: 'A Drop requires text, media, or a poll.' });
      return;
    }

    const mediaUrls: string[] = [];
    let videoUrl: string | undefined;
    let audioUrl: string | undefined;
    let mediaType: 'text' | 'image' | 'video' = 'text';

    if (req.file) {
      const file = req.file;
      const bucketName = process.env.AWS_S3_BUCKET_NAME || 'cockroach-app-bucket';
      const uniqueFilename = `${Date.now()}-${Math.round(Math.random() * 1E9)}-${file.originalname}`;
      let finalVideoBuffer = file.buffer;

      // If user wants to use someone else's audio, merge it first!
      if (file.mimetype.startsWith('video/') && useAudioUrl) {
        try {
          finalVideoBuffer = await mergeVideoWithAudioUrl(file.buffer, useAudioUrl);
        } catch (e) {
          console.error('[FFmpeg] Error merging audio:', e);
          // Fallback to original buffer if merge fails
        }
      }

      await withTimeout(s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: `posts/${uniqueFilename}`,
        Body: finalVideoBuffer,
        ContentType: file.mimetype,
      })), 120000); // Increased timeout to 120s for video uploads

      const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/posts/${uniqueFilename}`;

      if (file.mimetype.startsWith('video/')) {
        videoUrl = s3Url;
        mediaType = 'video';
        
        // Extract original audio from this video so others can use it
        if (!useAudioUrl) {
          try {
            const audioBuffer = await extractAudioFromVideo(file.buffer);
            const audioFilename = `audio_${Date.now()}-${Math.round(Math.random() * 1E9)}.mp3`;
            await s3Client.send(new PutObjectCommand({
              Bucket: bucketName,
              Key: `posts/${audioFilename}`,
              Body: audioBuffer,
              ContentType: 'audio/mpeg',
            }));
            audioUrl = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/posts/${audioFilename}`;
          } catch (e) {
            console.error('[FFmpeg] Error extracting audio:', e);
          }
        } else {
          // If we used an existing audio, pass along the original audio URL and ID
          audioUrl = useAudioUrl;
        }
      } else {
        mediaUrls.push(s3Url);
        mediaType = 'image';
      }
    }

    const newPost = new Post({
      author: userId, 
      content, 
      mediaUrls, 
      videoUrl,
      youtubeUrl,
      audioUrl,
      originalAudioId: originalAudioId || undefined,
      mediaType,
      authorGender,
      replySetting: replySetting || 'everyone',
      poll: parsedPoll
    });
    const savedPost = await newPost.save();

    // Increment author's postsCount
    await User.updateOne({ _id: userId }, { $inc: { postsCount: 1 } });

    res.status(201).json({ message: 'Post created successfully', post: savedPost });
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ message: 'Server error creating post' });
  }
};

// ---------------------------------------------------------------------------
// GET FOLLOWING FEED
// ---------------------------------------------------------------------------
/**
 * Fetches a personalised "Following" feed for the authenticated user.
 *
 * Architectural Rationale:
 * Instead of a global firehose, we query FollowerGraph to get the set of users
 * the requester follows, then filter posts to author $in [followingIds, ownId].
 * This is O(follows) on the DB and keeps the payload small.
 * `isLiked` is attached server-side to avoid sending the full likes[] array
 * down to the client.
 */
export const getFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const cacheKey = `feed_${userId}`;
    const cachedData = cacheUtil.get(cacheKey);
    if (cachedData) {
      res.status(200).json({ success: true, data: cachedData, cached: true });
      return;
    }

    // Step 1: Find who the user is following
    const followingGraph = await FollowerGraph.find({ followerId: userId }).select('followingId').lean();
    const followingIds = followingGraph.map((g: any) => g.followingId);

    // Step 2: Add own user ID to fetch own posts
    followingIds.push(new mongoose.Types.ObjectId(userId));

    // Step 3: Fetch posts where author is in followingIds
    const query: any = {
      author: { $in: followingIds },
      mediaType: { $ne: 'video' }
    };
    
    // Community filtering
    if (req.user?.communityPreference && req.user.communityPreference !== 'everyone') {
      query.authorGender = req.user.communityPreference;
    }

    const posts = await Post.find(query)
      .populate('author', 'username displayName avatarUrl isVerified')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Step 4: Attach isLiked flag per post for the requesting user
    const postsWithLikeStatus = posts.map((post: any) => {
      post.isLiked = (post.likes as mongoose.Types.ObjectId[])
        .some((id) => id.toString() === userId.toString());
      return post;
    });

    // Cache for 30 seconds
    cacheUtil.set(cacheKey, postsWithLikeStatus, 30);

    res.status(200).json({ success: true, data: postsWithLikeStatus, cached: false });
  } catch (error) {
    console.error('Error fetching feed:', error);
    res.status(500).json({ message: 'Server error fetching feed' });
  }
};

// ---------------------------------------------------------------------------
// GET POSTS (kept for potential admin/debug use)
// ---------------------------------------------------------------------------
export const getPosts = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;

    const posts = await Post.find({ mediaType: { $ne: 'video' } })
      .populate({ path: 'author', select: 'username displayName avatarUrl isVerified', match: { role: { $ne: 'admin' } } })
      .sort({ createdAt: -1 })
      .limit(50);

    const filteredPosts = posts.filter(p => p.author !== null);

    const postsWithLikeStatus = filteredPosts.map((post) => {
      const obj = post.toJSON() as unknown as Record<string, unknown>;
      obj['isLiked'] = userId
        ? (post.likes as mongoose.Types.ObjectId[]).some((id) => id.toString() === userId.toString())
        : false;
      return obj;
    });

    res.status(200).json({ success: true, data: postsWithLikeStatus });
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ message: 'Server error fetching posts' });
  }
};

// ---------------------------------------------------------------------------
// GET REELS (Global Feed of Videos)
// ---------------------------------------------------------------------------
export const getReels = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;

    const query: any = { mediaType: 'video' };
    
    // Community filtering
    if (req.user?.communityPreference && req.user.communityPreference !== 'everyone') {
      query.authorGender = req.user.communityPreference;
    }

    // Fetch globally available posts that are videos
    const posts = await Post.find(query)
      .populate({ path: 'author', select: 'username displayName avatarUrl isVerified gender', match: { role: { $ne: 'admin' } } })
      .sort({ createdAt: -1 })
      .limit(50);

    const filteredPosts = posts.filter(p => p.author !== null);

    const postsWithLikeStatus = filteredPosts.map((post) => {
      const obj = post.toJSON() as unknown as Record<string, unknown>;
      obj['isLiked'] = userId
        ? (post.likes as mongoose.Types.ObjectId[]).some((id) => id.toString() === userId.toString())
        : false;
      return obj;
    });

    res.status(200).json({ success: true, data: postsWithLikeStatus });
  } catch (error) {
    console.error('Error fetching reels:', error);
    res.status(500).json({ message: 'Server error fetching reels' });
  }
};

// ---------------------------------------------------------------------------
// TOGGLE LIKE
// ---------------------------------------------------------------------------
/**
 * Toggles the like status of a post for the authenticated user.
 * 
 * Architectural Rationale:
 * We use `$addToSet` and `$pull` combined with `$inc` to ensure the operation is atomic.
 * This prevents race conditions where concurrent requests might miscalculate the `likesCount`.
 * Furthermore, notifications are triggered in a non-blocking (fire-and-forget) manner.
 */
export const toggleLike = async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = String(req.params.id);
    const userId = req.user?._id;

    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    if (!mongoose.isValidObjectId(postId)) { res.status(400).json({ success: false, error: 'Invalid post ID' }); return; }

    const post = await Post.findById(postId);
    if (!post) { res.status(404).json({ success: false, error: 'Post not found' }); return; }

    const alreadyLiked = (post.likes as mongoose.Types.ObjectId[]).some(
      (id) => id.toString() === userId.toString()
    );

    if (alreadyLiked) {
      // Atomic operation: remove user from likes array and decrement count safely.
      await Post.updateOne({ _id: postId }, {
        $pull: { likes: userId },
        $inc: { likesCount: -1 },
      });
      // Remove like notification (non-blocking)
      // Rationale: Fire-and-forget logic prevents the main request from blocking on notification cleanup.
      // If it fails, the system tolerates a dangling notification over degraded API latency.
      Notification.deleteOne({ actor: userId, post: postId, type: NotificationType.LIKE }).catch(() => {});
      res.status(200).json({ success: true, data: { isLiked: false, likesCount: Math.max(0, post.likesCount - 1) } });
    } else {
      // Atomic operation: add user to likes array and increment count safely.
      await Post.updateOne({ _id: postId }, {
        $addToSet: { likes: userId },
        $inc: { likesCount: 1 },
      });
      // Create like notification (non-blocking, skip self-likes)
      // Rationale: We catch errors immediately to avoid unhandled promise rejections that could crash Node.js.
      if (post.author.toString() !== userId.toString()) {
        Notification.create({ recipient: post.author, actor: userId, type: NotificationType.LIKE, post: postId }).then(notif => {
          emitToUser(post.author.toString(), 'new_notification', notif);
        }).catch(() => {});
      }
      res.status(200).json({ success: true, data: { isLiked: true, likesCount: post.likesCount + 1 } });
    }
  } catch (error) {
    console.error('Error toggling like:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// REPOST
// ---------------------------------------------------------------------------
export const repost = async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = String(req.params.id);
    const userId = req.user?._id;

    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    if (!mongoose.isValidObjectId(postId)) { res.status(400).json({ success: false, error: 'Invalid post ID' }); return; }

    const originalPost = await Post.findById(postId).populate('author', 'username displayName avatarUrl');
    if (!originalPost) { res.status(404).json({ success: false, error: 'Post not found' }); return; }

    // Prevent duplicate reposts from the same user
    const existingRepost = await Post.findOne({ author: userId, originalPost: postId, isRepost: true });
    if (existingRepost) {
      res.status(409).json({ success: false, error: 'Already reposted' });
      return;
    }

    const repostDoc = new Post({
      author: userId,
      content: originalPost.content,
      mediaUrls: originalPost.mediaUrls,
      isRepost: true,
      originalPost: postId,
    });

    await repostDoc.save();
    await Post.updateOne({ _id: postId }, { $inc: { repostsCount: 1 } });
    await User.updateOne({ _id: userId }, { $inc: { postsCount: 1 } });

    res.status(201).json({ success: true, data: { repostsCount: originalPost.repostsCount + 1 } });
  } catch (error) {
    console.error('Error reposting:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// ADD COMMENT
// ---------------------------------------------------------------------------
export const addComment = async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = String(req.params.id);
    const userId = req.user?._id;
    const { content } = req.body;

    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    if (!content?.trim()) { res.status(400).json({ success: false, error: 'Comment content is required' }); return; }
    if (!mongoose.isValidObjectId(postId)) { res.status(400).json({ success: false, error: 'Invalid post ID' }); return; }

    const post = await Post.findById(postId);
    if (!post) { res.status(404).json({ success: false, error: 'Post not found' }); return; }

    // Enforce replySetting
    if (post.replySetting === 'following') {
      const isFollowing = await FollowerGraph.findOne({ followerId: post.author, followingId: userId });
      if (!isFollowing && post.author.toString() !== userId.toString()) {
        res.status(403).json({ success: false, error: 'Only people the author follows can reply' });
        return;
      }
    } else if (post.replySetting === 'mentioned') {
      const user = await User.findById(userId);
      if (user && !post.content.includes(`@${user.username}`) && post.author.toString() !== userId.toString()) {
        res.status(403).json({ success: false, error: 'Only people mentioned can reply' });
        return;
      }
    }

    const comment = new Comment({ post: postId, author: userId, content: content.trim() });
    await comment.save();

    await Post.updateOne({ _id: postId }, { $inc: { commentsCount: 1 } });

    const populated = await comment.populate('author', 'username displayName avatarUrl');

    // Create comment notification (non-blocking, skip self-comments)
    if (post.author.toString() !== userId.toString()) {
      Notification.create({ recipient: post.author, actor: userId, type: NotificationType.COMMENT, post: postId }).then(notif => {
        emitToUser(post.author.toString(), 'new_notification', notif);
      }).catch(() => {});
    }

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// GET COMMENTS
// ---------------------------------------------------------------------------
export const getComments = async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = String(req.params.id);

    if (!mongoose.isValidObjectId(postId)) { res.status(400).json({ success: false, error: 'Invalid post ID' }); return; }

    const comments = await Comment.find({ post: postId })
      .populate('author', 'username displayName avatarUrl isVerified')
      .sort({ createdAt: 1 })
      .limit(100);

    res.status(200).json({ success: true, data: comments });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// DELETE POST
// ---------------------------------------------------------------------------
export const deletePost = async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = String(req.params.id);
    const userId = req.user?._id;

    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    if (!mongoose.isValidObjectId(postId)) { res.status(400).json({ success: false, error: 'Invalid post ID' }); return; }

    const post = await Post.findById(postId);
    if (!post) { res.status(404).json({ success: false, error: 'Post not found' }); return; }

    if (post.author.toString() !== userId.toString()) {
      res.status(403).json({ success: false, error: 'You are not authorized to delete this post' });
      return;
    }

    // Delete associated comments
    await Comment.deleteMany({ post: postId });

    // Delete the post
    await Post.findByIdAndDelete(postId);

    // Optional: Decrement user's posts count
    await User.updateOne({ _id: userId }, { $inc: { postsCount: -1 } });

    res.status(200).json({ success: true, message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// VOTE ON POLL
// ---------------------------------------------------------------------------
export const voteOnPoll = async (req: Request, res: Response): Promise<void> => {
  try {
    const postId = String(req.params.id);
    const userId = req.user?._id;
    const { optionIndex } = req.body;

    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    if (!mongoose.isValidObjectId(postId)) { res.status(400).json({ success: false, error: 'Invalid post ID' }); return; }
    if (typeof optionIndex !== 'number') { res.status(400).json({ success: false, error: 'Option index is required' }); return; }

    const post = await Post.findById(postId);
    if (!post) { res.status(404).json({ success: false, error: 'Post not found' }); return; }
    if (!post.poll || !post.poll.options) { res.status(400).json({ success: false, error: 'Post does not have a poll' }); return; }

    const userIdStr = userId.toString();
    if (!post.poll.votedUsers) {
      post.poll.votedUsers = new Map();
    }

    if (post.poll.votedUsers.has(userIdStr)) {
      res.status(400).json({ success: false, error: 'You have already voted on this poll' });
      return;
    }

    if (optionIndex < 0 || optionIndex >= post.poll.options.length) {
      res.status(400).json({ success: false, error: 'Invalid option index' });
      return;
    }

    post.poll.options[optionIndex].votes += 1;
    post.poll.votedUsers.set(userIdStr, optionIndex);

    await post.save();

    res.status(200).json({ success: true, data: post.poll });
  } catch (error) {
    console.error('Error voting on poll:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};
