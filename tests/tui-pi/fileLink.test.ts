/**
 * fileLink 的纯逻辑测试：载荷编解码 round-trip、安全门、链接化条件。
 *
 * 不测 openWithSystem 的 spawn 行为（会在测试机上真的弹窗口/开浏览器），
 * 只测它的输入契约：路径形状 → URL 形状 → decode 回来 → 再建链。
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  FILE_LINK_SCHEME,
  buildFileUrl,
  fileUrlToPath,
  isSafeLinkPath,
  linkFilePathArg,
  linkPath,
} from '../../src/tui-pi/fileLink.js';

describe('isSafeLinkPath', () => {
  it('普通路径安全', () => {
    expect(isSafeLinkPath('src/main.ts')).toBe(true);
    expect(isSafeLinkPath('C:\\Users\\ke\\a b\\c.ts')).toBe(true);
  });

  it('空串与含控制字符的路径不安全', () => {
    expect(isSafeLinkPath('')).toBe(false);
    expect(isSafeLinkPath('a\nb')).toBe(false);
    expect(isSafeLinkPath('a\x1b]8;;x\x07b')).toBe(false);
    expect(isSafeLinkPath('a\x00b')).toBe(false);
  });
});

describe('buildFileUrl / fileUrlToPath round-trip', () => {
  it('POSIX 绝对路径原样通过', () => {
    const url = buildFileUrl('/home/ke/proj/a.ts');
    // 载荷整段 encodeURIComponent（含 / → %2F），decode 侧还原
    expect(url).toBe(`${FILE_LINK_SCHEME}%2Fhome%2Fke%2Fproj%2Fa.ts`);
    expect(fileUrlToPath(url!, '/base')).toBe(resolve('/base', '/home/ke/proj/a.ts'));
  });

  it('Windows 绝对路径（反斜杠原样保留在载荷里）', () => {
    const url = buildFileUrl('C:\\Users\\ke\\a.ts');
    expect(url).toBe(`${FILE_LINK_SCHEME}C%3A%5CUsers%5Cke%5Ca.ts`);
    // 盘符路径是绝对的，resolve 直通不拼 cwd
    expect(fileUrlToPath(url!, 'D:\\other')).toBe('C:\\Users\\ke\\a.ts');
  });

  it('相对路径按 cwd 解析（这是自定义 scheme 相对 file:// 的关键收益）', () => {
    const url = buildFileUrl('src/main.ts');
    if (process.platform === 'win32') {
      // Windows runner：resolve 的 POSIX 式 cwd 会被当成当前盘相对路径
      expect(fileUrlToPath(url!, 'C:\\proj')).toBe('C:\\proj\\src\\main.ts');
    } else {
      expect(fileUrlToPath(url!, '/base')).toBe('/base/src/main.ts');
    }
  });

  it('含空格与特殊字符的绝对路径编码后可还原', () => {
    const p = 'C:\\Program Files\\a&b (1)\\c#d?.ts';
    const url = buildFileUrl(p)!;
    expect(url).not.toBe(p);
    expect(fileUrlToPath(url, 'C:\\x')).toBe('C:\\Program Files\\a&b (1)\\c#d?.ts');
  });

  it('含中文的路径', () => {
    const url = buildFileUrl('C:\\项目\\文件.ts');
    expect(fileUrlToPath(url!, 'C:\\x')).toBe('C:\\项目\\文件.ts');
    expect(fileUrlToPath(buildFileUrl('项目/文件.ts')!, 'C:\\x')).toBe('C:\\x\\项目\\文件.ts');
  });

  it('不安全路径不建链', () => {
    expect(buildFileUrl('a\nb')).toBeUndefined();
    expect(buildFileUrl('')).toBeUndefined();
  });

  it('非本 scheme 的 URL 不解析', () => {
    expect(fileUrlToPath('https://x.com', '/b')).toBeUndefined();
    expect(fileUrlToPath('step://turn/3', '/b')).toBeUndefined();
    expect(fileUrlToPath('file:///etc/passwd', '/b')).toBeUndefined();
  });

  it('畸形百分号编码不炸，返回 undefined', () => {
    expect(fileUrlToPath(`${FILE_LINK_SCHEME}%E0%A4%A`, '/b')).toBeUndefined();
  });
});

describe('linkPath', () => {
  it('安全路径包成 OSC 8 序列', () => {
    const linked = linkPath('src/a.ts', 'src/a.ts');
    expect(linked).toContain(`\x1b]8;;${FILE_LINK_SCHEME}src%2Fa.ts`);
    expect(linked).toContain('\x1b]8;;\x1b\\');
  });

  it('不安全路径原样返回', () => {
    expect(linkPath('a\nb', 'a\nb')).toBe('a\nb');
  });
});

describe('linkFilePathArg', () => {
  it('仅 path/file_path 字段时建链', () => {
    expect(linkFilePathArg({ path: 'src/a.ts' }, 'src/a.ts')).toContain(FILE_LINK_SCHEME);
    expect(linkFilePathArg({ file_path: 'src/b.ts' }, 'src/b.ts')).toContain(FILE_LINK_SCHEME);
  });

  it('高优先级字段存在时不建链（摘要不是路径）', () => {
    expect(linkFilePathArg({ command: 'ls', path: 'src/a.ts' }, 'ls')).toBe('ls');
    expect(linkFilePathArg({ pattern: 'foo', path: 'src/a.ts' }, 'foo')).toBe('foo');
  });

  it('无路径字段或非对象输入时原样返回', () => {
    expect(linkFilePathArg({ query: 'x' }, 'x')).toBe('x');
    expect(linkFilePathArg(null, 'x')).toBe('x');
    expect(linkFilePathArg(undefined, 'x')).toBe('x');
  });
});
