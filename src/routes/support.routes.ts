import { Router } from 'express';
import { reportBug } from '../controllers/support.controller';
import { authenticate } from '../middleware/authenticate';

const router = Router();

// POST /api/support/report
router.post('/report', authenticate, reportBug);

export default router;
