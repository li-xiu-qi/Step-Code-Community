import { Editor } from '@earendil-works/pi-tui';
import { editorTheme } from './src/tui-pi/theme.js';

const ed = new Editor(null, editorTheme, {});
const original = '第一行（含括号）\n第二行 [德] 黑格尔\n第三行 (z-library.sk)';
console.log('原文长度:', original.length);

ed.setText(original);
console.log('短文本 getText 长度:', ed.getText().length);
console.log('短文本一致?', ed.getText() === original);

ed.pastes.set(1, original);
ed.pasteCounter = 1;
(ed as unknown as { state: object }).state = { lines: ['[paste #1 120 lines]'], cursorLine: 0, cursorCol: 0 };
console.log('\n--- 折叠态 ---');
console.log('getText():', JSON.stringify(ed.getText()));
console.log('getExpandedText() 长度:', ed.getExpandedText().length);
console.log('展开后一致?', ed.getExpandedText() === original);
