import mongoose from 'mongoose';

import { resolvePath } from './schema.js';

/**
 * MongoDB-style filter -> MySQL WHERE clause.
 * Returns { sql, params, exact }. When a condition cannot be expressed in SQL it is left out
 * (the WHERE then selects a superset) and `exact` is false: the caller filters the rows
 * again in JS with the same query (sift), so results are always correct.
 */
const isObjectId = (v) => v instanceof mongoose.Types.ObjectId || v?._bsontype === 'ObjectId' || v?._bsontype === 'ObjectID';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp) && !isObjectId(v);
const hasOperators = (v) => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));
const q = (name) => `\`${name}\``;

/** JS value -> SQL parameter for a column / JSON leaf of the given type. */
export function toParam(v, instance, json) {
  if (v === undefined) return null;
  if (isObjectId(v)) return String(v);
  if (instance === 'Date' && v !== null && !(v instanceof Date)) v = new Date(v);
  if (v instanceof Date) return json ? v.toISOString() : v;
  if (typeof v === 'boolean') return json ? v : v ? 1 : 0;
  if (instance === 'ObjectId' && v != null) return String(v);
  return v;
}

/** SQL expression for a resolved path; `kind` decides how JSON values are compared. */
function exprOf(r, value) {
  if (!r.jsonPath) return { expr: `t.${q(r.col.name)}`, json: false, whole: r.col.json };
  const raw = `JSON_EXTRACT(t.${q(r.col.name)}, '${r.jsonPath}')`;
  const kind = r.instance === 'Number' || (r.instance === 'Mixed' && typeof value === 'number') ? 'number' : r.instance === 'Boolean' || typeof value === 'boolean' ? 'bool' : 'string';
  if (kind === 'string') return { expr: `JSON_UNQUOTE(${raw})`, raw, json: true, kind };
  return { expr: raw, raw, json: true, kind };
}

function isNullSql(r) {
  if (!r.jsonPath) {
    return r.col.json ? `(t.${q(r.col.name)} IS NULL OR JSON_TYPE(t.${q(r.col.name)}) = 'NULL')` : `t.${q(r.col.name)} IS NULL`;
  }
  const raw = `JSON_EXTRACT(t.${q(r.col.name)}, '${r.jsonPath}')`;
  return `(${raw} IS NULL OR JSON_TYPE(${raw}) = 'NULL')`;
}

const NOT_SQL = Symbol('notSql');

/** Comparison of a scalar path: = < <= > >= <> */
function compare(r, op, value, params) {
  if (value === null) {
    if (op === '=') return isNullSql(r);
    if (op === '<>') return `NOT ${isNullSql(r)}`;
    return NOT_SQL;
  }
  if (value instanceof RegExp || isPlainObject(value) || Array.isArray(value)) return NOT_SQL;
  const e = exprOf(r, value);
  if (e.whole) return NOT_SQL; // comparing a whole sub-document / array
  if (e.json && e.kind === 'bool') {
    params.push(value ? 'true' : 'false');
    return `${e.expr} ${op} CAST(? AS JSON)`;
  }
  params.push(toParam(value, r.instance, e.json));
  return `${e.expr} ${op} ?`;
}

function arrayExpr(r) {
  return r.jsonPath ? `JSON_EXTRACT(t.${q(r.col.name)}, '${r.jsonPath}')` : `t.${q(r.col.name)}`;
}

/** value is an element of the array path */
function member(r, value, params) {
  if (value === null || value instanceof RegExp || isPlainObject(value) || Array.isArray(value)) return NOT_SQL;
  const elInstance = r.element?.instance ?? 'Mixed';
  if (typeof value === 'number') {
    params.push(value);
    return `CAST(? AS DOUBLE) MEMBER OF(${arrayExpr(r)})`;
  }
  if (typeof value === 'boolean') {
    params.push(value ? 'true' : 'false');
    return `CAST(? AS JSON) MEMBER OF(${arrayExpr(r)})`;
  }
  params.push(String(toParam(value, elInstance, true)));
  return `? MEMBER OF(${arrayExpr(r)})`;
}

function regexSql(r, re, params) {
  // JS-only regex features -> filtered in JS instead
  if (/\(\?<[=!]|\(\?<[a-z]|\\p\{|\\k</i.test(re.source)) return NOT_SQL;
  const e = exprOf(r, '');
  if (e.whole) return NOT_SQL;
  params.push(re.source, re.flags.includes('i') ? 'i' : 'c');
  return `REGEXP_LIKE(${e.expr}, ?, ?)`;
}

function inList(r, values, params, negate) {
  if (!values.length) return negate ? '1=1' : '1=0';
  if (values.some((v) => v instanceof RegExp || isPlainObject(v) || Array.isArray(v))) return NOT_SQL;
  if (r.isArray) {
    const vals = values.filter((v) => v !== null).map((v) => toParam(v, r.element?.instance ?? 'Mixed', true));
    params.push(JSON.stringify(vals));
    const s = `JSON_OVERLAPS(${arrayExpr(r)}, CAST(? AS JSON))`;
    return negate ? `NOT (COALESCE(${s}, 0))` : s;
  }
  const hasNull = values.some((v) => v === null);
  const vals = values.filter((v) => v !== null);
  const parts = [];
  if (vals.length) {
    const e = exprOf(r, vals[0]);
    if (e.whole) return NOT_SQL;
    if (e.json && e.kind === 'bool') return NOT_SQL;
    params.push(...vals.map((v) => toParam(v, r.instance, e.json)));
    parts.push(`${e.expr} IN (${vals.map(() => '?').join(', ')})`);
  }
  if (hasNull) parts.push(isNullSql(r));
  const s = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  if (!negate) return s;
  // $nin: missing / null values match unless null is in the list
  return hasNull ? `NOT ${s}` : `(${isNullSql(r)} OR NOT ${s})`;
}

/** Conditions on one field: { field: value } or { field: { $op: v, ... } } */
function fieldSql(info, path, cond, params, state) {
  const r = resolvePath(info, path);
  if (!r || r.nestedParent) {
    state.exact = false;
    return null;
  }
  const parts = [];
  const add = (s) => {
    if (s === NOT_SQL) state.exact = false;
    else if (s) parts.push(s);
  };
  const eq = (v) => {
    if (v instanceof RegExp) {
      if (r.isArray) return NOT_SQL;
      return regexSql(r, v, params);
    }
    if (r.isArray) return v === null ? isNullSql(r) : member(r, v, params);
    return compare(r, '=', v, params);
  };

  if (!hasOperators(cond)) {
    add(eq(cond));
    return parts.join(' AND ') || null;
  }
  for (const [op, v] of Object.entries(cond)) {
    switch (op) {
      case '$eq':
        add(eq(v));
        break;
      case '$ne':
        if (r.isArray) {
          if (v === null) add(`NOT ${isNullSql(r)}`);
          else {
            const p2 = [];
            const m = member(r, v, p2);
            if (m === NOT_SQL) add(NOT_SQL);
            else {
              params.push(...p2);
              add(`(${isNullSql(r)} OR NOT ${m})`);
            }
          }
        } else if (v === null) add(`NOT ${isNullSql(r)}`);
        else {
          const p2 = [];
          const c = compare(r, '=', v, p2);
          if (c === NOT_SQL) add(NOT_SQL);
          else {
            params.push(...p2);
            add(`(${isNullSql(r)} OR NOT (${c}))`);
          }
        }
        break;
      case '$gt':
        add(r.isArray ? NOT_SQL : compare(r, '>', v, params));
        break;
      case '$gte':
        add(r.isArray ? NOT_SQL : compare(r, '>=', v, params));
        break;
      case '$lt':
        add(r.isArray ? NOT_SQL : compare(r, '<', v, params));
        break;
      case '$lte':
        add(r.isArray ? NOT_SQL : compare(r, '<=', v, params));
        break;
      case '$in':
        add(inList(r, v, params, false));
        break;
      case '$nin':
        add(inList(r, v, params, true));
        break;
      case '$exists':
        add(v ? `NOT ${isNullSql(r)}` : isNullSql(r));
        break;
      case '$regex': {
        const re = v instanceof RegExp ? v : new RegExp(v, cond.$options ?? '');
        add(r.isArray ? NOT_SQL : regexSql(r, re, params));
        break;
      }
      case '$options':
        break;
      case '$all': {
        if (!r.isArray || !Array.isArray(v)) {
          add(NOT_SQL);
          break;
        }
        for (const item of v) {
          if (item instanceof RegExp) {
            // "^word" prefix on an array of strings -> JSON_SEARCH with LIKE
            const m = /^\^((?:[^\\.*+?()[\]{}|^$]|\\.)*)$/.exec(item.source);
            if (m && !item.flags.includes('i')) {
              const literal = m[1].replace(/\\(.)/g, '$1').replace(/[\\%_]/g, (c) => `\\${c}`);
              params.push(`${literal}%`);
              add(`JSON_SEARCH(${arrayExpr(r)}, 'one', ?) IS NOT NULL`);
            } else add(NOT_SQL);
          } else add(member(r, item, params));
        }
        break;
      }
      case '$elemMatch': {
        // { field: { $elemMatch: { a: 1, b: 'x' } } } with plain equalities -> JSON_CONTAINS
        if (!r.isArray || !isPlainObject(v) || Object.values(v).some((x) => x === null || hasOperators(x) || x instanceof RegExp || isPlainObject(x))) {
          add(NOT_SQL);
          break;
        }
        const candidate = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isObjectId(x) ? String(x) : x instanceof Date ? x.toISOString() : x]));
        params.push(JSON.stringify(candidate));
        add(`JSON_CONTAINS(${arrayExpr(r)}, CAST(? AS JSON))`);
        break;
      }
      case '$size':
        params.push(Number(v));
        add(`JSON_LENGTH(${arrayExpr(r)}) = ?`);
        break;
      case '$not':
        if (v instanceof RegExp) {
          const p2 = [];
          const s = regexSql(r, v, p2);
          if (s === NOT_SQL) add(NOT_SQL);
          else {
            params.push(...p2);
            add(`(${isNullSql(r)} OR NOT ${s})`);
          }
        } else add(NOT_SQL);
        break;
      default:
        add(NOT_SQL); // $type and anything else: JS
    }
  }
  return parts.length ? parts.join(' AND ') : null;
}

// ---------------------------------------------------------------- $expr (small subset)
function exprOperand(info, x, params) {
  if (typeof x === 'string' && x.startsWith('$')) {
    const r = resolvePath(info, x.slice(1));
    if (!r || r.nestedParent || r.isArray) return NOT_SQL;
    return exprOf(r, r.instance === 'Number' ? 0 : '').expr;
  }
  if (isPlainObject(x)) {
    const [op, arg] = Object.entries(x)[0] ?? [];
    const one = (a) => exprOperand(info, a, params);
    switch (op) {
      case '$toString': {
        const a = one(arg);
        return a === NOT_SQL ? a : `CAST(${a} AS CHAR)`;
      }
      case '$toUpper': {
        const a = one(arg);
        return a === NOT_SQL ? a : `UPPER(${a})`;
      }
      case '$toLower': {
        const a = one(arg);
        return a === NOT_SQL ? a : `LOWER(${a})`;
      }
      case '$substrCP': {
        const a = one(arg[0]);
        if (a === NOT_SQL) return a;
        params.push(Number(arg[1]) + 1, Number(arg[2]));
        return `SUBSTRING(${a}, ?, ?)`;
      }
      default:
        return NOT_SQL;
    }
  }
  params.push(toParam(x, typeof x === 'number' ? 'Number' : 'String', false));
  return '?';
}

function exprSql(info, e, params) {
  const OPS = { $eq: '=', $ne: '<>', $lt: '<', $lte: '<=', $gt: '>', $gte: '>=' };
  const [op, args] = Object.entries(e ?? {})[0] ?? [];
  if (!OPS[op] || !Array.isArray(args) || args.length !== 2) return NOT_SQL;
  const p2 = [];
  const a = exprOperand(info, args[0], p2);
  const b = exprOperand(info, args[1], p2);
  if (a === NOT_SQL || b === NOT_SQL) return NOT_SQL;
  params.push(...p2);
  return `${a} ${OPS[op]} ${b}`;
}

// ---------------------------------------------------------------- entry
function build(info, filter, params, state) {
  const parts = [];
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (value === undefined) continue;
    if (key === '$and' || key === '$or' || key === '$nor') {
      const sub = [];
      let ok = true;
      for (const f of value) {
        const subState = { exact: true };
        const p2 = [];
        const s = build(info, f, p2, subState);
        if (key === '$and') {
          if (!subState.exact) state.exact = false;
          if (s) {
            sub.push(s);
            params.push(...p2);
          }
          continue;
        }
        // $or / $nor need every branch in SQL, otherwise the whole group is done in JS
        if (!subState.exact) ok = false;
        sub.push({ s: s ?? '1=1', p2 });
      }
      if (key === '$and') {
        if (sub.length) parts.push(sub.map((s) => `(${s})`).join(' AND '));
        continue;
      }
      if (!ok) {
        state.exact = false;
        continue;
      }
      if (!sub.length) {
        parts.push(key === '$or' ? '1=0' : '1=1');
        continue;
      }
      for (const x of sub) params.push(...x.p2);
      const joined = sub.map((x) => `(${x.s})`).join(' OR ');
      parts.push(key === '$or' ? `(${joined})` : `NOT (${joined})`);
      continue;
    }
    if (key === '$expr') {
      const p2 = [];
      const s = exprSql(info, value, p2);
      if (s === NOT_SQL) state.exact = false;
      else {
        params.push(...p2);
        parts.push(s);
      }
      continue;
    }
    if (key === '$text') {
      const words = String(value?.$search ?? '')
        .split(/\s+/)
        .filter(Boolean);
      const textCol = info.byPath.get('text');
      if (!textCol || !words.length) {
        state.exact = false;
        continue;
      }
      parts.push(`(${words.map(() => `LOWER(t.\`text\`) LIKE ?`).join(' OR ')})`);
      params.push(...words.map((w) => `%${w.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
      continue;
    }
    if (key.startsWith('$')) {
      state.exact = false;
      continue;
    }
    const s = fieldSql(info, key, value, params, state);
    if (s) parts.push(s);
  }
  return parts.length ? parts.join(' AND ') : null;
}

export function buildWhere(info, filter) {
  const params = [];
  const state = { exact: true };
  const sql = build(info, filter, params, state);
  return { sql: sql ?? '1=1', params, exact: state.exact };
}

export { isObjectId, isPlainObject, hasOperators };
