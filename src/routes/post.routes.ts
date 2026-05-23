import { Router } from 'express';
import multer from 'multer';
import {
  createPost,
  getPosts,
  getFeed,
  toggleLike,
  repost,
  addComment,
  getComments,
  getReels,
  deletePost,
} from '../controllers/post.controller';
import { authenticate } from '../middleware/authenticate';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// Following feed — MUST be defined before '/:id' routes to avoid param conflict
router.get('/feed', authenticate, getFeed);

// Global feed (kept for debug/admin)
router.get('/', authenticate, getPosts);

// Reels feed (Global video posts)
router.get('/reels', authenticate, getReels);

// Create post
router.post('/', authenticate, upload.single('media'), createPost);

// Like / Unlike
router.post('/:id/like', authenticate, toggleLike);

// Repost
router.post('/:id/repost', authenticate, repost);

// Comments
router.post('/:id/comments', authenticate, addComment);
router.get('/:id/comments', authenticate, getComments);

// Delete post
router.delete('/:id', authenticate, deletePost);

export default router;
