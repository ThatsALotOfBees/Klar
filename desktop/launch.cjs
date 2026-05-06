// Launches Klar's desktop shell, taking care to clear ELECTRON_RUN_AS_NODE
// from the environment first. That variable, if set, forces the Electron
// binary to behave as plain Node — main-process bootstrap is skipped,
// process.type is undefined, and require('electron') returns a path string
// instead of the API. We've seen at least one Windows shell environment
// where this is set globally, so this wrapper makes the launch robust
// regardless of how the user's shell is configured.

const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron'); // path to electron binary

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const projectRoot = path.resolve(__dirname, '..');
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env,
  cwd: projectRoot,
  windowsHide: false,
});
child.on('exit', (code, signal) => {
  if (code === null) process.exit(1);
  process.exit(code);
});
