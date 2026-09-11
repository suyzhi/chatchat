/**
 * 前端模块图静态检查。
 *
 * 浏览器的 ESM 是运行时解析的，一个拼错的具名导入只有在真正跑起来时才会炸。
 * 这个脚本把 public/js 下所有 import 语句解析出来，逐个核对：
 *  1. 目标文件是否存在；
 *  2. 具名导入在目标文件里是否真的有对应的 export；
 *  3. 顺带找出「被 import 了但目标没有该导出」和「import 路径写错」的情况。
 *
 * 用法： node tools/check-imports.mjs
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = join(ROOT, 'public', 'js');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 收集一个模块导出的所有名字 */
function exportsOf(source) {
  const names = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s*\{([^}]*)\}/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      if (re.source.startsWith('export\\s*\\{')) {
        for (const part of m[1].split(',')) {
          const piece = part.trim();
          if (!piece) continue;
          // 支持 `a as b`
          const alias = piece.split(/\s+as\s+/);
          names.add((alias[1] || alias[0]).trim());
        }
      } else {
        names.add(m[1]);
      }
    }
  }
  if (/export\s+default\b/.test(source)) names.add('default');
  if (/export\s*\*\s*from/.test(source)) names.add('*');
  return names;
}

/** 解析一个模块里的 import 语句 */
function importsOf(source) {
  const out = [];
  const re = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    const clause = m[1].trim();
    const spec = m[2];
    const named = [];
    let namespace = null;
    let hasDefault = false;

    const braceMatch = clause.match(/\{([\s\S]*)\}/);
    if (braceMatch) {
      for (const part of braceMatch[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const alias = piece.split(/\s+as\s+/);
        named.push({ imported: alias[0].trim(), local: (alias[1] || alias[0]).trim() });
      }
    }
    const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (nsMatch) namespace = nsMatch[1];
    const beforeBrace = clause.split('{')[0].replace(/,/g, '').trim();
    if (beforeBrace && !beforeBrace.startsWith('*')) hasDefault = true;

    out.push({ spec, named, namespace, hasDefault, raw: m[0] });
  }
  return out;
}

const files = await walk(JS_DIR);
const cache = new Map();
const load = async (p) => {
  if (!cache.has(p)) cache.set(p, await readFile(p, 'utf8'));
  return cache.get(p);
};

let problems = 0;
const warn = (file, msg) => {
  problems += 1;
  console.log(`  ${relative(ROOT, file).replace(/\\/g, '/')}\n    -> ${msg}`);
};

console.log(`检查 ${files.length} 个前端模块的 import / export 一致性\n`);

for (const file of files) {
  const src = await load(file);
  for (const imp of importsOf(src)) {
    if (!imp.spec.startsWith('.')) continue; // 裸模块名不走相对解析

    const target = resolve(dirname(file), imp.spec);
    let info;
    try {
      info = await stat(target);
    } catch {
      warn(file, `import 的目标不存在： ${imp.spec}`);
      continue;
    }
    if (!info.isFile()) {
      warn(file, `import 的目标不是文件： ${imp.spec}`);
      continue;
    }

    const targetSrc = await load(target);
    const available = exportsOf(targetSrc);

    if (available.has('*')) continue; // 有 export * from，无法静态确定

    for (const { imported, local } of imp.named) {
      if (!available.has(imported)) {
        warn(
          file,
          `导入了 ${JSON.stringify(imported)}（本地名 ${local}），但 ${imp.spec} 没有导出它。` +
            `\n       该文件实际导出： ${[...available].sort().join(', ') || '(无)'}`,
        );
      }
    }
    if (imp.hasDefault && !available.has('default')) {
      warn(file, `使用了默认导入，但 ${imp.spec} 没有 export default`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 反向检查：写了但没被任何地方引用的导出（只提示，不算错误）           */
/* ------------------------------------------------------------------ */

const referenced = new Set();
for (const file of files) {
  for (const imp of importsOf(await load(file))) {
    if (!imp.spec.startsWith('.')) continue;
    const target = resolve(dirname(file), imp.spec);
    for (const { imported } of imp.named) referenced.add(`${target}::${imported}`);
    if (imp.namespace) referenced.add(`${target}::*`);
  }
}

const entry = join(JS_DIR, 'app.js');
const unused = [];
for (const file of files) {
  if (file === entry) continue;
  const src = await load(file);
  for (const name of exportsOf(src)) {
    if (name === 'default' || name === '*') continue;
    if (!referenced.has(`${file}::${name}`) && !referenced.has(`${file}::*`)) {
      unused.push(`${relative(ROOT, file).replace(/\\/g, '/')} 导出 ${name}`);
    }
  }
}

console.log(problems === 0 ? '所有 import 都能解析到对应的导出。' : `\n发现 ${problems} 个问题。`);
if (unused.length) {
  console.log(`\n以下导出没有被任何模块 import（可能是有意留的接口，仅提示）：`);
  for (const u of unused) console.log(`  - ${u}`);
}
process.exit(problems === 0 ? 0 : 1);
