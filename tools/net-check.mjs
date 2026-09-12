/**
 * 构建前连通性自检：在 builder 镜像里跑，确认 npm registry 和 GitHub
 * 这两条路都通。better-sqlite3 是原生模块，npm 会优先去 GitHub Releases
 * 下预编译二进制；那条路不通就得现编译，而现编译要求 apt 装得上
 * python3/make/g++ —— 也就是 Debian 源要能用。
 *
 * 跑法：docker run --rm -v /tmp/net-check.mjs:/net-check.mjs:ro node:22-bookworm-slim node /net-check.mjs
 */
const targets = [
  ['npm registry', 'https://registry.npmjs.org/better-sqlite3'],
  ['github', 'https://github.com'],
  ['github releases', 'https://objects.githubusercontent.com'],
];

let bad = 0;
for (const [name, url] of targets) {
  const t = Date.now();
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(12000) });
    console.log(`  ok    ${name.padEnd(16)} ${res.status}  ${Date.now() - t}ms`);
  } catch (err) {
    bad += 1;
    console.log(`  FAIL  ${name.padEnd(16)} ${err.message}`);
  }
}

// 用退出码表达结果，这样才能真的拿来卡构建/卡部署
if (bad) {
  console.log(`\n${bad} 个目标不通。`);
  process.exit(1);
}
console.log('\n全部可达。');
