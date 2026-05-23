import { Request, Response } from 'express';

// POST /api/support/report
export const reportBug = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    const { issue } = req.body;

    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    if (!issue || typeof issue !== 'string' || issue.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Issue description is required' }); return;
    }

    // In a real application, this would save to a BugReports collection or trigger a Jira/Trello integration.
    // For now, we simulate processing the report.
    console.log(`[SUPPORT] Bug report received from user ${userId}: ${issue.slice(0, 100)}...`);

    res.status(200).json({ success: true, message: 'Bug report submitted successfully' });
  } catch (err) {
    console.error('[SUPPORT] reportBug error:', err);
    res.status(500).json({ success: false, error: 'Failed to submit bug report' });
  }
};
