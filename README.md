# SecureChat Backend – 1-to-1 and group realtime chat

Node.js 20+ · Express 5 · MongoDB (Mongoose) · Socket.IO 4 + Redis adapter · Redis · BullMQ

## Run locally

```bash
npm install
cp .env.example .env        # set MONGO_URI, JWT secrets (see comments)
npm run db:indexes          # build MongoDB indexes once
npm run dev                 # API + socket on http://localhost:4000
npm run create:users        # 2 test users: aman_test / priya_test (password Test@12345)
npm run seed:users          # 5 more: rahul_test, neha_test, amit_test, sohan_test, riya_test (+ a chat with Aman)
npm run seed:avatars        # profile photos (DP) for Priya, Rahul and Neha
npm run test:e2e            # 45 realtime checks with the 2 users (server must be running)
npm run test:groups         # 46 group checks with 5 users over real sockets
npm run seed:groups         # demo groups with a real conversation (re-run replaces them)
npm run test:auth           # 11 checks: mobile / email OTP, Personal / Business profile, search visibility
```

Protected files need `SECURE_UPLOAD_DIR`, `FILE_ENCRYPTION_KEY` (64 hex chars) and `FILE_TOKEN_SECRET`;
`APP_URL` is used to build invite links (`<APP_URL>/group/<code>`).

Redis must be reachable at `REDIS_URL` (on Windows, Memurai works). If `mongodb+srv` fails with
`querySrv ECONNREFUSED`, set `DNS_SERVERS=8.8.8.8,1.1.1.1` (local DNS cannot answer SRV queries).

## Production (VPS)

Live at **https://securechat.candledust.online** (API `/api/v1`, Socket.IO `/socket.io`, web app on `/`,
APK on `/download/SecureChat-latest.apk`).

| Part | Where |
|---|---|
| Code | `/opt/securechat/app` (user `securechat`), `.env` there (mode 600) |
| Service | `systemctl status securechat-api` - port 4100, logs `journalctl -u securechat-api -f` |
| Redis | local `redis-server` (127.0.0.1:6379) |
| Files | `/opt/securechat/data/uploads`, `/opt/securechat/data/secure_uploads` |
| Nginx | `/etc/nginx/sites-available/securechat.candledust.online` (Let's Encrypt SSL) |
| Web app | `/var/www/securechat-web` (Flutter `build/web`) |
| APK | `/var/www/securechat-downloads` |

Update the API after pushing to `main`: `sudo /opt/securechat/deploy.sh`.

## Features (1-to-1)

| Area | What works |
|---|---|
| Auth | One field login: mobile number (10 digit numbers get +91) or email ID -> 6 digit OTP; new accounts then pick Personal (name) or Business (business name, address, bio). Password login kept for test users. Rotating refresh tokens with reuse detection, logout / logout everywhere |
| Messages | Text, emoji, image (auto thumbnail), video, audio, voice note, document, location, contact, sticker |
| Message actions | Reply (quote), forward (up to 5 chats), edit (15 min), delete for me, delete for everyone (60 min), emoji reactions, star |
| Realtime | New / updated / deleted messages, typing and recording indicators, online / last seen, sent → delivered → read ticks, multi-device sync |
| Offline | Messages stored while offline, delivered on reconnect, `?after=` sync, idempotent retries (`clientMsgId`), push-notification queue |
| Chats | List with unread counts and last message, pin (max 5), mute, archive, clear chat, delete chat, search in chat, media / docs / audio / links gallery |
| Privacy | "Anyone can find me" switch (hidden from user search), group location on / off, block / unblock (no messages, typing or presence), hide last seen, disable read receipts, phone / email never exposed |

## Features (groups)

| Area | What works |
|---|---|
| Groups | Create with settings, list filters (all / created / joined / location / muted / archived), stats, edit info, delete (creator), pin / mute / archive, clear chat, leave (ownership passes on) |
| Members | Roles owner / admin / member, promote / demote, restrict, remove, join requests (approve / decline), member profile without phone or email |
| Invites | `XXX-XXXXXX` links with expiry, max joins, approval, revoke, reset; public preview without login |
| Location | Group requirement off / optional / mandatory (join refused without location), No / Join / Live modes with interval and duration, members location (Live / Last shared / Off) respecting admin-only visibility, history (today / 7 / 30 days), clear |
| Messages | All 1-to-1 types, reply, reactions, star, edit, search, media / docs / protected gallery, typing, sent → delivered → read ticks from every member, message info |
| Privacy levels | Public, Private (L2), Highly Protected (L3): L2/L3 files are AES-256-GCM encrypted, opened only through a 30-minute token in the secure viewer, never downloadable; viewer watermark; view once; expiry (1h / 24h / 7d); file permissions and access log |
| Message modes | Everyone / admins only sending, public / private / user-select message mode, members can send media, new-member restriction |
| Forwarding | Forward chain tree with depth, forward details, chain-aware delete for everyone with deletion status |
| Moderation | Server content filter (abuse, numbers, number words, spam, links, personal info, external contact) with warning counter, reports (message / member / group, optional block), my reports, audit log |

## Architecture

```
clients ──► load balancer ──► N × API nodes (Express + Socket.IO, stateless)
                                   │   ▲
                 Redis ◄───────────┘   └── Socket.IO Redis adapter (pub/sub fan-out across nodes)
                 (presence, caches, rate limits, refresh tokens, OTP, BullMQ)
                                   │
                 MongoDB replica set / sharded cluster     BullMQ workers (push notifications)
```

- **Stateless API nodes.** Every node can serve any user. WebSocket-only transport means no sticky sessions.
  `npm run start:cluster` runs one process per CPU; `ecosystem.config.cjs` does the same with PM2.
- **Rooms.** Each socket joins `user:<id>`. A message is emitted to both users' rooms, and the Redis
  adapter delivers it to whichever nodes hold those sockets (multi-device).
- **Presence** is subscription based. A client subscribes only to the users it is showing, so going
  online does not broadcast to every contact. Presence keys carry a TTL that live nodes refresh, so a
  crashed node's users go offline automatically.
- **Hot paths use Redis, not Mongo.** Conversation participants, public profiles and block lists are
  cached, and rate limits (per IP and per user per socket event) are Redis counters shared by all nodes.
- **MongoDB layout.** `messages` is ordered by `_id` with `{conversation, _id}` cursor pagination.
  `conversationmembers` holds per-user state (unread, pin, mute, archive, cleared), so the chat list is a
  single indexed query. There is one unique `pairKey` per pair of users, so concurrent "start chat"
  requests can't create duplicates. Suggested shard keys are in the model files.
- **Idempotency.** Unique `(sender, clientMsgId)`: a retried send returns the stored message instead of
  creating a duplicate.
- **Media.** Files are stored on local disk behind `/uploads` (image thumbnails via sharp). HTML, SVG and
  script uploads are rejected, and non-media files are served as attachments. In production, swap
  in S3/GCS + CDN in `modules/media`; the response shape stays the same.

### Scaling checklist for ~1M users
1. Run 3+ API nodes behind the load balancer (≈20–50k sockets per node, depending on hardware); raise `ulimit -n`.
2. Use a MongoDB replica set (sharded for message volume: `messages` on `{conversation: 'hashed'}`).
3. Use Redis with replicas/Sentinel (or Redis Cluster with `createShardedAdapter`).
4. Run workers separately: `RUN_WORKERS=false` on API nodes, plus `npm run worker`.
5. Serve media from object storage + CDN; set `NODE_ENV=production` (indexes via `npm run db:indexes`).
6. Plug an SMS provider into `auth.service.requestOtp` and FCM/APNs into `workers/push.worker.js`.

## REST API (`/api/v1`, Bearer token)

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` · `/auth/login` · `/auth/otp/request` · `/auth/otp/verify` · `/auth/refresh` · `/auth/logout` | Auth |
| GET / PATCH | `/users/me` | Own profile, privacy |
| POST | `/users/me/devices` | Register push token |
| GET | `/users/search?q=` · `/users/:id` · `/users/presence?ids=` · `/users/blocked` | People |
| POST / DELETE | `/users/:id/block` | Block / unblock |
| POST | `/conversations` `{userId}` | Open (or get) a chat |
| GET | `/conversations?archived=&cursor=` · `/conversations/unread` · `/conversations/:id` | Chat list |
| PATCH | `/conversations/:id` `{pinned, archived, muteSeconds}` | Settings |
| POST / DELETE | `/conversations/:id/clear` · `/conversations/:id` | Clear / delete chat |
| GET | `/conversations/:id/messages?before=&after=&limit=` | History / sync |
| GET | `/conversations/:id/search?q=` · `/conversations/:id/media?kind=media\|docs\|audio\|links` | Search, gallery |
| POST | `/conversations/:id/messages` · `/conversations/:id/read` | REST fallback for send / read |
| GET | `/messages/starred` · `/messages/:id/info` | Starred, receipts |
| PATCH / DELETE | `/messages/:id` · `/messages/:id?scope=me\|everyone` | Edit / delete |
| POST | `/messages/:id/reactions` · `/messages/:id/star` · `/messages/:id/forward` | Actions |
| POST | `/media/upload` (multipart `file`, `kind?`, `duration?`) | Upload → media object |

Every response is `{ ok: true, data }` or `{ ok: false, error: { code, message, details } }`.

## Socket.IO (`auth: { token }`, transport `websocket`)

Client → server (all with ack `{ok, data | error}`): `message:send`, `message:edit`, `message:delete`,
`message:react`, `message:star`, `message:forward`, `message:delivered`, `conversation:read`, `typing`,
`presence:subscribe`, `presence:unsubscribe`.

Server → client: `ready`, `message:new`, `message:updated`, `message:removed`, `message:status`,
`typing`, `presence`, `conversation:updated`, `conversation:read`, `conversation:cleared`,
`conversation:removed`, `user:updated`, `user:blocked`.
