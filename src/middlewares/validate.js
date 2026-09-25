/**
 * Validates request parts with zod schemas. Parsed values are exposed on
 * `req.valid` (Express 5 makes `req.query` read-only). Strict schemas also
 * stop NoSQL operator injection because unknown / object values are rejected.
 */
export const validate =
  ({ body, query, params } = {}) =>
  (req, _res, next) => {
    req.valid = {
      body: body ? body.parse(req.body ?? {}) : undefined,
      query: query ? query.parse(req.query ?? {}) : undefined,
      params: params ? params.parse(req.params ?? {}) : undefined,
    };
    next();
  };
