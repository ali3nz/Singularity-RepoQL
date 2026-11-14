// Test transport only; this does not establish compiled product Rust parity.
import { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cache;
let launcher;
after(() => { if (cache) rmSync(cache, { recursive: true, force: true }); });

export function writeNativeCliFixture(path, body) {
  if (process.platform !== 'win32') {
    writeFileSync(path, body, { mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  }
  if (!launcher) {
    cache = mkdtempSync(join(tmpdir(), 'singularity-test-launcher-'));
    const target = join(cache, 'fixture.exe');
    try {
      const compiled = spawnSync('rustc', [
        '--edition=2021', '--crate-name', 'singularity_test_fixture', '-D', 'warnings',
        fileURLToPath(new URL('./test_fixture_launcher.rs', import.meta.url)),
        '-o', target,
      ], { env: { ...process.env, SINGULARITY_TEST_NODE: process.execPath },
        encoding: 'utf8', shell: false, windowsHide: true, timeout: 120_000,
        maxBuffer: 1024 * 1024 });
      if (compiled.error || compiled.status !== 0) {
        throw new Error('NATIVE_FIXTURE_COMPILE_FAILED', { cause: compiled.error ??
          new Error(String(compiled.stderr ?? '').slice(0, 2000)) });
      }
      launcher = target;
    } catch (error) {
      rmSync(cache, { recursive: true, force: true });
      cache = undefined;
      throw error;
    }
  }
  writeFileSync(path + '.cjs', body);
  copyFileSync(launcher, path + '.exe');
  return path + '.exe';
}
