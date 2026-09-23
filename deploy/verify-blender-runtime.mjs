// M15 / BLENDER-SERVER-RUNTIME 1.0.0. Runs in the final server image, without a GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function verifyBlenderRuntime({
  executable = process.env.BLENDER_EXECUTABLE_PATH,
  run = spawnSync,
} = {}) {
  assert.ok(executable && path.isAbsolute(executable), 'BLENDER_EXECUTABLE_PATH must be an absolute path');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'li3d-blender-smoke-'));
  try {
    const execute = (args, timeout) => {
      const result = run(executable, args, {
        cwd: directory, encoding: 'utf8', windowsHide: true, timeout,
        killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PYTHONNOUSERSITE: '1', OMP_NUM_THREADS: '2' },
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Blender failed (${result.signal ?? result.status}):\n${result.stderr}\n${result.stdout}`);
      return `${result.stdout}\n${result.stderr}`;
    };
    const version = execute(['--version'], 15_000);
    assert.match(version, /^Blender 5\.1\.2(?:\s|$)/m, 'Expected the pinned Blender 5.1.2 runtime');
    const { importUvRepairScript } = await import('../apps/server/dist/services/importUvRepairScript.js');
    const script = path.join(directory, 'repair.py');
    writeFileSync(script, importUvRepairScript);
    const output = execute([
      '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
      '--python', path.join(root, 'apps/server/scripts/test-import-uv-merge-distance.py'),
      '--', script, directory,
    ], 180_000);
    assert.match(output, /^MERGE_DISTANCE_TEST_OK /m, 'Blender must finish the real UV and destructive-merge rejection tests');
    const glb = readFileSync(path.join(directory, 'near-vertices-repaired.glb'));
    assert.equal(glb.subarray(0, 4).toString(), 'glTF');
    assert.equal(glb.readUInt32LE(4), 2);
    assert.equal(glb.readUInt32LE(8), glb.length);
    return 'BLENDER_RUNTIME_OK Blender 5.1.2: UV repair, materials, GLB roundtrip and destructive-merge rejection';
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(await verifyBlenderRuntime());
  } catch (error) {
    console.error('BLENDER_RUNTIME_FAILED:', error.message);
    process.exitCode = 1;
  }
}
