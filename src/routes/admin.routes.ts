import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import { isAdmin } from '../middleware/isAdmin';
import { User } from '../models/User.model';
import Post from '../models/Post.model';
import { Settings } from '../models/Settings.model';
import Story from '../models/story.model';
import Notification from '../models/Notification.model';
import FollowerGraph from '../models/FollowerGraph.model';
import Comment from '../models/Comment.model';

const router = Router();

// Apply middlewares to all admin routes
router.use(authenticate, isAdmin);

// GET /api/admin/dashboard
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalPosts = await Post.countDocuments();
    const totalReels = await Post.countDocuments({ mediaType: 'video' });
    const verifiedUsers = await User.countDocuments({ isVerified: true });

    res.status(200).json({
      success: true,
      data: {
        totalUsers,
        totalPosts,
        totalReels,
        verifiedUsers,
      },
    });
  } catch (error) {
    console.error('[ADMIN] Dashboard Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/admin/users
router.get('/users', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const users = await User.find({ role: { $ne: 'admin' } })
      .select('-passwordHash -sessions -rateLimitLogs')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments({ role: { $ne: 'admin' } });

    res.status(200).json({
      success: true,
      data: {
        users,
        pagination: {
          total,
          page,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[ADMIN] Get Users Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/admin/users/:id/verify
router.put('/users/:id/verify', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isVerified } = req.body;

    // We can't return without res.status if there's an error. Fixed TypeScript types by adding return to res.status.
    const user = await User.findByIdAndUpdate(
      id,
      { isVerified },
      { new: true }
    ).select('-passwordHash -sessions -rateLimitLogs');

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error('[ADMIN] Verify User Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/admin/posts
router.get('/posts', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const posts = await Post.find()
      .populate('author', 'username displayName avatarUrl isVerified')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Post.countDocuments();

    res.status(200).json({
      success: true,
      data: {
        posts,
        pagination: {
          total,
          page,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[ADMIN] Get Posts Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/admin/posts/:id
router.delete('/posts/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const post = await Post.findByIdAndDelete(id);

    if (!post) {
      res.status(404).json({ success: false, error: 'Post not found' });
      return;
    }

    // Decrement user's postsCount
    await User.findByIdAndUpdate(post.author, { $inc: { postsCount: -1 } });

    res.status(200).json({
      success: true,
      message: 'Post deleted successfully',
    });
  } catch (error) {
    console.error('[ADMIN] Delete Post Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/admin/settings
router.put('/settings', async (req: Request, res: Response) => {
  try {
    const { isScreenProtectorEnabled } = req.body;
    let settings = await Settings.findOne();
    if (!settings) {
      settings = new Settings();
    }
    
    if (typeof isScreenProtectorEnabled === 'boolean') {
      settings.isScreenProtectorEnabled = isScreenProtectorEnabled;
    }
    
    await settings.save();
    
    res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (error) {
    console.error('[ADMIN] Update Settings Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/admin/create-admin
router.post('/create-admin', async (req: Request, res: Response) => {
  try {
    const { username, email, password, displayName } = req.body;
    
    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      res.status(400).json({ success: false, error: 'User with this email or username already exists' });
      return;
    }

    const newAdmin = new User({
      username,
      email,
      passwordHash: password, // Pre-save hook will hash this using Argon2
      displayName,
      gender: 'other', // Default or require in body, setting default here
      role: 'admin',
      isVerified: true, // Admins can be verified by default
    });

    await newAdmin.save();

    res.status(201).json({
      success: true,
      message: 'Admin created successfully',
      data: {
        id: newAdmin._id,
        username: newAdmin.username,
        email: newAdmin.email,
      }
    });
  } catch (error) {
    console.error('[ADMIN] Create Admin Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const user = await User.findById(id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Cascading Delete
    await Promise.all([
      Post.deleteMany({ author: id }),
      Story.deleteMany({ author: id }),
      Comment.deleteMany({ author: id }),
      Notification.deleteMany({ $or: [{ recipient: id }, { sender: id }] }),
      FollowerGraph.deleteMany({ $or: [{ followerId: id }, { followingId: id }] }),
    ]);

    await User.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'User and all associated data deleted successfully',
    });
  } catch (error) {
    console.error('[ADMIN] Delete User Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
