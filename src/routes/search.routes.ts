import { Router } from 'express';
import { searchUsers, getTrending } from '../controllers/search.controller';
import { authenticate } from '../middleware/authenticate';

const router = Router();

// GET /api/search/users?query=
router.get('/users', authenticate, searchUsers);

// GET /api/search/trending
router.get('/trending', authenticate, getTrending);

export default router;
