import { createHash } from 'node:crypto';

/**
 * Turns a Mongoose schema (kept only as the model definition: fields, defaults, enums,
 * indexes) into a MySQL table layout:
 *  - every scalar field is a typed column; fields of plain nested objects are flattened
 *    (`subscription.trialEndsAt` -> column `subscription__trialEndsAt`);
 *  - sub-documents, arrays and Mixed values are JSON columns;
 *  - `_id` is CHAR(24) (the ObjectId hex: ordered by creation time, kept from MongoDB).
 */
const SCALAR = new Set(['String', 'Number', 'Boolean', 'Date', 'ObjectId']);

export const colName = (path) => path.replace(/\./g, '__');

function stringType(st, indexed) {
  const o = st.options ?? {};
  const max = Array.isArray(o.maxlength) ? o.maxlength[0] : o.maxlength;
  if (indexed) return 'VARCHAR(191)';
  if (o.enum) return 'VARCHAR(64)';
  if (max && max <= 1000) return `VARCHAR(${max})`;
  return 'TEXT';
}

function sqlType(st, indexed) {
  switch (st.instance) {
    case 'String':
      return stringType(st, indexed);
    case 'ObjectId':
      return 'CHAR(24) CHARACTER SET ascii COLLATE ascii_bin';
    case 'Number':
      return 'DOUBLE';
    case 'Boolean':
      return 'TINYINT(1)';
    case 'Date':
      return 'DATETIME(3)';
    default:
      return 'JSON';
  }
}

/** Element type of an array path ('ObjectId', 'String', 'Embedded' for sub-documents ...). */
function arrayElement(st) {
  if (st.schema) return { instance: 'Embedded', schema: st.schema };
  const el = st.embeddedSchemaType ?? st.caster ?? st.$embeddedSchemaType;
  return { instance: el?.instance ?? 'Mixed', schema: el?.schema ?? null };
}

function indexName(table, cols, unique) {
  const base = `${unique ? 'ux' : 'ix'}_${table}_${cols.join('_')}`;
  if (base.length <= 64) return base;
  return `${base.slice(0, 55)}_${createHash('sha1').update(base).digest('hex').slice(0, 8)}`;
}

export function analyzeSchema(schema, table) {
  const indexes = schema.indexes();
  const indexedPaths = new Set();
  for (const [fields] of indexes) for (const f of Object.keys(fields)) indexedPaths.add(f);

  const columns = [];
  const byPath = new Map();
  for (const [path, st] of Object.entries(schema.paths)) {
    if (path === '__v') continue;
    const scalar = SCALAR.has(st.instance);
    const col = {
      path,
      name: path === '_id' ? '_id' : colName(path),
      instance: st.instance,
      json: !scalar,
      isArray: st.instance === 'Array',
      element: st.instance === 'Array' ? arrayElement(st) : null,
      subSchema: st.schema ?? null,
      selectFalse: st.options?.select === false,
      sql: path === '_id' ? 'CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL' : sqlType(st, indexedPaths.has(path)),
    };
    columns.push(col);
    byPath.set(path, col);
  }
  // Plain nested objects ("privacy", "subscription"): their leaves are flattened columns.
  const nested = new Set(Object.keys(schema.nested ?? {}));

  const sqlIndexes = [];
  for (const [fields, options = {}] of indexes) {
    const keys = Object.entries(fields);
    if (keys.some(([, dir]) => dir === 'text' || dir === 'hashed' || dir === '2dsphere')) continue;
    if (!keys.every(([f]) => byPath.get(f) && !byPath.get(f).json)) continue; // JSON paths: no plain index
    const cols = keys.map(([f]) => byPath.get(f).name);
    const unique = Boolean(options.unique);
    sqlIndexes.push({
      name: indexName(table, cols, unique),
      unique,
      cols: keys.map(([f, dir]) => `\`${byPath.get(f).name}\`${dir === -1 ? ' DESC' : ''}`),
    });
  }

  const ts = schema.options?.timestamps;
  return {
    table,
    columns,
    byPath,
    nested,
    indexes: sqlIndexes,
    timestamps: {
      createdAt: ts ? (ts === true || ts.createdAt !== false ? 'createdAt' : null) : null,
      updatedAt: ts ? (ts === true || ts.updatedAt !== false ? 'updatedAt' : null) : null,
    },
    selectFalse: columns.filter((c) => c.selectFalse).map((c) => c.path),
  };
}

/** Type information of a schema path inside a sub-document schema. */
function subPathInfo(schema, rest) {
  if (!schema) return { instance: 'Mixed', isArray: false };
  const st = schema.path(rest);
  if (st) return { instance: st.instance, isArray: st.instance === 'Array', element: st.instance === 'Array' ? arrayElement(st) : null };
  // deeper inside an array of sub-documents / nested sub-document
  const parts = rest.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join('.');
    const hst = schema.path(head);
    if (hst?.schema) return subPathInfo(hst.schema, parts.slice(i).join('.'));
  }
  return { instance: 'Mixed', isArray: false };
}

/**
 * Where a query path lives: { col, jsonPath|null, instance, isArray, element } or null for
 * a parent of flattened columns ("privacy" -> nestedParent).
 */
export function resolvePath(info, path) {
  if (path === 'id') path = '_id';
  const direct = info.byPath.get(path);
  if (direct) return { col: direct, jsonPath: null, instance: direct.instance, isArray: direct.isArray, element: direct.element };
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join('.');
    const c = info.byPath.get(head);
    if (!c) continue;
    const rest = parts.slice(i).join('.');
    const restParts = parts.slice(i);
    // "reactions.user" on an array of sub-documents = the values of every element ($[*]);
    // numeric segments address one element: "reactions.0.user".
    const anyElement = c.isArray && !/^\d+$/.test(restParts[0]);
    const jsonPath = `$${anyElement ? '[*]' : ''}${restParts.map((p) => (/^\d+$/.test(p) ? `[${p}]` : `."${p}"`)).join('')}`;
    const schemaForRest = c.subSchema ?? c.element?.schema ?? null;
    const sub = subPathInfo(schemaForRest, rest.replace(/(^|\.)\d+(?=\.|$)/g, '').replace(/^\./, ''));
    return { col: c, jsonPath, instance: sub.instance, isArray: anyElement || sub.isArray, element: anyElement ? { instance: sub.instance } : sub.element, wildcard: anyElement };
  }
  if (info.nested.has(path)) return { nestedParent: path, leaves: info.columns.filter((c) => c.path.startsWith(`${path}.`)) };
  return null;
}
