/** Builds / syncs all MongoDB indexes (production boots with autoIndex=false). */
import { connectMongo, disconnectMongo } from '../src/db/mongo.js';
import { closeRedis } from '../src/db/redis.js';
import { Conversation } from '../src/modules/chat/conversation.model.js';
import { ConversationMember } from '../src/modules/chat/conversationMember.model.js';
import { Message } from '../src/modules/chat/message.model.js';
import { Block } from '../src/modules/users/block.model.js';
import { User } from '../src/modules/users/user.model.js';
import { AuditLog } from '../src/modules/audit/audit.service.js';
import { FileAccessLog, SecureFile } from '../src/modules/files/secureFile.model.js';
import { Group, GroupMember, InviteLink } from '../src/modules/groups/group.model.js';
import { GroupMessage } from '../src/modules/groups/groupMessage.model.js';
import { LocationHistory } from '../src/modules/location/location.model.js';
import { PlatformSetting } from '../src/modules/platform/platform.service.js';
import { Report } from '../src/modules/reports/report.model.js';

await connectMongo();
for (const model of [
  User,
  Block,
  Conversation,
  ConversationMember,
  Message,
  Group,
  GroupMember,
  InviteLink,
  GroupMessage,
  SecureFile,
  FileAccessLog,
  LocationHistory,
  Report,
  AuditLog,
  PlatformSetting,
]) {
  const dropped = await model.syncIndexes();
  console.log(`${model.modelName}: indexes synced`, dropped.length ? `(dropped ${dropped.join(', ')})` : '');
}
await disconnectMongo();
await closeRedis();
