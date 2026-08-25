import fs from 'node:fs/promises';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '..');
const source = (await fs.readFile(
  path.join(packageRoot, 'src/services/feishuLoginFlow.ts'),
  'utf8',
)).replaceAll('\r\n', '\n');

function assertIncludes(fragment, message) {
  if (!source.includes(fragment)) throw new Error(message);
}

function assertExcludes(fragment, message) {
  if (source.includes(fragment)) throw new Error(message);
}

assertIncludes(
  "window.open('about:blank', '_blank', 'popup,width=720,height=760')",
  '飞书登录必须由独立弹窗承载。',
);
assertIncludes(
  'popup.location.href = started.redirectUrl',
  '飞书授权地址必须在登录弹窗中打开。',
);
assertIncludes(
  'const polled = await pollFeishuLogin(loginId)',
  '主页面必须轮询服务端登录事务，而不是切走当前路由。',
);
assertIncludes(
  'popup.close();\n        return { ...polled, providerStatus };',
  '登录成功后必须关闭授权弹窗并把用户信息返回主页面。',
);
assertExcludes(
  'window.location.assign(started.redirectUrl)',
  '飞书登录不得用授权地址替换 Li3D 主页面。',
);
assertExcludes(
  'window.location.replace(started.redirectUrl)',
  '飞书登录不得用授权地址替换 Li3D 主页面。',
);

process.stdout.write('Feishu popup login contract passed.\n');
