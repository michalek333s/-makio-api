import { Router } from 'express';
import { createZoomMeeting, isZoomConfigured } from '../services/zoom.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json({ configured: isZoomConfigured() });
});

router.post('/meeting', async (req, res, next) => {
  try {
    if (!isZoomConfigured()) {
      return res.status(503).json({
        error: 'Zoom není nakonfigurován. V nemio-backend/.env doplňte ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET a ZOOM_USER_EMAIL.',
      });
    }

    const { topic, dateIso, time, durationMinutes } = req.body || {};
    const result = await createZoomMeeting({
      topic,
      dateIso,
      time,
      durationMinutes,
    });

    res.json({
      joinUrl: result.joinUrl,
      meetingId: result.meetingId,
      startUrl: result.startUrl,
      password: result.password,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
