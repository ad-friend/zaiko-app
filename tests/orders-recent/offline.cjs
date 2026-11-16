// Nodeと子プロセスに適用。外部接続と.env読み取りを禁止する。
require('../sales-analysis/offline-test.cjs');
const fs = require('node:fs');
const path = require('node:path');
const protectedPath = p => /^\.env(?:\.|$)/.test(path.basename(String(p)));
const denyRead = () => Object.assign(new Error('OFFLINE: protected file unavailable'), {code:'ENOENT'});
const read = fs.readFile;
fs.readFile = function(p, ...args) { if(protectedPath(p)) { const cb=args.at(-1); if(typeof cb==='function') return process.nextTick(cb,denyRead()); throw denyRead(); } return read.call(this,p,...args); };
const open = fs.openSync;
fs.openSync = function(p,...args) { if(protectedPath(p)) throw denyRead(); return open.call(this,p,...args); };
const tls = require('node:tls'); tls.connect = () => { throw new Error('OFFLINE: TLS denied'); };
const dgram = require('node:dgram'); dgram.createSocket = () => { throw new Error('OFFLINE: UDP denied'); };
process.env.NEXT_TELEMETRY_DISABLED='1';
