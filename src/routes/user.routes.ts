import { Router } from 'express';
import multer from 'multer';
import { getUserProfile, getUserPosts, toggleFollow, updateProfile, updateSettings, getSettings, getFollowers, getFollowing, deleteAccount, verifyRequest, getBlockedUsers, unblockUser, getMutuals } from '../controllers/user.controller';
import { authenticate } from '../middleware/authenticate';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB avatar
});

// PUT /api/users/profile — update own profile (must be before /:username)
router.put('/profile', authenticate, upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]), updateProfile);

// GET /api/users/settings - get preferences
router.get('/settings', authenticate, getSettings);

// PUT /api/users/settings - update preferences
router.put('/settings', authenticate, updateSettings);

// GET /api/users/inbox/mutuals
router.get('/inbox/mutuals', authenticate, getMutuals);

// GET /api/users/:username
router.get('/:username', authenticate, getUserProfile);

// GET /api/users/:username/posts
router.get('/:username/posts', authenticate, getUserPosts);

// GET /api/users/:username/followers
router.get('/:username/followers', authenticate, getFollowers);

// GET /api/users/:username/following
router.get('/:username/following', authenticate, getFollowing);

// POST /api/users/:username/follow
router.post('/:username/follow', authenticate, toggleFollow);

// DELETE /api/users/account
router.delete('/account', authenticate, deleteAccount);

// POST /api/users/verify-request
router.post('/verify-request', authenticate, verifyRequest);

// GET /api/users/blocked
router.get('/blocked', authenticate, getBlockedUsers);

// POST /api/users/unblock/:id
router.post('/unblock/:id', authenticate, unblockUser);

export default router;
