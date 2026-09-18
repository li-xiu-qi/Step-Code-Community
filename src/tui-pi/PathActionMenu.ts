/**
 * 路径动作菜单：单击转录区里的路径链接后弹出的浮层，用完即走。
 *
 * 为什么是单击弹菜单而不是单击直接打开：路径链接的点击意图有三种（打开、
 * 在文件夹里定位、复制路径给别处用），直接打开把三种意图压成一种，误点
 * 就把编辑器弹到前台。双击的问题是与终端选词冲突（双击即选中单词），
 * 且会顺带取消单击的打开语义，两个都不讨好。
 *
 * 菜单项按目标类型区分：文件有三项（打开 / 在文件夹中显示 / 复制路径），
 * 目录没有「选中」概念只剩两项（打开 / 复制路径）。
 *
 * 交互复用 ChoiceBlock 基类（↑↓/Enter/数字直选/Esc 的键位与审批弹层一致，
 * 跨界面共享终端肌肉记忆），本类只提供题干（路径本体）与选中后的动作分发。
 */
import { basename } from 'node:path';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { ChoiceBlock, type Choice } from './ChoiceBlock.js';
import { c } from './theme.js';
import { t } from '../i18n.js';

export type PathAction = 'open' | 'reveal' | 'copy';

/**
 * 按目标类型构造菜单。动作回调由 PiChat 注入（打开/reveal 走系统交付，
 * 复制走 OSC 52），本类不直接碰系统，测试用内存回调即可覆盖全部路径。
 */
export function pathActionChoices(isDir: boolean): Array<Choice<PathAction>> {
  const choices: Array<Choice<PathAction>> = [
    { label: t('pathAction.open'), value: 'open' },
  ];
  if (!isDir) choices.push({ label: t('pathAction.reveal'), value: 'reveal' });
  choices.push({ label: t('pathAction.copy'), value: 'copy' });
  return choices;
}

export class PathActionMenu extends ChoiceBlock<PathAction> {
  private readonly path: string;
  private readonly isDir: boolean;

  private readonly onAction: (action: PathAction) => void;
  private readonly cancelAction: () => void;

  constructor(opts: {
    /** 已按 cwd 解析的绝对路径（菜单显示与动作都用它）。 */
    path: string;
    isDir: boolean;
    onAction: (action: PathAction) => void;
    onCancel: () => void;
    requestRender: () => void;
  }) {
    super(pathActionChoices(opts.isDir), opts.requestRender);
    this.path = opts.path;
    this.isDir = opts.isDir;
    this.onAction = opts.onAction;
    this.cancelAction = opts.onCancel;
  }

  /** 题干：标题 + 路径本体（文件名高亮，目录标 dim）。 */
  protected renderBody(width: number): string[] {
    const name = basename(this.path) || this.path;
    const head = this.isDir ? c.accent(name) : c.toolName(name);
    return [truncateToWidth(`${t('pathAction.title')}  ${head}`, width), c.dim(truncateToWidth(this.path, width))];
  }

  protected onChoose(value: PathAction): void {
    this.onAction(value);
  }

  protected onCancel(): void {
    this.cancelAction();
  }

  /** 底部键位提示：动作菜单的语义比审批窄，Esc 即「什么都没做」。 */
  protected hintLine(): string {
    return t('pathAction.hint');
  }
}
