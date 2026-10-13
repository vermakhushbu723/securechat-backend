import mongoose from 'mongoose';

import { exec, transaction } from './connection.js';
import { buildWhere, isObjectId, isPlainObject, toParam } from './filter.js';
import { analyzeSchema, colName, resolvePath } from './schema.js';
import { applyUpdate, equalityFields, matcher, normalize } from './update.js';

/**
 * MySQL-backed models with the MongoDB/Mongoose call style the services already use
 * (find / findOne / updateOne / $inc / $push / aggregate ...). Each model is a MySQL table
 * (see schema.js). Mongoose is only used for the schema definitions: defaults, casting,
 * validation and `pre('validate')` hooks - it never opens a MongoDB connection.
 */
const registry = new Map();
const q = (n) => `\`${n}\``;
const { ObjectId } = mongoose.Types;

export const getModel = (name) => registry.get(name);
export const allModels = () => [...registry.values()];

// ---------------------------------------------------------------- projection / sort helpers
function parseProjection(sel) {
  if (!sel) return null;
  const out = { include: [], exclude: [], plus: [] };
  if (typeof sel === 'string') {
    for (const f of sel.split(/\s+/).filter(Boolean)) {
      if (f.startsWith('-')) out.exclude.push(f.slice(1));
      else if (f.startsWith('+')) out.plus.push(f.slice(1));
      else out.include.push(f);
    }
  } else if (typeof sel === 'object') {
    for (const [f, v] of Object.entries(sel)) {
      if (v === 0 || v === false) out.exclude.push(f);
      else out.include.push(f);
    }
  }
  return out;
}

function mergeProjection(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { include: [...a.include, ...b.include], exclude: [...a.exclude, ...b.exclude], plus: [...a.plus, ...b.plus] };
}

function pick(src, paths) {
  const out = {};
  for (const p of paths) {
    const keys = p.split('.');
    let s = src;
    let o = out;
    for (let i = 0; i < keys.length; i++) {
      if (s == null || typeof s !== 'object') break;
      if (i === keys.length - 1) {
        if (keys[i] in s) o[keys[i]] = s[keys[i]];
      } else {
        s = s[keys[i]];
        if (s == null || typeof s !== 'object') break;
        o[keys[i]] = o[keys[i]] ?? (Array.isArray(s) ? s : {});
        if (Array.isArray(s)) {
          o[keys[i]] = s; // projections into arrays keep the whole array
          break;
        }
        o = o[keys[i]];
      }
    }
  }
  return out;
}

function dropPath(obj, path) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    o = o?.[keys[i]];
    if (o == null || typeof o !== 'object') return;
  }
  if (o) delete o[keys.at(-1)];
}

function parseSort(sort) {
  if (!sort) return [];
  if (typeof sort === 'string') {
    return sort
      .split(/\s+/)
      .filter(Boolean)
      .map((f) => (f.startsWith('-') ? [f.slice(1), -1] : [f, 1]));
  }
  return Object.entries(sort).map(([k, v]) => [k, v === -1 || v === 'desc' || v === 'descending' ? -1 : 1]);
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function jsCompare(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na == null && nb == null) return 0;
  if (na == null) return -1;
  if (nb == null) return 1;
  const va = na instanceof Date ? na.getTime() : na;
  const vb = nb instanceof Date ? nb.getTime() : nb;
  if (typeof va === 'boolean' || typeof vb === 'boolean') return Number(va) - Number(vb);
  return va < vb ? -1 : va > vb ? 1 : 0;
}

// ---------------------------------------------------------------- model factory
// Mongoose never connects: no index / collection creation in the background.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

export function sqlModel(name, schema, { table } = {}) {
  const tableName = table ?? mongoose.pluralize()(name);
  // A Mongoose model that never connects: defaults, casting, validation, hooks, documents.
  const Local = mongoose.models[name] ?? mongoose.model(name, schema);
  const info = analyzeSchema(schema, tableName);

  // ---- rows <-> objects
  function toRow(obj) {
    const row = {};
    for (const c of info.columns) {
      const v = getPath(obj, c.path);
      if (c.json) row[c.name] = v === undefined || v === null ? null : JSON.stringify(normalize(v));
      else row[c.name] = v === undefined ? null : toParam(v, c.instance, false);
    }
    return row;
  }

  function fromRow(row) {
    const obj = {};
    for (const c of info.columns) {
      let v = row[c.name];
      if (v === undefined) continue;
      // mysql2 already parses JSON columns
      if (c.instance === 'Boolean' && v !== null) v = Boolean(v);
      const keys = c.path.split('.');
      let o = obj;
      for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] = o[keys[i]] ?? {};
      o[keys.at(-1)] = v;
    }
    // ObjectIds / Dates inside JSON values come back as strings: cast them with the schema.
    let cast = obj;
    try {
      cast = Local.castObject(obj, { ignoreCastErrors: true });
    } catch {
      cast = obj;
    }
    if (row._id) cast._id = new ObjectId(row._id);
    return cast;
  }

  function project(obj, proj) {
    let out = obj;
    const hidden = info.selectFalse.filter((p) => !(proj?.plus ?? []).includes(p) && !(proj?.include ?? []).includes(p));
    if (proj?.include?.length) {
      const inc = proj.include.filter((p) => p !== '_id');
      out = pick(obj, [...inc, ...(proj.plus ?? [])]);
      if (!proj.exclude.includes('_id')) out._id = obj._id;
      return out;
    }
    out = { ...obj };
    for (const p of [...hidden, ...(proj?.exclude ?? [])]) dropPath(out, p);
    return out;
  }

  function hydrateDoc(obj) {
    const doc = Local.hydrate(obj);
    return doc;
  }

  // ---- SQL helpers
  function orderSql(sort) {
    const parts = [];
    for (const [path, dir] of sort) {
      const r = resolvePath(info, path);
      if (!r || r.nestedParent || r.isArray) return null;
      const e = r.jsonPath
        ? r.instance === 'Number'
          ? `CAST(JSON_EXTRACT(t.${q(r.col.name)}, '${r.jsonPath}') AS DOUBLE)`
          : `JSON_UNQUOTE(JSON_EXTRACT(t.${q(r.col.name)}, '${r.jsonPath}'))`
        : `t.${q(r.col.name)}`;
      parts.push(`${e} ${dir === -1 ? 'DESC' : 'ASC'}`);
    }
    return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
  }

  /** Rows matching `filter` as plain objects (sorted / paged), honouring JS-only conditions. */
  async function selectObjects(filter, { sort = [], skip = 0, limit = 0, forUpdate = false } = {}) {
    const w = buildWhere(info, filter);
    const order = orderSql(sort);
    let sql = `SELECT t.* FROM ${q(tableName)} t WHERE ${w.sql}`;
    const sqlPaging = w.exact && order !== null;
    if (sqlPaging) {
      sql += order;
      if (limit) sql += ` LIMIT ${Number(limit)}`;
      if (skip) sql += `${limit ? '' : ' LIMIT 18446744073709551615'} OFFSET ${Number(skip)}`;
    }
    if (forUpdate) sql += ' FOR UPDATE';
    const rows = await exec(sql, w.params);
    let objs = rows.map(fromRow);
    if (!w.exact) {
      const m = matcher(filter);
      objs = objs.filter((o) => m(normalize(o)));
    }
    if (!sqlPaging) {
      if (sort.length) {
        objs.sort((a, b) => {
          for (const [p, d] of sort) {
            const c = jsCompare(getPath(a, p), getPath(b, p));
            if (c) return c * d;
          }
          return 0;
        });
      }
      if (skip) objs = objs.slice(skip);
      if (limit) objs = objs.slice(0, limit);
    }
    return objs;
  }

  async function insertObject(obj) {
    const row = toRow(obj);
    const cols = Object.keys(row);
    await exec(
      `INSERT INTO ${q(tableName)} (${cols.map(q).join(', ')}) VALUES (${cols.map((c) => (info.columns.find((x) => x.name === c)?.json ? 'CAST(? AS JSON)' : '?')).join(', ')})`,
      cols.map((c) => row[c]),
    );
  }

  async function writeObject(obj, before) {
    const row = toRow(obj);
    const old = before ? toRow(before) : null;
    const cols = Object.keys(row).filter((c) => c !== '_id' && (!old || JSON.stringify(old[c]) !== JSON.stringify(row[c])));
    if (!cols.length) return false;
    await exec(
      `UPDATE ${q(tableName)} SET ${cols.map((c) => `${q(c)} = ${info.columns.find((x) => x.name === c)?.json ? 'CAST(? AS JSON)' : '?'}`).join(', ')} WHERE _id = ?`,
      [...cols.map((c) => row[c]), String(obj._id)],
    );
    return true;
  }

  /** Builds a full document (defaults, casting, validation, hooks) for an insert. */
  async function buildNew(input) {
    const doc = input instanceof Local ? input : new Local(input);
    await doc.validate();
    const now = new Date();
    if (info.timestamps.createdAt && doc.get(info.timestamps.createdAt) == null) doc.set(info.timestamps.createdAt, now);
    if (info.timestamps.updatedAt && doc.get(info.timestamps.updatedAt) == null) doc.set(info.timestamps.updatedAt, now);
    return doc;
  }

  async function createOne(input) {
    const doc = await buildNew(input);
    await insertObject(doc.toObject({ depopulate: true, virtuals: false, getters: false }));
    doc.$isNew = false;
    doc.isNew = false;
    return doc;
  }

  /** Values of $set for JSON columns get the sub-document defaults / casting. */
  function castUpdate(update) {
    const ops = Object.keys(update).some((k) => k.startsWith('$')) ? { ...update } : { $set: update };
    for (const op of ['$set', '$setOnInsert']) {
      if (!ops[op]) continue;
      const next = {};
      for (const [path, value] of Object.entries(ops[op])) {
        const r = resolvePath(info, path);
        if (r?.nestedParent && isPlainObject(value)) {
          // replacing a plain nested object: every flattened leaf is set (missing -> null)
          for (const leaf of r.leaves) next[leaf.path] = getPath(value, leaf.path.slice(path.length + 1)) ?? null;
          continue;
        }
        if (r && !r.jsonPath && r.col.json && value != null && (isPlainObject(value) || Array.isArray(value))) {
          try {
            const cast = new Local({ [r.col.path]: value }).toObject({ depopulate: true });
            next[path] = cast[r.col.path] ?? value;
          } catch {
            next[path] = value;
          }
          continue;
        }
        next[path] = value;
      }
      ops[op] = next;
    }
    return ops;
  }

  /** Plain column updates that can run as one UPDATE statement (no JSON paths, no arrays). */
  function fastSet(ops) {
    const sets = [];
    const params = [];
    for (const [op, fields] of Object.entries(ops)) {
      if (!['$set', '$unset', '$inc', '$max', '$min', '$setOnInsert'].includes(op)) return null;
      if (op === '$setOnInsert') continue;
      for (const [path, value] of Object.entries(fields ?? {})) {
        const r = resolvePath(info, path);
        if (!r || r.nestedParent || r.jsonPath) return null;
        const c = r.col;
        const n = q(c.name);
        if (op === '$unset') {
          sets.push(`${n} = NULL`);
          continue;
        }
        if (c.json) {
          if (op !== '$set') return null;
          sets.push(`${n} = CAST(? AS JSON)`);
          params.push(value == null ? null : JSON.stringify(normalize(value)));
          continue;
        }
        const p = toParam(value, c.instance, false);
        if (op === '$set') {
          sets.push(`${n} = ?`);
          params.push(p);
        } else if (op === '$inc') {
          sets.push(`${n} = COALESCE(${n}, 0) + ?`);
          params.push(Number(value));
        } else if (op === '$max') {
          sets.push(`${n} = IF(${n} IS NULL OR ${n} < ?, ?, ${n})`);
          params.push(p, p);
        } else if (op === '$min') {
          sets.push(`${n} = IF(${n} IS NULL OR ${n} > ?, ?, ${n})`);
          params.push(p, p);
        }
      }
    }
    return { sets, params };
  }

  function touch(ops) {
    if (!info.timestamps.updatedAt) return ops;
    const touched = Object.values(ops).some((f) => f && Object.prototype.hasOwnProperty.call(f, info.timestamps.updatedAt));
    if (touched) return ops;
    return { ...ops, $set: { ...(ops.$set ?? {}), [info.timestamps.updatedAt]: new Date() } };
  }

  async function upsertInsert(filter, ops) {
    const base = {};
    for (const [k, v] of Object.entries(equalityFields(filter))) {
      if (k === '_id') base._id = v;
      else applyUpdate(base, { $set: { [k]: v } });
    }
    applyUpdate(base, ops, { isInsert: true });
    if (info.timestamps.updatedAt) delete base[info.timestamps.updatedAt];
    const doc = await createOne(base);
    return doc;
  }

  /**
   * Core of updateOne / updateMany / findOneAndUpdate.
   * Returns { matched, modified, upserted, before: [objs], after: [objs] }.
   */
  async function runUpdate(filter, update, { multi = false, upsert = false, sort = [], wantDocs = false } = {}) {
    const ops = touch(castUpdate(update));
    const w = buildWhere(info, filter);
    const fast = fastSet(ops);
    // 1) one SQL statement: exact filter + plain column changes
    if (fast && w.exact && !wantDocs && !sort.length) {
      if (!fast.sets.length) {
        // nothing to change (e.g. only $setOnInsert): count matches, insert when upserting
        const [row] = await exec(`SELECT COUNT(*) AS n FROM ${q(tableName)} t WHERE ${w.sql}`, w.params);
        const matched = Math.min(Number(row.n), multi ? Infinity : 1);
        if (!matched && upsert) {
          const doc = await upsertInsert(filter, ops);
          return { matched: 0, modified: 0, upserted: doc._id };
        }
        return { matched, modified: 0 };
      }
      const res = await exec(`UPDATE ${q(tableName)} t SET ${fast.sets.map((s) => s.replace(/`([^`]+)`/g, 't.`$1`')).join(', ')} WHERE ${w.sql}${multi ? '' : ' LIMIT 1'}`, [...fast.params, ...w.params]);
      if (res.affectedRows === 0 && upsert) {
        const doc = await upsertInsert(filter, ops);
        return { matched: 0, modified: 0, upserted: doc._id };
      }
      return { matched: res.affectedRows, modified: res.changedRows ?? res.affectedRows };
    }
    // 2) read-modify-write in a transaction (rows locked)
    return transaction(async () => {
      const objs = await selectObjects(filter, { sort, limit: multi ? 0 : 1, forUpdate: true });
      if (!objs.length) {
        if (!upsert) return { matched: 0, modified: 0, before: [], after: [] };
        const doc = await upsertInsert(filter, ops);
        const obj = doc.toObject({ depopulate: true });
        return { matched: 0, modified: 0, upserted: doc._id, before: [null], after: [obj] };
      }
      const before = [];
      const after = [];
      let modified = 0;
      for (const obj of objs) {
        const prev = structuredClone(normalizeForClone(obj));
        const next = applyUpdate(obj, ops);
        let cast = next;
        try {
          cast = Local.castObject(next, { ignoreCastErrors: true });
          cast._id = next._id;
        } catch {
          cast = next;
        }
        if (await writeObject(cast, reviveClone(prev))) modified++;
        before.push(reviveClone(prev));
        after.push(cast);
      }
      return { matched: objs.length, modified, before, after };
    });
  }

  // structuredClone cannot copy ObjectId instances: go through hex strings and back.
  function normalizeForClone(obj) {
    return normalize(obj);
  }
  function reviveClone(obj) {
    try {
      const c = Local.castObject(obj, { ignoreCastErrors: true });
      c._id = obj._id ? new ObjectId(String(obj._id)) : obj._id;
      return c;
    } catch {
      return obj;
    }
  }

  // ---- Query (thenable, chainable like Mongoose)
  class Query {
    constructor(op, filter, projection, options = {}) {
      this.op = op;
      this.filter = filter ?? {};
      this._proj = parseProjection(projection);
      this._sort = parseSort(options.sort);
      this._skip = options.skip ?? 0;
      this._limit = options.limit ?? 0;
      this._lean = Boolean(options.lean);
      this._populate = [];
    }

    select(sel) {
      this._proj = mergeProjection(this._proj, parseProjection(sel));
      return this;
    }

    sort(s) {
      this._sort = parseSort(s);
      return this;
    }

    skip(n) {
      this._skip = Number(n) || 0;
      return this;
    }

    limit(n) {
      this._limit = Number(n) || 0;
      return this;
    }

    lean(v = true) {
      this._lean = v !== false;
      return this;
    }

    populate(path, select) {
      if (typeof path === 'object') this._populate.push({ path: path.path, select: path.select });
      else this._populate.push({ path, select });
      return this;
    }

    session() {
      return this;
    }

    hint() {
      return this;
    }

    collation() {
      return this;
    }

    setOptions() {
      return this;
    }

    // MongoDB-only tuning options: nothing to do on MySQL
    maxTimeMS() {
      return this;
    }

    allowDiskUse() {
      return this;
    }

    batchSize() {
      return this;
    }

    comment() {
      return this;
    }

    read() {
      return this;
    }

    async exec() {
      const one = this.op === 'findOne';
      const objs = await selectObjects(this.filter, { sort: this._sort, skip: this._skip, limit: one ? 1 : this._limit });
      for (const p of this._populate) await populateInto(objs, p);
      const out = objs.map((o) => {
        const projected = project(o, this._proj);
        return this._lean ? projected : hydrateDoc(projected);
      });
      return one ? (out[0] ?? null) : out;
    }

    then(resolve, reject) {
      return this.exec().then(resolve, reject);
    }

    catch(reject) {
      return this.exec().catch(reject);
    }

    finally(fn) {
      return this.exec().finally(fn);
    }
  }

  async function populateInto(objs, { path, select }) {
    const c = info.byPath.get(path);
    const refName = c && schema.path(path)?.options?.ref;
    const Ref = refName && registry.get(refName);
    if (!Ref) return;
    const ids = [...new Set(objs.flatMap((o) => [getPath(o, path)].flat()).filter(Boolean).map(String))];
    if (!ids.length) return;
    const refs = await Ref.find({ _id: { $in: ids } }).select(select).lean();
    const map = new Map(refs.map((r) => [String(r._id), r]));
    for (const o of objs) {
      const v = getPath(o, path);
      const val = Array.isArray(v) ? v.map((x) => map.get(String(x)) ?? x) : (map.get(String(v)) ?? v);
      applyUpdate(o, { $set: { [path]: val } });
    }
  }

  function castId(id) {
    if (id == null) return id;
    if (isObjectId(id)) return id;
    const s = String(id);
    if (!/^[a-f0-9]{24}$/i.test(s)) {
      const err = new Error(`Cast to ObjectId failed for value "${s}"`);
      err.name = 'CastError';
      throw err;
    }
    return s.toLowerCase();
  }

  // ---- aggregation: $match in SQL, the rest in SQL (simple $group) or JS
  async function aggregate(pipeline) {
    const stages = [...pipeline];
    const match = stages[0]?.$match ? stages.shift().$match : {};
    const sqlGroup = await trySqlGroup(match, stages);
    if (sqlGroup) return sqlGroup;
    let sortBefore = [];
    if (stages[0]?.$sort) sortBefore = parseSort(stages.shift().$sort);
    let rows = await selectObjects(match, { sort: sortBefore });
    for (const st of stages) {
      const [op, spec] = Object.entries(st)[0];
      if (op === '$group') rows = jsGroup(rows, spec);
      else if (op === '$sort') {
        const s = parseSort(spec);
        rows.sort((a, b) => {
          for (const [p, d] of s) {
            const c = jsCompare(getPath(a, p), getPath(b, p));
            if (c) return c * d;
          }
          return 0;
        });
      } else if (op === '$limit') rows = rows.slice(0, spec);
      else if (op === '$skip') rows = rows.slice(spec);
      else if (op === '$match') {
        const m = matcher(spec);
        rows = rows.filter((r) => m(normalize(r)));
      } else if (op === '$count') rows = [{ [spec]: rows.length }];
      else if (op === '$project') rows = rows.map((r) => pick(r, Object.keys(spec).filter((k) => spec[k])));
      else throw new Error(`Unsupported aggregation stage ${op}`);
    }
    return rows;
  }

  function groupKey(row, idSpec) {
    if (idSpec === null) return null;
    if (typeof idSpec === 'string') return getPath(row, idSpec.slice(1));
    if (isPlainObject(idSpec) && idSpec.$dateToString) {
      const d = getPath(row, idSpec.$dateToString.date.slice(1));
      return d ? new Date(d).toISOString().slice(0, 10) : null;
    }
    if (isPlainObject(idSpec)) return Object.fromEntries(Object.entries(idSpec).map(([k, v]) => [k, groupKey(row, v)]));
    return idSpec;
  }

  function jsGroup(rows, spec) {
    const { _id: idSpec, ...acc } = spec;
    const groups = new Map();
    for (const row of rows) {
      const key = groupKey(row, idSpec);
      const k = JSON.stringify(normalize(key));
      if (!groups.has(k)) groups.set(k, { _id: key, rows: [] });
      groups.get(k).rows.push(row);
    }
    return [...groups.values()].map((g) => {
      const out = { _id: g._id };
      for (const [name, a] of Object.entries(acc)) {
        const [fn, arg] = Object.entries(a)[0];
        const vals = g.rows.map((r) => (typeof arg === 'string' && arg.startsWith('$') ? getPath(r, arg.slice(1)) : arg));
        if (fn === '$sum') out[name] = vals.reduce((s, v) => s + (Number(v) || 0), 0);
        else if (fn === '$avg') out[name] = vals.length ? vals.reduce((s, v) => s + (Number(v) || 0), 0) / vals.length : null;
        else if (fn === '$first') out[name] = vals[0];
        else if (fn === '$last') out[name] = vals.at(-1);
        else if (fn === '$max') out[name] = vals.filter((v) => v != null).reduce((m, v) => (m == null || jsCompare(v, m) > 0 ? v : m), null);
        else if (fn === '$min') out[name] = vals.filter((v) => v != null).reduce((m, v) => (m == null || jsCompare(v, m) < 0 ? v : m), null);
        else if (fn === '$push') out[name] = vals;
        else if (fn === '$addToSet') out[name] = [...new Map(vals.map((v) => [JSON.stringify(normalize(v)), v])).values()];
        else throw new Error(`Unsupported accumulator ${fn}`);
      }
      return out;
    });
  }

  function keyExpr(spec) {
    if (typeof spec === 'string' && spec.startsWith('$')) {
      const r = resolvePath(info, spec.slice(1));
      if (!r || r.nestedParent || r.isArray) return null;
      return {
        sql: r.jsonPath ? `JSON_UNQUOTE(JSON_EXTRACT(t.${q(r.col.name)}, '${r.jsonPath}'))` : `t.${q(r.col.name)}`,
        instance: r.instance,
      };
    }
    if (isPlainObject(spec) && spec.$dateToString && spec.$dateToString.format === '%Y-%m-%d') {
      const r = resolvePath(info, spec.$dateToString.date.slice(1));
      if (!r || r.jsonPath) return null;
      return { sql: `DATE_FORMAT(t.${q(r.col.name)}, '%Y-%m-%d')`, instance: 'String' };
    }
    return null;
  }

  async function trySqlGroup(match, stages) {
    const g = stages[0]?.$group;
    if (!g) return null;
    const rest = stages.slice(1);
    if (!rest.every((s) => s.$sort || s.$limit)) return null;
    const w = buildWhere(info, match);
    if (!w.exact) return null;
    const { _id: idSpec, ...acc } = g;
    const select = [];
    const groupBy = [];
    const keys = [];
    if (idSpec !== null) {
      const specs = isPlainObject(idSpec) && !idSpec.$dateToString ? Object.entries(idSpec) : [['_id', idSpec]];
      for (const [k, s] of specs) {
        const e = keyExpr(s);
        if (!e) return null;
        select.push(`${e.sql} AS ${q(`k_${k}`)}`);
        groupBy.push(`${q(`k_${k}`)}`);
        keys.push({ k, instance: e.instance });
      }
    }
    const accs = [];
    for (const [name, a] of Object.entries(acc)) {
      const [fn, arg] = Object.entries(a)[0];
      if (fn === '$sum' && typeof arg === 'number') select.push(`COUNT(*) * ${Number(arg)} AS ${q(`a_${name}`)}`);
      else if (['$sum', '$min', '$max'].includes(fn) && typeof arg === 'string' && arg.startsWith('$')) {
        const e = keyExpr(arg);
        if (!e) return null;
        const f = { $sum: 'SUM', $min: 'MIN', $max: 'MAX' }[fn];
        select.push(`${f}(${e.instance === 'Number' && e.sql.startsWith('JSON') ? `CAST(${e.sql} AS DOUBLE)` : e.sql}) AS ${q(`a_${name}`)}`);
        accs.push({ name, instance: e.instance, fn });
        continue;
      } else return null;
      accs.push({ name, instance: 'Number', fn });
    }
    let sql = `SELECT ${select.join(', ')} FROM ${q(tableName)} t WHERE ${w.sql}`;
    if (groupBy.length) sql += ` GROUP BY ${groupBy.join(', ')}`;
    const order = [];
    let limit = 0;
    for (const s of rest) {
      if (s.$limit) limit = s.$limit;
      if (s.$sort) {
        for (const [k, d] of parseSort(s.$sort)) {
          if (k === '_id' && keys.length === 1) order.push(`${q('k__id')} ${d === -1 ? 'DESC' : 'ASC'}`);
          else if (accs.some((a) => a.name === k)) order.push(`${q(`a_${k}`)} ${d === -1 ? 'DESC' : 'ASC'}`);
          else return null;
        }
      }
    }
    if (order.length) sql += ` ORDER BY ${order.join(', ')}`;
    if (limit) sql += ` LIMIT ${Number(limit)}`;
    const rows = await exec(sql, w.params);
    const castVal = (v, instance) => {
      if (v == null) return v;
      if (instance === 'ObjectId' && /^[a-f0-9]{24}$/i.test(String(v))) return new ObjectId(String(v));
      if (instance === 'Number') return Number(v);
      if (instance === 'Boolean') return v === 'true' || v === 1 || v === true;
      if (instance === 'Date' && !(v instanceof Date)) return new Date(v);
      return v;
    };
    return rows.map((r) => {
      const out = {};
      if (idSpec === null) out._id = null;
      else if (isPlainObject(idSpec) && !idSpec.$dateToString) out._id = Object.fromEntries(keys.map(({ k, instance }) => [k, castVal(r[`k_${k}`], instance)]));
      else out._id = castVal(r.k__id, keys[0].instance);
      for (const a of accs) out[a.name] = a.fn === '$sum' ? Number(r[`a_${a.name}`] ?? 0) : castVal(r[`a_${a.name}`], a.instance);
      return out;
    });
  }

  /**
   * Thenable result that still accepts Mongoose-style modifiers before it runs:
   * `.lean()`, `.select()`, `.sort()`, `.populate()`, `.exec()`, `.session()`.
   */
  function chain(run) {
    const mods = { lean: false, select: null, sort: null, populate: [], limit: 0, skip: 0 };
    let promise = null;
    const go = () => (promise ??= run(mods));
    const c = {
      lean(v = true) {
        mods.lean = v !== false;
        return c;
      },
      select(sel) {
        mods.select = sel;
        return c;
      },
      sort(sv) {
        mods.sort = sv;
        return c;
      },
      limit(n) {
        mods.limit = Number(n) || 0;
        return c;
      },
      skip(n) {
        mods.skip = Number(n) || 0;
        return c;
      },
      populate(path, select) {
        mods.populate.push({ path, select });
        return c;
      },
      session() {
        return c;
      },
      maxTimeMS() {
        return c;
      },
      exec: () => go(),
      then: (a, b) => go().then(a, b),
      catch: (b) => go().catch(b),
      finally: (f) => go().finally(f),
    };
    return c;
  }

  const shapeDoc = (obj, mods, options) => {
    if (!obj) return null;
    const proj = mergeProjection(parseProjection(options.projection ?? options.select ?? options.fields), parseProjection(mods.select));
    const projected = project(obj, proj);
    return options.lean || mods.lean ? projected : hydrateDoc(projected);
  };

  // ---- the model
  const Model = {
    modelName: name,
    schema,
    tableName,
    info,
    collection: { name: tableName, collectionName: tableName },

    find(filter, projection, options) {
      return new Query('find', filter, projection, options);
    },
    findOne(filter, projection, options) {
      return new Query('findOne', filter, projection, options);
    },
    findById(id, projection, options) {
      if (id == null) return new Query('findOne', { _id: { $in: [] } }, projection, options);
      return new Query('findOne', { _id: castId(id) }, projection, options);
    },

    async countDocuments(filter = {}, mods = {}) {
      const w = buildWhere(info, filter);
      const limit = Number(mods.limit) || 0;
      const skip = Number(mods.skip) || 0;
      if (w.exact) {
        if (!limit && !skip) {
          const [row] = await exec(`SELECT COUNT(*) AS n FROM ${q(tableName)} t WHERE ${w.sql}`, w.params);
          return Number(row.n);
        }
        const [row] = await exec(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q(tableName)} t WHERE ${w.sql} LIMIT ${limit || '18446744073709551615'} OFFSET ${skip}) x`,
          w.params,
        );
        return Number(row.n);
      }
      let n = (await selectObjects(filter)).length - skip;
      if (n < 0) n = 0;
      return limit ? Math.min(n, limit) : n;
    },
    async estimatedDocumentCount() {
      const [row] = await exec(`SELECT COUNT(*) AS n FROM ${q(tableName)}`);
      return Number(row.n);
    },

    async exists(filter) {
      const o = await new Query('findOne', filter, '_id').lean();
      return o ? { _id: o._id } : null;
    },

    async distinct(field, filter = {}) {
      const objs = await selectObjects(filter);
      const seen = new Map();
      for (const o of objs) {
        for (const v of [getPath(o, field)].flat()) {
          if (v === undefined) continue;
          const k = JSON.stringify(normalize(v));
          if (!seen.has(k)) seen.set(k, v);
        }
      }
      return [...seen.values()];
    },

    async create(input, opts) {
      if (Array.isArray(input)) {
        const out = [];
        for (const i of input) out.push(await createOne(i));
        return out;
      }
      if (opts && Array.isArray(opts)) return Model.create([input, ...opts]);
      return createOne(input);
    },

    async insertMany(list) {
      const out = [];
      for (const i of list) out.push(await createOne(i));
      return out;
    },

    async updateOne(filter, update, options = {}) {
      const r = await runUpdate(filter, update, { upsert: options.upsert });
      return { acknowledged: true, matchedCount: r.matched, modifiedCount: r.modified, upsertedId: r.upserted ?? null, upsertedCount: r.upserted ? 1 : 0 };
    },

    async updateMany(filter, update, options = {}) {
      const r = await runUpdate(filter, update, { multi: true, upsert: options.upsert });
      return { acknowledged: true, matchedCount: r.matched, modifiedCount: r.modified, upsertedId: r.upserted ?? null, upsertedCount: r.upserted ? 1 : 0 };
    },

    findOneAndUpdate(filter, update, options = {}) {
      return chain(async (mods) => {
        const after = options.returnDocument === 'after' || options.new === true;
        const r = await runUpdate(filter, update, { upsert: options.upsert, sort: parseSort(options.sort ?? mods.sort), wantDocs: true });
        const obj = after ? r.after?.[0] : r.before?.[0];
        if (obj) for (const p of mods.populate) await populateInto([obj], p);
        return shapeDoc(obj, mods, options);
      });
    },

    findByIdAndUpdate(id, update, options = {}) {
      return Model.findOneAndUpdate({ _id: castId(id) }, update, options);
    },

    findOneAndDelete(filter, options = {}) {
      return chain((mods) =>
        transaction(async () => {
          const [obj] = await selectObjects(filter, { sort: parseSort(options.sort ?? mods.sort), limit: 1, forUpdate: true });
          if (!obj) return null;
          await exec(`DELETE FROM ${q(tableName)} WHERE _id = ?`, [String(obj._id)]);
          return shapeDoc(obj, mods, options);
        }),
      );
    },

    findByIdAndDelete(id, options = {}) {
      return Model.findOneAndDelete({ _id: castId(id) }, options);
    },

    async deleteOne(filter) {
      const w = buildWhere(info, filter);
      if (w.exact) {
        const res = await exec(`DELETE FROM ${q(tableName)} AS t WHERE ${w.sql} LIMIT 1`, w.params);
        return { acknowledged: true, deletedCount: res.affectedRows };
      }
      const [obj] = await selectObjects(filter, { limit: 1 });
      if (!obj) return { acknowledged: true, deletedCount: 0 };
      await exec(`DELETE FROM ${q(tableName)} WHERE _id = ?`, [String(obj._id)]);
      return { acknowledged: true, deletedCount: 1 };
    },

    async deleteMany(filter = {}) {
      const w = buildWhere(info, filter);
      if (w.exact) {
        const res = await exec(`DELETE FROM ${q(tableName)} AS t WHERE ${w.sql}`, w.params);
        return { acknowledged: true, deletedCount: res.affectedRows };
      }
      const objs = await selectObjects(filter);
      if (!objs.length) return { acknowledged: true, deletedCount: 0 };
      const ids = objs.map((o) => String(o._id));
      await exec(`DELETE FROM ${q(tableName)} WHERE _id IN (${ids.map(() => '?').join(', ')})`, ids);
      return { acknowledged: true, deletedCount: ids.length };
    },

    aggregate(pipeline) {
      const p = aggregate(pipeline);
      return Object.assign(p, { exec: () => p, allowDiskUse: () => p });
    },

    async bulkWrite(ops, { ordered = true } = {}) {
      const writeErrors = [];
      let matched = 0;
      let modified = 0;
      let upserted = 0;
      let inserted = 0;
      for (const [index, op] of ops.entries()) {
        try {
          if (op.updateOne) {
            const r = await Model.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
            matched += r.matchedCount;
            modified += r.modifiedCount;
            upserted += r.upsertedCount;
          } else if (op.updateMany) {
            const r = await Model.updateMany(op.updateMany.filter, op.updateMany.update, { upsert: op.updateMany.upsert });
            matched += r.matchedCount;
            modified += r.modifiedCount;
          } else if (op.insertOne) {
            await createOne(op.insertOne.document);
            inserted++;
          } else if (op.deleteOne) await Model.deleteOne(op.deleteOne.filter);
          else if (op.deleteMany) await Model.deleteMany(op.deleteMany.filter);
          else throw new Error('Unsupported bulkWrite operation');
        } catch (err) {
          if (ordered) throw err;
          writeErrors.push({ index, code: err.code, errmsg: err.message });
        }
      }
      if (writeErrors.length) {
        const e = new Error('Bulk write error');
        e.code = writeErrors[0].code;
        e.writeErrors = writeErrors;
        throw e;
      }
      return { matchedCount: matched, modifiedCount: modified, upsertedCount: upserted, insertedCount: inserted };
    },

    hydrate(obj) {
      return hydrateDoc(obj);
    },

    /**
     * Migration: writes raw documents (from MongoDB) as rows, keeping _id and timestamps.
     * Missing fields get their schema defaults; no validation (old data stays as it is).
     * Existing rows with the same _id are overwritten, so the import can run again.
     */
    async importRaw(docs) {
      if (!docs.length) return 0;
      const rows = [];
      for (const raw of docs) {
        let obj;
        try {
          obj = new Local(raw).toObject({ depopulate: true, virtuals: false, getters: false });
        } catch {
          obj = Local.castObject(raw, { ignoreCastErrors: true });
        }
        obj._id = raw._id;
        for (const k of [info.timestamps.createdAt, info.timestamps.updatedAt]) if (k && raw[k]) obj[k] = raw[k];
        rows.push(toRow(obj));
      }
      const cols = info.columns.map((c) => c.name);
      const placeholders = `(${info.columns.map((c) => (c.json ? 'CAST(? AS JSON)' : '?')).join(', ')})`;
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        await exec(
          `INSERT INTO ${q(tableName)} (${cols.map(q).join(', ')}) VALUES ${batch.map(() => placeholders).join(', ')} ` +
            `ON DUPLICATE KEY UPDATE ${cols.filter((c) => c !== '_id').map((c) => `${q(c)} = VALUES(${q(c)})`).join(', ')}`,
          batch.flatMap((r) => cols.map((c) => r[c])),
        );
      }
      return rows.length;
    },

    /** Creates the table / missing columns / missing indexes (idempotent). */
    async syncIndexes() {
      const { syncTable } = await import('./ddl.js');
      return syncTable(info);
    },
  };

  // `.exec()` / `.lean()` / `.session()` also work on the other statics (as in Mongoose).
  const rawCount = Model.countDocuments;
  Model.countDocuments = (filter, ...rest) => chain((mods) => rawCount(filter, mods, ...rest));
  for (const fn of ['estimatedDocumentCount', 'exists', 'distinct', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany']) {
    const orig = Model[fn];
    Model[fn] = (...args) => chain(() => orig(...args));
  }

  // Documents from non-lean queries can be saved back.
  Local.prototype.save = async function save() {
    if (this.isNew || this.$isNew) {
      await createOne(this);
      return this;
    }
    await this.validate();
    if (info.timestamps.updatedAt) this.set(info.timestamps.updatedAt, new Date());
    await writeObject(this.toObject({ depopulate: true }), null);
    return this;
  };

  registry.set(name, Model);
  return Model;
}

export { colName };
