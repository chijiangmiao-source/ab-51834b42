// scripts/verify-compose.mjs — Compose verify 单次服务入口：
// 先对已就绪的 app 做只读探针（健康路径 + 监看页），
// 再依次执行 代码测试、前端构建检查、API/HTTP 冒烟（容器内临时实例），
// 最后以退出码报告结果。
import { execFileSync } from 'node:child_process';

const app = process.env.APP_BASE || 'http://app:8080';

async function probe() {
  for (let i = 0; i < 30; i++) {
    try {
      const h = await fetch(`${app}/health`);
      const p = await fetch(`${app}/monitor.html`);
      if (h.ok && p.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

if (!(await probe())) {
  console.error('app 就绪探针失败：/health 或 /monitor.html 不可访问');
  process.exit(1);
}
console.log('app 就绪探针通过：健康路径与监看页均可访问');

const steps = [
  ['代码测试', ['--test', 'test/store.test.mjs', 'test/core.test.mjs', 'test/api.test.mjs']],
  ['前端构建检查', ['scripts/build-frontend.js']],
  ['API/HTTP 冒烟（容器内临时实例）', ['scripts/smoke.mjs']]
];

let code = 0;
for (const [name, args] of steps) {
  console.log(`\n=== ${name} ===`);
  try {
    execFileSync(process.execPath, args, { stdio: 'inherit' });
  } catch {
    code = 1;
    console.error(`${name} 失败`);
  }
}

console.log(code === 0 ? '\nverify 全部复核通过' : '\nverify 存在失败阶段');
process.exit(code);
