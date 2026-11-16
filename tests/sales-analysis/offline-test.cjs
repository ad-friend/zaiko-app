/* eslint-disable @typescript-eslint/no-require-imports -- Node起動時のpreload */
require('./offline-build.cjs');
// この実行環境でuv_os_get_passwdがENOMEMになるため、tsxの一時領域名だけ固定する。
const os = require('node:os');
os.userInfo = () => ({ username: 'sales-analysis-test', uid: -1, gid: -1, shell: null, homedir: process.cwd() });
