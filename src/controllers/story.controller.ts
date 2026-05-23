import { Request, Response } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Story from '../models/story.model';
import FollowerGraph from '../models/FollowerGraph.model';
import { User } from '../models/User.model';
import mongoose from 'mongoose';
import { cacheUtil } from '../utils/cache';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const withTimeout = <T>(promise: Promise<T>, ms: number = 10000): Promise<T> => {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('S3 Operation timed out')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

export const createStory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    const authorGender = req.user?.gender;
    if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

    if (!req.file) {
      res.status(400).json({ message: 'Story requires an image or video.' });
      return;
    }

    const file = req.file;
    const bucketName = process.env.AWS_S3_BUCKET_NAME || 'cockroach-app-bucket';
    const uniqueFilename = `stories/${Date.now()}-${Math.round(Math.random() * 1E9)}-${file.originalname}`;

    await withTimeout(s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: uniqueFilename,
      Body: file.buffer,
      ContentType: file.mimetype,
    })), 300000); // 5 minutes timeout for video uploads

    const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${uniqueFilename}`;
    const mediaType = file.mimetype.startsWith('video/') ? 'video' : 'image';

    // 12 hours from now
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

    const newStory = new Story({
      author: userId,
      authorGender,
      mediaUrl: s3Url,
      mediaType,
      expiresAt,
    });

    await newStory.save();

    await newStory.populate('author', 'username displayName avatarUrl isVerified');

    res.status(201).json(newStory);
  } catch (error) {
    console.error('Error creating story:', error);
    res.status(500).json({ message: 'Failed to create story', error: (error as Error).message });
  }
};

export const getFeedStories = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

    const cacheKey = `stories_${userId}`;
    const cachedData = cacheUtil.get(cacheKey);
    if (cachedData) {
      res.status(200).json(cachedData);
      return;
    }

    // 1. Get IDs of users the current user is following
    const followingGraph = await FollowerGraph.find({ followerId: userId }).select('followingId').lean();
    const followingIds = followingGraph.map((g: any) => g.followingId);

    // Also include the user's own stories
    followingIds.push(new mongoose.Types.ObjectId(userId));

    // 2. Fetch active stories for these users
    const query: any = {
      author: { $in: followingIds },
      expiresAt: { $gt: new Date() }
    };
    
    // Community filtering
    if (req.user?.communityPreference && req.user.communityPreference !== 'everyone') {
      query.authorGender = req.user.communityPreference;
    }

    const stories = await Story.find(query)
    .populate('author', 'username displayName avatarUrl isVerified')
    .sort({ createdAt: 1 })
    .lean(); // Oldest active story first

    // 3. Group stories by author
    const groupedStories: Record<string, any> = {};
    
    for (const story of stories) {
      const authorId = (story.author as any)._id.toString();
      if (!groupedStories[authorId]) {
        groupedStories[authorId] = {
          author: story.author,
          stories: []
        };
      }
      groupedStories[authorId].stories.push({
        _id: story._id,
        mediaUrl: story.mediaUrl,
        mediaType: story.mediaType,
        viewers: story.viewers,
        createdAt: story.createdAt,
        expiresAt: story.expiresAt
      });
    }

    // Convert to array and put the current user's stories first if any exist
    const result = Object.values(groupedStories).sort((a, b) => {
      const isAOwner = a.author._id.toString() === userId.toString();
      const isBOwner = b.author._id.toString() === userId.toString();
      if (isAOwner) return -1;
      if (isBOwner) return 1;
      return 0; // Otherwise preserve order (or could sort by newest story)
    });

    // Cache for 30 seconds
    cacheUtil.set(cacheKey, result, 30);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching feed stories:', error);
    res.status(500).json({ message: 'Failed to fetch stories' });
  }
};

export const markStoryAsViewed = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    const storyId = req.params.id;
    
    if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

    await Story.findByIdAndUpdate(storyId, {
      $addToSet: { viewers: userId }
    });

    res.status(200).json({ message: 'Story marked as viewed' });
  } catch (error) {
    console.error('Error marking story as viewed:', error);
    res.status(500).json({ message: 'Failed to mark story as viewed' });
  }
};

export const getStoryViewers = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    const storyId = req.params.id;

    if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

    const story = await Story.findById(storyId).populate('viewers', 'username displayName avatarUrl');
    
    if (!story) {
      res.status(404).json({ message: 'Story not found' });
      return;
    }

    if (story.author.toString() !== userId.toString()) {
      res.status(403).json({ message: 'You can only see viewers of your own stories' });
      return;
    }

    res.status(200).json({ viewers: story.viewers });
  } catch (error) {
    console.error('Error fetching story viewers:', error);
    res.status(500).json({ message: 'Failed to fetch story viewers' });
  }
};

export const getUserStories = async (req: Request, res: Response): Promise<void> => {
  try {
    const targetUserId = req.params.userId;
    
    // Fetch active stories for this specific user
    const stories = await Story.find({
      author: targetUserId,
      expiresAt: { $gt: new Date() }
    })
    .populate('author', 'username displayName avatarUrl isVerified')
    .sort({ createdAt: 1 })
    .lean();
    
    res.status(200).json({ stories });
  } catch (error) {
    console.error('Error fetching user stories:', error);
    res.status(500).json({ message: 'Failed to fetch user stories' });
  }
};

export const deleteStory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    const storyId = req.params.id;

    if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

    const story = await Story.findById(storyId);
    
    if (!story) {
      res.status(404).json({ message: 'Story not found' });
      return;
    }

    if (story.author.toString() !== userId.toString()) {
      res.status(403).json({ message: 'You can only delete your own stories' });
      return;
    }

    await Story.findByIdAndDelete(storyId);
    res.status(200).json({ success: true, message: 'Story deleted' });
  } catch (error) {
    console.error('Error deleting story:', error);
    res.status(500).json({ message: 'Failed to delete story' });
  }
};
