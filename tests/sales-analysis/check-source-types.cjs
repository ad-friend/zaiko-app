/* eslint-disable @typescript-eslint/no-require-imports -- 検証用CommonJS */
const ts = require('typescript');
const path = require('node:path');
const loaded = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
if (loaded.error) throw new Error('tsconfigの読取に失敗しました');
const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, process.cwd());
// 全ソースを型検査する。Next生成のroute export検査はbuild側で別に報告する。
const sources = config.fileNames.filter(file => !file.replaceAll('\\', '/').includes('/.next/'));
const program = ts.createProgram(sources, { ...config.options, incremental: false, noEmit: true });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => path.resolve(name), getCurrentDirectory: process.cwd, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log(`全ソースTypeScript検査: ${sources.length}ファイル、エラー0（Next生成route export検査を除く）`);
