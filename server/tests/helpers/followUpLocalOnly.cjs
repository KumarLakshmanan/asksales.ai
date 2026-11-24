// Audit-only isolation: reject all outbound TCP except ephemeral loopback HTTP test servers.
const net = require('node:net');
const fs = require('node:fs');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node net.connect can forward a normalized [options, callback] array.
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const a = normalized[0];
  let port, host;
  if (typeof a === 'object') { port = Number(a.port); host = a.host || 'localhost'; }
  else { port = Number(a); host = typeof normalized[1] === 'string' ? normalized[1] : 'localhost'; }
  if (!['127.0.0.1','::1','localhost'].includes(host) || !(port >= 32768)) {
    throw new Error(`AUDIT_NETWORK_BLOCKED ${String(host)}:${String(port)}`);
  }
  return connect.apply(this, args);
};
const check = p => {
  if (typeof p === 'string' && /(?:^|\/)\.env(?:\.|$)/.test(p)) throw new Error('AUDIT_ENV_FILE_BLOCKED');
};
const readSync = fs.readFileSync;
fs.readFileSync = function (p,...args) { check(p); return readSync.call(this,p,...args); };
const read = fs.readFile;
fs.readFile = function (p,...args) { check(p); return read.call(this,p,...args); };
const promiseRead = fs.promises.readFile;
fs.promises.readFile = function (p,...args) { check(p); return promiseRead.call(this,p,...args); };
require('node:module').syncBuiltinESMExports();
