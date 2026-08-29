import { Text, VStack, type Component } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';

function makeTree(n: number): Component {
  const kids: Component[] = Array.from({ length: n }, (_, i) =>
    new Text(`agent-${i} · 描述文字 · 12 tools · 运行中 · grep something ${i}`),
  );
  return new VStack(kids);
}
const W = 120, H = 40;
for (const n of [10, 50, 100, 300, 1000, 3000]) {
  const root = makeTree(n);
  for (let i = 0; i < 5; i++) renderLayoutFrame(root, W, H, () => {});
  const t0 = performance.now();
  const R = 100;
  for (let i = 0; i < R; i++) renderLayoutFrame(root, W, H, () => {});
  const per = (performance.now() - t0) / R;
  console.log(`${String(n).padStart(5)} 行: ${per.toFixed(3)} ms/帧   ${(1000 / per).toFixed(0)} fps 上限`);
}
