import { ItemBlock } from '../../src/tui-pi/blocks.js';

/**
 * 验证流式增量渲染：① 性能是否随内容量增长；② 渲染结果是否与全量路径逐字节一致。
 *
 * ② 是重点：增量渲染一旦算错就是显示错内容，必须和全量 renderMarkdown 等价。
 */
const WIDTH = 198;

function buildCode(n: number): string {
  let s = '```ts\n';
  for (let i = 0; i < n; i++) s += `const value${i} = compute(${i}, ${i * 2}); // 注释文字\n`;
  s += '```\n';
  return s;
}

/** 全量渲染（对照组）：每帧新建 ItemBlock，绕开增量缓存，但走同一条 renderItem 路径。 */
function fullRender(text: string, width: number): string[] {
  const b = new ItemBlock({ kind: 'assistant', text } as any);
  return b.render(width);
}

/** 增量渲染（被测）：同一个 ItemBlock 反复 setItem。 */
function streamRender(steps: string[], width: number): { lines: string[][]; ms: number[] } {
  const b = new ItemBlock({ kind: 'assistant', text: '' } as any);
  const lines: string[][] = [];
  const ms: number[] = [];
  for (const t of steps) {
    b.setItem({ kind: 'assistant', text: t } as any);
    const t0 = process.hrtime.bigint();
    const out = b.render(width);
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    lines.push(out);
  }
  return { lines, ms };
}

const code = buildCode(200);
const doc = `## 标题\n\n这是**加粗**与\`代码\`混排的说明段落，长度适中用于触发换行。\n\n${code}\n\n结尾段落，含 [链接](https://example.com)。\n`;

// 40 次流式追加
const steps: string[] = [];
for (let i = 1; i <= 40; i++) steps.push(doc.slice(0, Math.floor((doc.length * i) / 40)));

console.log('=== 性能对比（单帧耗时，ms）===');
const inc = streamRender(steps, WIDTH);
const fullMs: number[] = [];
for (const t of steps) {
  const t0 = process.hrtime.bigint();
  fullRender(t, WIDTH);
  fullMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
const firstInc = avg(inc.ms.slice(0, 5));
const lastInc = avg(inc.ms.slice(-5));
const firstFull = avg(fullMs.slice(0, 5));
const lastFull = avg(fullMs.slice(-5));
console.log(`增量路径：前5帧 ${firstInc.toFixed(2)}ms · 后5帧 ${lastInc.toFixed(2)}ms · 增长 ${(lastInc / firstInc).toFixed(2)}x`);
console.log(`全量路径：前5帧 ${firstFull.toFixed(2)}ms · 后5帧 ${lastFull.toFixed(2)}ms · 增长 ${(lastFull / firstFull).toFixed(2)}x`);
console.log(`后5帧加速比：${(lastFull / lastInc).toFixed(2)}x`);

console.log('\n=== 正确性：增量 vs 全量逐帧比对 ===');
let mismatch = 0;
for (let i = 0; i < steps.length; i++) {
  const want = fullRender(steps[i], WIDTH);
  const got = inc.lines[i];
  if (want.length !== got.length) {
    mismatch++;
    if (mismatch <= 3) console.log(`  帧${i}: 行数 ${got.length} vs 全量 ${want.length}`);
    continue;
  }
  for (let r = 0; r < want.length; r++) {
    if (want[r] !== got[r]) {
      mismatch++;
      if (mismatch <= 3) {
        console.log(`  帧${i} 行${r} 不一致`);
        console.log(`    增量: ${JSON.stringify(got[r].slice(0, 80))}`);
        console.log(`    全量: ${JSON.stringify(want[r].slice(0, 80))}`);
      }
      break;
    }
  }
}
console.log(`\n${steps.length} 帧比对，不一致 ${mismatch} 帧`);
console.log(mismatch === 0 ? 'PASS：增量渲染与全量逐字节一致' : 'FAIL：存在渲染差异');
