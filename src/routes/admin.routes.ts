import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import { isAdmin } from '../middleware/isAdmin';
import { User } from '../models/User.model';
import Post from '../models/Post.model';

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

export default router;
