// Scheduled-task entry point for the bundled, loopback-only OpenMausBot.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(process.argv[2] || '');
const receipt = JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8').replace(/^\uFEFF/, ''));
if (receipt.schema !== 'singularity-openmausbot/v1' ||
    receipt.node !== realpathSync(process.execPath) ||
    receipt.root !== root || receipt.port !== 18211 ||
    receipt.cli !== join(receipt.payload, 'cli.js')) {
  throw new Error('OPENMAUSBOT_LAUNCH_RECEIPT_INVALID');
}
const env = { ...process.env, OMB_PORT: '18211', OMB_WEBHOOK_PORT: '18212', NO_COLOR: '1' };
for (const name of ['OMB_LAN', 'OMB_PUBLIC_URL', 'OMB_TUNNEL_SOCKET',
  'OPENMAUSBOT_URL', 'OPENMAUSBOT_TOKEN', 'ELECTRON_RUN_AS_NODE']) delete env[name];
const child = spawn(receipt.node, [receipt.cli, 'serve', '--no-pair', '--local',
  '--data-dir', join(root, 'data'), '--port', '18211', '--label', 'Singularity'],
{ cwd: receipt.payload, env, windowsHide: true, stdio: 'ignore' });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
