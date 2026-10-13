import siftModule from 'sift';

const sift = siftModule.default ?? siftModule;
const { createEqualsOperation } = siftModule;

import { isObjectId, isPlainObject } from './filter.js';

/**
 * In-memory MongoDB semantics, used where SQL alone is not enough:
 *  - `matches(filter)`: the JS check for conditions the WHERE clause could not express;
 *  - `applyUpdate(doc, update)`: $set / $unset / $inc / $max / $min / $push / $pull /
 *    $addToSet on a document (read-modify-write inside a transaction).
 * ObjectIds are compared as hex strings.
 */
export function normalize(v) {
  if (v === null || v === undefined) return v;
  if (isObjectId(v)) return String(v);
  if (v instanceof Date || v instanceof RegExp) return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object') {
    if (typeof v.toObject === 'function' && v.$__) v = v.toObject();
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = normalize(x);
    return out;
  }
  return v;
}

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function evalExpr(doc, x) {
  if (typeof x === 'string' && x.startsWith('$')) return get(doc, x.slice(1));
  if (isPlainObject(x)) {
    const [op, arg] = Object.entries(x)[0] ?? [];
    switch (op) {
      case '$toString':
        return evalExpr(doc, arg) == null ? null : String(evalExpr(doc, arg));
      case '$toUpper':
        return String(evalExpr(doc, arg) ?? '').toUpperCase();
      case '$toLower':
        return String(evalExpr(doc, arg) ?? '').toLowerCase();
      case '$substrCP':
        return String(evalExpr(doc, arg[0]) ?? '').substr(arg[1], arg[2]);
      default:
        return undefined;
    }
  }
  return x;
}

const cmp = (a, b) => {
  const va = a instanceof Date ? a.getTime() : a;
  const vb = b instanceof Date ? b.getTime() : b;
  return va < vb ? -1 : va > vb ? 1 : 0;
};

const operations = {
  // $expr: { $eq: [a, b] } / $lt / $gt ...
  $expr(params, ownerQuery, options) {
    return createEqualsOperation((doc) => {
      const [op, args] = Object.entries(params)[0] ?? [];
      const a = normalize(evalExpr(doc, args?.[0]));
      const b = normalize(evalExpr(doc, args?.[1]));
      if (a == null || b == null) return op === '$eq' ? a == b : op === '$ne' ? a != b : false;
      const c = cmp(a, b);
      return { $eq: c === 0, $ne: c !== 0, $lt: c < 0, $lte: c <= 0, $gt: c > 0, $gte: c >= 0 }[op] ?? false;
    }, ownerQuery, options);
  },
  // $text: { $search: 'a b' } -> any word in `text`, case-insensitive
  $text(params, ownerQuery, options) {
    const words = String(params?.$search ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return createEqualsOperation((doc) => {
      const text = String(doc?.text ?? '').toLowerCase();
      return words.some((w) => text.includes(w));
    }, ownerQuery, options);
  },
};

export function matcher(filter) {
  return sift(normalize(filter ?? {}), { operations });
}

// ---------------------------------------------------------------- updates
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[keys[i]];
  }
  o[keys.at(-1)] = value;
}

function unsetPath(obj, path) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null) return;
    o = o[keys[i]];
  }
  if (o) o[keys.at(-1)] = null;
}

const sameValue = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

function compareValues(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return cmp(na instanceof Date ? na : na, nb instanceof Date ? nb : nb);
}

/** Applies a MongoDB update document to `doc` (mutates). `isInsert` enables $setOnInsert. */
export function applyUpdate(doc, update, { isInsert = false } = {}) {
  const ops = Object.keys(update).some((k) => k.startsWith('$')) ? update : { $set: update };
  for (const [op, fields] of Object.entries(ops)) {
    for (const [path, value] of Object.entries(fields ?? {})) {
      switch (op) {
        case '$set':
          setPath(doc, path, value);
          break;
        case '$setOnInsert':
          if (isInsert) setPath(doc, path, value);
          break;
        case '$unset':
          unsetPath(doc, path);
          break;
        case '$inc':
          setPath(doc, path, (Number(get(doc, path)) || 0) + Number(value));
          break;
        case '$max': {
          const cur = get(doc, path);
          if (cur == null || compareValues(value, cur) > 0) setPath(doc, path, value);
          break;
        }
        case '$min': {
          const cur = get(doc, path);
          if (cur == null || compareValues(value, cur) < 0) setPath(doc, path, value);
          break;
        }
        case '$push': {
          const arr = Array.isArray(get(doc, path)) ? [...get(doc, path)] : [];
          if (isPlainObject(value) && '$each' in value) {
            arr.push(...value.$each);
            let next = arr;
            if (typeof value.$slice === 'number') next = value.$slice < 0 ? arr.slice(value.$slice) : arr.slice(0, value.$slice);
            setPath(doc, path, next);
          } else {
            arr.push(value);
            setPath(doc, path, arr);
          }
          break;
        }
        case '$addToSet': {
          const arr = Array.isArray(get(doc, path)) ? [...get(doc, path)] : [];
          const items = isPlainObject(value) && '$each' in value ? value.$each : [value];
          for (const item of items) if (!arr.some((x) => sameValue(x, item))) arr.push(item);
          setPath(doc, path, arr);
          break;
        }
        case '$pull': {
          const arr = Array.isArray(get(doc, path)) ? get(doc, path) : [];
          let keep;
          if (isPlainObject(value)) {
            const m = matcher(value);
            keep = arr.filter((x) => !m(normalize(x)));
          } else if (value instanceof RegExp) keep = arr.filter((x) => !value.test(String(x)));
          else keep = arr.filter((x) => !sameValue(x, value));
          setPath(doc, path, keep);
          break;
        }
        case '$pullAll': {
          const arr = Array.isArray(get(doc, path)) ? get(doc, path) : [];
          setPath(doc, path, arr.filter((x) => !value.some((v) => sameValue(x, v))));
          break;
        }
        default:
          throw new Error(`Unsupported update operator ${op}`);
      }
    }
  }
  return doc;
}

/** Equality conditions of a filter (used to build the document on upsert). */
export function equalityFields(filter) {
  const out = {};
  for (const [k, v] of Object.entries(filter ?? {})) {
    if (k.startsWith('$')) {
      if (k === '$and') for (const f of v) Object.assign(out, equalityFields(f));
      continue;
    }
    if (isPlainObject(v) && Object.keys(v).some((x) => x.startsWith('$'))) {
      if ('$eq' in v) out[k] = v.$eq;
      continue;
    }
    if (v instanceof RegExp) continue;
    out[k] = v;
  }
  return out;
}
