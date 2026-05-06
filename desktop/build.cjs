// Run electron-builder with ELECTRON_RUN_AS_NODE cleared from the env, for
// the same reason desktop/launch.cjs does: when that var is set, the
// Electron binary used by electron-builder for its own internal probing
// behaves as plain Node and the build fails.

const { spawn } = require('node:child_process');
const path = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const projectRoot = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const builderBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  isWin ? 'electron-builder.cmd' : 'electron-builder',
);

const args = process.argv.slice(2);
// Default to "build for Windows with whatever targets are configured in
// package.json's build.win.target". Specifying explicit targets here would
// OVERRIDE that config, so we just pass `--win` with no target list.
if (args.length === 0) args.push('--win');

const child = spawn(builderBin, args, {
  stdio: 'inherit',
  env,
  cwd: projectRoot,
  shell: isWin, // .cmd files need cmd.exe to invoke
});
child.on('exit', (code, signal) => process.exit(code === null ? 1 : code));
