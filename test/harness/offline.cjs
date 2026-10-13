// Wrangler's banner/error helpers can check npm even in --local mode. Constrain its
// Node control process to loopback and local pipes before any SDK code loads.
const net = require('node:net');
const { isIP } = net;
function localConnection(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'string' && !/^\d+$/.test(first)) return true; // local pipe
  if (first && typeof first === 'object' && first.path) return true;
  const host = first && typeof first === 'object' ? first.hostname ?? first.host ?? 'localhost'
    : typeof args[1] === 'string' ? args[1] : 'localhost';
  return host === 'localhost' || host === '::1' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (!localConnection(args)) throw new Error('engine harness refuses a non-loopback connection');
  return connect.apply(this, args);
};
module.exports = { localConnection };
