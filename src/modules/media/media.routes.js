import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { limiters, rateLimit } from '../../middlewares/rateLimit.js';
import { ApiError } from '../../utils/ApiError.js';
import { storeEncrypted } from '../files/file.service.js';

export const UPLOAD_ROOT = path.resolve(env.UPLOAD_DIR);

// Types that could execute in a browser when served from our origin.
const BLOCKED_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.js', '.mjs', '.exe', '.bat', '.cmd', '.sh', '.php']);
const BLOCKED_MIME = /^(text\/html|application\/xhtml|image\/svg|application\/(x-)?javascript|text\/javascript)/i;

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const now = new Date();
    const rel = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
    const dir = path.join(UPLOAD_ROOT, rel);
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXT.has(ext) || BLOCKED_MIME.test(file.mimetype)) {
      return cb(ApiError.badRequest('This file type is not allowed'));
    }
    cb(null, true);
  },
});

const toPublicPath = (abs) => `/uploads/${path.relative(UPLOAD_ROOT, abs).split(path.sep).join('/')}`;

function kindOf(mime, requested) {
  if (requested === 'voice') return 'voice';
  if (requested === 'sticker') return 'sticker';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const bodySchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'voice', 'file', 'sticker']).optional(),
  duration: z.coerce.number().nonnegative().max(86_400).optional(),
  // true = Private / Highly Protected content: encrypted, no public URL, secure viewer only.
  secure: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const router = Router();

/**
 * multipart/form-data: file=<binary>, kind?=voice|..., duration?=seconds
 * Returns a media object to pass as `media` in `message:send`.
 * Swap disk storage for S3 / GCS + CDN in production (same response shape).
 */
router.post('/upload', rateLimit(limiters.upload), upload.single('file'), async (req, res) => {
  if (!req.file) throw ApiError.badRequest('file is required');
  const { kind: requested, duration, secure } = bodySchema.parse(req.body ?? {});
  const file = req.file;
  const kind = kindOf(file.mimetype, requested);

  if (secure) {
    let dims = {};
    if (kind === 'image') {
      const meta = await sharp(file.path).metadata().catch(() => null);
      if (!meta) {
        await fs.promises.unlink(file.path).catch(() => {});
        throw ApiError.badRequest('Invalid image file');
      }
      dims = { width: meta.width, height: meta.height };
    }
    const stored = await storeEncrypted(file.path, {
      owner: req.user.id,
      name: file.originalname.slice(0, 255),
      mimeType: file.mimetype,
      kind: kind === 'sticker' ? 'image' : kind,
      size: file.size,
      duration,
      ...dims,
    });
    return res.status(201).json({
      ok: true,
      data: {
        kind,
        secure: true,
        secureFileId: String(stored._id),
        url: null,
        thumbUrl: null,
        mimeType: stored.mimeType,
        name: stored.name,
        size: stored.size,
        width: stored.width ?? null,
        height: stored.height ?? null,
        duration: stored.duration ?? null,
      },
    });
  }

  const media = {
    kind,
    url: toPublicPath(file.path),
    thumbUrl: null,
    mimeType: file.mimetype,
    name: file.originalname.slice(0, 255),
    size: file.size,
    width: null,
    height: null,
    duration: duration ?? null,
  };

  if (kind === 'image' || kind === 'sticker') {
    try {
      const image = sharp(file.path, { failOn: 'error' });
      const meta = await image.metadata();
      media.width = meta.width ?? null;
      media.height = meta.height ?? null;
      const thumbPath = file.path.replace(/(\.[a-z0-9]+)?$/i, '_thumb.webp');
      await image.rotate().resize({ width: 400, withoutEnlargement: true }).webp({ quality: 70 }).toFile(thumbPath);
      media.thumbUrl = toPublicPath(thumbPath);
    } catch (err) {
      await fs.promises.unlink(file.path).catch(() => {});
      logger.warn({ err: err.message }, 'Rejected invalid image upload');
      throw ApiError.badRequest('Invalid image file');
    }
  }

  res.status(201).json({ ok: true, data: media });
});

export default router;
