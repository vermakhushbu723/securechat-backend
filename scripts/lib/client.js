/** Tiny API + socket client used by the scripts (same contract as the Flutter app). */
import { io } from 'socket.io-client';

export const BASE_URL = process.env.API_URL ?? 'http://localhost:4000';

export const TEST_USERS = [
  { name: 'Aman Verma', username: 'aman_test', phone: '+919000000001', password: 'Test@12345' },
  { name: 'Priya Sharma', username: 'priya_test', phone: '+919000000002', password: 'Test@12345' },
];

export async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${json.error?.code}: ${json.error?.message}`);
    err.status = res.status;
    err.code = json.error?.code;
    err.details = json.error?.details;
    throw err;
  }
  return json.data;
}

/** Logs in, or registers the user first when it does not exist yet. */
export async function loginOrRegister(u) {
  try {
    return await api('POST', '/auth/login', { body: { identifier: u.username, password: u.password } });
  } catch (err) {
    if (err.status !== 401) throw err;
    return api('POST', '/auth/register', { body: u });
  }
}

export function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, { transports: ['websocket'], auth: { token }, reconnection: false });
    socket.once('ready', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/** Emits with ack and unwraps `{ ok, data, error }`. */
export function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(10_000).emit(event, payload, (err, res) => {
      if (err) return reject(err);
      if (!res.ok) {
        const e = new Error(`${event}: ${res.error.code} ${res.error.message}`);
        e.code = res.error.code;
        e.details = res.error.details;
        return reject(e);
      }
      resolve(res.data);
    });
  });
}

/** Resolves with the first `event` payload that matches `predicate`. */
export function waitFor(socket, event, predicate = () => true, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function listener(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    }
    socket.on(event, listener);
  });
}

/** Resolves true if no matching event arrives within `ms`. */
export function expectNoEvent(socket, event, predicate = () => true, ms = 1_200) {
  return waitFor(socket, event, predicate, ms).then(
    () => false,
    () => true,
  );
}

export const clientId = () => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
