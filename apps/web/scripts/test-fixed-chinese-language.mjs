import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [store, userMenu, entry, html] = await Promise.all([
  readFile(path.join(root, 'src/stores/i18nStore.ts'), 'utf8'),
  readFile(path.join(root, 'src/components/auth/UserMenu.tsx'), 'utf8'),
  readFile(path.join(root, 'src/main.tsx'), 'utf8'),
  readFile(path.join(root, 'index.html'), 'utf8'),
]);

assert.match(store, /create<I18nStore>\(\(\) => \(\{ language: 'zh' \}\)\)/);
assert.doesNotMatch(store, /persist\(|createJSONStorage|localStorage|navigator\.languages?/);
assert.doesNotMatch(userMenu, /setLanguage|switchToEnglish|<Languages/);
assert.match(entry, /document\.documentElement\.lang = 'zh-CN'/);
assert.match(entry, /document\.documentElement\.translate = false/);
assert.match(html, /<html lang="zh-CN" translate="no">/);
assert.match(html, /<meta name="google" content="notranslate" \/>/);

stdout.write('Fixed Simplified Chinese UI language regression test passed.\n');
