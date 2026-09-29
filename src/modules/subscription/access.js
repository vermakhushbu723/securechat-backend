/**
 * Access rules
 *  - every account: 7 day free trial from signup
 *  - premium: bought plan (premiumUntil)
 *  - extended: extension approved by the platform admin (extendedUntil)
 *  - locked: none of the above -> can read, cannot send or open protected files
 * A locked member may still reply / open protected files in a group when the
 * group is premium (creator has premium or the admin approved the group) AND
 * the creator enabled "members without premium can use this group".
 */
export const TRIAL_DAYS = 7;
const DAY = 86_400_000;

export function accessOf(u, now = Date.now()) {
  const s = u?.subscription ?? {};
  // Admin can shorten / lengthen one user's trial (subscription.trialEndsAt), otherwise 7 days from signup.
  const trialEndsAt = s.trialEndsAt ? new Date(s.trialEndsAt) : new Date(new Date(u?.createdAt ?? now).getTime() + TRIAL_DAYS * DAY);
  const premiumUntil = s.premiumUntil ? new Date(s.premiumUntil) : null;
  const extendedUntil = s.extendedUntil ? new Date(s.extendedUntil) : null;
  let access = 'locked';
  let until = null;
  if (premiumUntil && premiumUntil.getTime() > now) [access, until] = ['premium', premiumUntil];
  else if (extendedUntil && extendedUntil.getTime() > now) [access, until] = ['extended', extendedUntil];
  else if (s.trialPending) access = 'unclaimed'; // new account: trial not claimed yet
  else if (trialEndsAt.getTime() > now) [access, until] = ['trial', trialEndsAt];
  return {
    access,
    active: access !== 'locked',
    paid: access === 'premium' || access === 'extended',
    until,
    daysLeft: until ? Math.max(0, Math.ceil((until.getTime() - now) / DAY)) : 0,
    trialDays: TRIAL_DAYS,
    trialEndsAt: s.trialPending ? null : trialEndsAt,
    canClaimTrial: Boolean(s.trialPending),
    premiumUntil,
    extendedUntil,
  };
}

