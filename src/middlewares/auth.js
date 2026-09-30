import { getAccess } from '../modules/subscription/subscription.service.js';
import { ApiError } from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/jwt.js';

export async function requireAuth(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized();
  const payload = verifyAccessToken(token);
  // Blocked / suspended / deleted by the admin: the short lived access token stops working too (cached check).
  const access = await getAccess(payload.sub).catch(() => null);
  if (!access) throw ApiError.unauthorized('Account not available');
  if (access.accountState !== 'active') throw ApiError.forbidden('Your account is not active. Contact support.', 'ACCOUNT_BLOCKED');
  req.user = { id: payload.sub };
  next();
}
