import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceDirectory = path.resolve(process.argv[2] ?? '');
const manifest = path.join(sourceDirectory, 'CSXS', 'manifest.xml');
if (!sourceDirectory || !fs.existsSync(manifest)) {
  throw new Error(`Photoshop CEP plugin source is missing: ${sourceDirectory}`);
}

const roamingAppData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const extensionParent = path.join(roamingAppData, 'Adobe', 'CEP', 'extensions');
const destination = path.join(extensionParent, 'com.liclick.live-texture');
const temporary = `${destination}.installing-${process.pid}`;

fs.mkdirSync(extensionParent, { recursive: true });
fs.rmSync(temporary, { recursive: true, force: true });
fs.cpSync(sourceDirectory, temporary, { recursive: true });
fs.rmSync(destination, { recursive: true, force: true });
fs.renameSync(temporary, destination);

if (process.platform === 'win32' && process.env.LICLICK_SKIP_CEP_REGISTRY !== '1') {
  for (const version of ['10', '11', '12']) {
    const result = spawnSync(
      'reg.exe',
      [
        'add',
        `HKCU\\Software\\Adobe\\CSXS.${version}`,
        '/v',
        'PlayerDebugMode',
        '/t',
        'REG_SZ',
        '/d',
        '1',
        '/f',
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `Unable to enable Adobe CEP ${version} debug mode.`);
    }
  }
}

console.log(`LIclick Photoshop CEP plugin installed: ${destination}`);
