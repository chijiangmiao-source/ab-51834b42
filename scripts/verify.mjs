// scripts/verify.mjs — Compose verify 单次服务入口：
// 1) 前端构建检查  2) 代码测试  3) API/HTTP 冒烟
// 任一步失败即以非零退出码报告。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(name, args, opts = {}) {
  return new Promise((resolve) => {
    console.log(`\n=== ${name} ===`);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...(opts.env || {}) }
    });
    child.on('exit', (code) => {
      console.log(`--- ${name} 退出码 ${code} ---`);
      resolve(code ?? 1);
    });
  });
}

const results = [];

results.push(['前端构建检查', await run('前端构建检查', ['scripts/build-frontend.js'])]);
results.push([
  '代码测试',
  await run('代码测试 (node --test)', [
    '--test',
    'test/store.test.mjs',
    'test/core.test.mjs',
    'test/api.test.mjs'
  ])
]);
results.push(['API/HTTP 冒烟', await run('API/HTTP 冒烟', ['scripts/smoke.mjs'])]);

console.log('\n========== verify 汇总 ==========');
let failed = 0;
for (const [name, code] of results) {
  const pass = code === 0;
  if (!pass) failed += 1;
  console.log(`${pass ? '✓ 通过' : '✗ 失败'}  ${name}（exit ${code}）`);
}
if (failed) {
  console.error(`\n${failed}/${results.length} 个阶段失败`);
  process.exit(1);
}
console.log('\n全部复核通过');
