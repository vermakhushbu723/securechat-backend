/**
 * One-time (safe to run again):
 *  1. Invite links whose code has digits get a letters-only code. The old code is kept as
 *     legacyCode, so links already shared still open the group.
 *  2. Groups that use location: members without a position get their last known one.
 *   node scripts/migrate-invite-location.js
 */
import { randomInt } from 'node:crypto';

import { connectMongo, disconnectMongo } from '../src/db/mongo.js';
import { closeRedis } from '../src/db/redis.js';
import { Group, InviteLink } from '../src/modules/groups/group.model.js';
import { seedMemberLocations } from '../src/modules/location/location.service.js';

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

await connectMongo();
let codes = 0;
for (const link of await InviteLink.find({ code: /\d/, legacyCode: { $exists: false } }).lean()) {
  const prefix = link.code.split('-')[0].replace(/[^A-Z]/g, '').padEnd(3, 'G').slice(0, 3);
  for (let attempt = 0; attempt < 5; attempt++) {
    let rand = '';
    for (let i = 0; i < 7; i++) rand += LETTERS[randomInt(LETTERS.length)];
    try {
      await InviteLink.updateOne({ _id: link._id }, { $set: { code: `${prefix}-${rand}`, legacyCode: link.code } });
      codes++;
      break;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
}
console.log(`invite codes changed to letters only: ${codes}`);

let seeded = 0;
for (const g of await Group.find({ status: 'active', 'settings.location.requirement': { $ne: 'off' } }).select('_id').lean()) {
  seeded += await seedMemberLocations(g._id);
}
console.log(`member locations filled from last known position: ${seeded}`);

await disconnectMongo();
await closeRedis();
