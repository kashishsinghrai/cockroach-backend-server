import { Router } from 'express';
import { getNotifications, getUnreadCount, markAsRead } from '../controllers/notification.controller';
import { authenticate } from '../middleware/authenticate';

const router = Router();

router.get('/', authenticate, getNotifications);
router.get('/unread-count', authenticate, getUnreadCount);
router.put('/:id/read', authenticate, markAsRead);

export default router;
