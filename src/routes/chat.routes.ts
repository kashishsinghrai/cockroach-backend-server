import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import Message from '../models/Message.model';

const router = Router();

// Apply authentication middleware
router.use(authenticate);

// GET /api/chat/:userId - Get chat history with a specific user
router.get('/:userId', async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user?._id;
    const { userId: targetUserId } = req.params;

    if (!currentUserId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    // Fetch messages between current user and target user
    const messages = await Message.find({
      $or: [
        { senderId: currentUserId, receiverId: targetUserId },
        { senderId: targetUserId, receiverId: currentUserId },
      ],
    })
      .sort({ createdAt: -1 }) // Sort by newest first to support pagination/frontend lists
      .limit(200) // Limit to last 200 messages for performance
      .lean();

    res.status(200).json({
      success: true,
      data: messages,
    });
  } catch (error) {
    console.error('[CHAT] Get History Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch chat history' });
  }
});

export default router;
