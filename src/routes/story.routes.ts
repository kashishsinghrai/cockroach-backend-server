import { Router } from 'express';
import { createStory, getFeedStories, markStoryAsViewed, getStoryViewers } from '../controllers/story.controller';
import { authenticate } from '../middleware/authenticate';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Upload a new story
router.post('/', authenticate, upload.single('media'), createStory);

// Get grouped stories from followed users
router.get('/feed', authenticate, getFeedStories);

// Story Views
router.post('/:id/view', authenticate, markStoryAsViewed);
router.get('/:id/viewers', authenticate, getStoryViewers);

export default router;
