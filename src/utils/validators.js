import mongoose from 'mongoose';
import { z } from 'zod';

export const objectId = z.string().refine((v) => mongoose.isValidObjectId(v) && /^[a-f\d]{24}$/i.test(v), {
  message: 'Invalid id',
});

export const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
