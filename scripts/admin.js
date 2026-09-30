/**
 * Platform admin tasks (run on the server):
 *   node scripts/admin.js staff <email> <password> [name] [role]   admin panel account
 *   node scripts/admin.js migrate                         search tokens + one time 7 day grace for expired trials
 *   node scripts/admin.js premium  <user> <days>          user = id, mobile number, email or username (0 days removes)
 *   node scripts/admin.js extend   <user> <days>          admin approved extension
 *   node scripts/admin.js trial    <user> <days>          trial ends in <days> (0 = ends now)
 *   node scripts/admin.js status   <user>
 *   node scripts/admin.js group-premium <groupId|inviteCode> on|off [days]
 *   node scripts/admin.js requests                        pending extension / premium requests
 *   node scripts/admin.js approve <requestId> [days] | reject <requestId>
 */
import { connectMongo, disconnectMongo } from '../src/db/mongo.js';
import { closeRedis } from '../src/db/redis.js';
import { hashPassword } from '../src/modules/admin/admin.auth.js';
import { Staff } from '../src/modules/admin/admin.models.js';
import { normalizeIdentifier } from '../src/modules/auth/identifier.js';
import { setGroupPremium } from '../src/modules/subscription/subscription.routes.js';
import * as sub from '../src/modules/subscription/subscription.service.js';
import { searchTokensOf, User } from '../src/modules/users/user.model.js';

const [cmd, ...args] = process.argv.slice(2);

async function userId(ref) {
  if (!ref) throw new Error('user is required');
  if (/^[a-f0-9]{24}$/i.test(ref)) return ref;
  const id = normalizeIdentifier(ref);
  const u = await User.findOne(id ? { [id.kind]: id.value } : { username: ref.toLowerCase() }).select('_id name').lean();
  if (!u) throw new Error(`User not found: ${ref}`);
  return String(u._id);
}

const show = (a) => `${a.access}${a.until ? ` until ${new Date(a.until).toISOString().slice(0, 10)}` : ''} (${a.daysLeft} days left)`;

await connectMongo();
try {
  switch (cmd) {
    case 'migrate': {
      let tokens = 0;
      for await (const u of User.find({}).select('name username searchTokens').lean().cursor()) {
        const next = searchTokensOf(u.name, u.username);
        if (JSON.stringify(next) !== JSON.stringify(u.searchTokens ?? [])) {
          await User.updateOne({ _id: u._id }, { $set: { searchTokens: next } });
          tokens++;
        }
      }
      // Accounts whose trial already ended before plans existed get 7 days once.
      const cutoff = new Date(Date.now() - sub.TRIAL_DAYS * 86_400_000);
      const grace = new Date(Date.now() + 7 * 86_400_000);
      const r = await User.updateMany(
        {
          createdAt: { $lt: cutoff },
          'subscription.graceAt': null,
          $and: [
            { $or: [{ 'subscription.premiumUntil': null }, { 'subscription.premiumUntil': { $lt: new Date() } }] },
            { $or: [{ 'subscription.extendedUntil': null }, { 'subscription.extendedUntil': { $lt: new Date() } }] },
          ],
        },
        { $set: { 'subscription.extendedUntil': grace, 'subscription.graceAt': new Date() } },
      );
      console.log(`search tokens updated: ${tokens}, grace extension given: ${r.modifiedCount}`);
      break;
    }
    case 'premium':
    case 'extend': {
      const uid = await userId(args[0]);
      const days = Number(args[1] ?? 30);
      const a = await (cmd === 'premium' ? sub.grantPremium : sub.grantExtension)(uid, days);
      console.log(`${args[0]}: ${show(a)}`);
      break;
    }
    case 'trial': {
      const a = await sub.setTrial(await userId(args[0]), Number(args[1] ?? 0));
      console.log(`${args[0]}: ${show(a)}`);
      break;
    }
    case 'status': {
      const a = await sub.getAccess(await userId(args[0]));
      console.log(`${args[0]}: ${show(a)}`);
      break;
    }
    case 'group-premium': {
      const r = await setGroupPremium(args[0], args[1] !== 'off', args[2] ? Number(args[2]) : undefined);
      console.log(`${r.name}: premium ${r.premium.approved ? 'approved' : 'removed'}${r.premium.approvedUntil ? ` until ${r.premium.approvedUntil.toISOString().slice(0, 10)}` : ''}`);
      break;
    }
    case 'requests': {
      const rows = await sub.pendingRequests();
      if (!rows.length) console.log('No pending requests');
      for (const r of rows) console.log(`${r.id}  ${r.kind}  ${r.days}d  ${r.user.name} (${r.user.phone ?? r.user.email})  "${r.reason}"`);
      break;
    }
    case 'approve':
    case 'reject': {
      const r = await sub.decideRequest(args[0], cmd === 'approve', args[1] ? Number(args[1]) : undefined);
      console.log(`${r.id}: ${r.status}`);
      break;
    }
    case 'staff': {
      // Admin panel login: node scripts/admin.js staff <email> <password> [name] [super_admin|moderator|support]
      const [email, password, name = 'Super Admin', role = 'super_admin'] = args;
      if (!email || !password || password.length < 8) throw new Error('Usage: staff <email> <password (8+ chars)> [name] [role]');
      const passwordHash = await hashPassword(password);
      const s = await Staff.findOneAndUpdate(
        { email: email.toLowerCase() },
        { $set: { name, role, passwordHash, status: 'active' }, $inc: { tokenVersion: 1 } },
        { upsert: true, returnDocument: 'after', lean: true },
      );
      console.log(`Staff ${s.email} (${s.role}) ready - sign in at /admin`);
      break;
    }
    default:
      console.log('Commands: staff <email> <password> [name] [role] | migrate | premium <user> <days> | extend <user> <days> | status <user> | group-premium <group> on|off [days] | requests | approve <id> [days] | reject <id>');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await disconnectMongo();
  await closeRedis();
}
