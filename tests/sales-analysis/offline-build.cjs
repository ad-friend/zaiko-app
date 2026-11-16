/* eslint-disable @typescript-eslint/no-require-imports -- Node起動時のpreloadはCommonJSを使う */
// build専用。認証ファイルを開かず、外向き通信を拒否する。アプリ本体には組み込まない。
const fs = require('node:fs');
const path = require('node:path');
const protectedPath = p => typeof p === 'string' && /^\.env(?:\.|$)/.test(path.basename(p));
const missing = () => Object.assign(new Error('offline build: env file is unavailable'), { code: 'ENOENT' });
for (const name of ['readFileSync', 'statSync', 'lstatSync']) {
  const original = fs[name]; fs[name] = function(p, ...rest) { if (protectedPath(p)) throw missing(); return original.call(this, p, ...rest); };
}
const exists = fs.existsSync; fs.existsSync = p => protectedPath(p) ? false : exists(p);
for (const name of ['readFile', 'stat', 'lstat']) {
  const original = fs.promises[name]; fs.promises[name] = async function(p, ...rest) { if (protectedPath(p)) throw missing(); return original.call(this, p, ...rest); };
}
const deny = () => { throw new Error('OFFLINE: network access denied'); };
globalThis.fetch = deny;
for (const protocol of ['node:http', 'node:https']) {
  const transport = require(protocol); transport.request = deny; transport.get = deny;
}
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  // buildワーカーのローカルIPCだけ許可する。
  if (typeof first === 'string' || (first && typeof first === 'object' && (first.path || ['127.0.0.1', '::1', 'localhost'].includes(first.host)))) return connect.apply(this, args);
  return deny();
};
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://offline.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'offline-build-placeholder';
process.env.NEXT_TELEMETRY_DISABLED = '1';
