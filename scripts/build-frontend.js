// scripts/build-frontend.js
// “前端构建检查”：无打包工具栈，改为严格的静态校验——
// 语法解析全部前端 ES Module、检查 HTML 引用的本地资源均存在、
// 模块 import 路径可解析。产物即 public/ 本身（浏览器直接加载）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

let failures = 0;
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failures += 1;
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

// node --check 按 package.json type=module 以 ESM 解析。
function syntaxCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`${path.relative(ROOT, file)} 语法错误：${(r.stderr || '').split('\n')[0]}`);
  else ok(`${path.relative(ROOT, file)} 语法通过`);
}

// 1) 前端 JS 语法检查
const jsFiles = fs.readdirSync(PUB).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) syntaxCheck(path.join(PUB, f));

// 2) 服务端 JS 语法检查
for (const f of ['server/server.js', 'server/store.js', 'server/hub.js']) {
  syntaxCheck(path.join(ROOT, f));
}

// 3) HTML 引用资源存在性 + import 路径解析
const importRe = /from\s+['"](\.[^'"]+)['"]/g;
for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(PUB, f), 'utf8');
  let m;
  while ((m = importRe.exec(code))) {
    const target = path.resolve(path.join(PUB, f), '..', m[1]);
    if (!fs.existsSync(target)) fail(`${f} -> ${m[1]} 不存在`);
    else ok(`${f} -> ${m[1]} 可解析`);
  }
}

for (const html of fs.readdirSync(PUB).filter((f) => f.endsWith('.html'))) {
  const code = fs.readFileSync(path.join(PUB, html), 'utf8');
  const refs = [...code.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((x) => x[1]);
  for (const r of refs) {
    const target = path.join(PUB, r.replace(/^\//, ''));
    if (!fs.existsSync(target)) fail(`${html} 引用 ${r} 不存在`);
    else ok(`${html} 引用 ${r} 存在`);
  }
}

// 4) 输出“构建产物清单”
const dist = path.join(ROOT, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist), { recursive: true });
fs.cpSync(PUB, path.join(dist, 'public'), { recursive: true });
ok(`构建产物已输出到 dist/public（${fs.readdirSync(path.join(dist, 'public')).length} 个文件）`);

if (failures) {
  console.error(`\n前端构建检查失败：${failures} 个问题`);
  process.exit(1);
}
console.log('\n前端构建检查通过');
