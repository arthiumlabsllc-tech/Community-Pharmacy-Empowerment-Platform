import { Router, Request, Response } from 'express';
import { upload } from '../middleware/upload.middleware';
import { authenticate } from '../middleware/auth.middleware';
import logger from '../utils/logger';

const router = Router();
router.use(authenticate);

// ============ UPLOAD PRESCRIPTION IMAGE ============
router.post('/prescription', upload.single('file'), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;

    // In production, upload to S3 instead:
    // const s3Url = await s3Service.upload(req.file);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        url: fileUrl,
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });
  } catch (error) {
    logger.error('File upload failed', error);
    res.status(500).json({ success: false, message: 'File upload failed' });
  }
});

// ============ UPLOAD CSV FOR BULK IMPORT ============
router.post('/bulk-import', upload.single('file'), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    if (!['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Only CSV and Excel files are supported' });
    }

    res.json({
      success: true,
      message: 'File ready for processing',
      data: {
        path: req.file.path,
        filename: req.file.filename,
        size: req.file.size,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// ============ UPLOAD PHARMACY LOGO ============
router.post('/logo', upload.single('file'), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Only image files are supported' });
    }

    res.json({
      success: true,
      data: { url: `/uploads/${req.file.filename}` },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Logo upload failed' });
  }
});

export default router;
