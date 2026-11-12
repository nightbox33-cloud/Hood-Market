// PoC shim: node:sqlite dressed up as the `sqlite3` callback API.
const { DatabaseSync } = require('node:sqlite');
class Database {
  constructor(path, cb) { this._db = new DatabaseSync(path); if (cb) setTimeout(() => cb(null), 0); }
  serialize(fn) { fn(); return this; }
  run(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    try { this._db.prepare(sql).run(...(params || [])); cb && cb(null); }
    catch (e) { if (cb) cb(e); else throw e; }
    return this;
  }
  get(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    let row;
    try { row = this._db.prepare(sql).get(...(params || [])); } catch (e) { return void cb(e); }
    cb(null, row === undefined ? undefined : { ...row });
    return this;
  }
  all(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    let rows;
    try { rows = this._db.prepare(sql).all(...(params || [])); } catch (e) { return void cb(e); }
    cb(null, rows.map((r) => ({ ...r })));
    return this;
  }
  close(cb) { try { this._db.close(); } catch {} cb && cb(null); }
}
module.exports = { Database, verbose: () => module.exports };
