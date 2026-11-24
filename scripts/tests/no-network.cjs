// Safety backstop for synthetic operational tests. This is not a hostile-code sandbox.
const net = require('node:net');
const dgram = require('node:dgram');
const dns = require('node:dns');
const { syncBuiltinESMExports } = require('node:module');
function blocked() { throw new Error('TEST_NETWORK_DISABLED'); }
net.Socket.prototype.connect = blocked;
dgram.Socket.prototype.send = blocked;
dns.lookup = blocked;
dns.resolve = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
