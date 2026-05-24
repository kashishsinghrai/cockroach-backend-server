import { Router, Request, Response } from 'express';
import { Settings } from '../models/Settings.model';

const router = Router();

// GET /api/settings
router.get('/', async (req: Request, res: Response) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({});
    }

    res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (error) {
    console.error('[SETTINGS] Get Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
