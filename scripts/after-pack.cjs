// Electron-builder afterPack hook. Runs after win-unpacked is populated
// but before the MSI / portable wrap, so any edits we make to Klar.exe
// here end up baked into the installer.
//
// Why we need this: signAndEditExecutable=true is the official knob for
// "let electron-builder rcedit the EXE for you", but on this machine the
// associated winCodeSign download fails (Win10 can't extract the macOS
// symlink files inside the .7z without admin privileges). So we keep
// signAndEditExecutable=false (build succeeds) and run rcedit ourselves
// via the standalone `rcedit` npm package — which ships its own
// rcedit-x64.exe binary and doesn't go anywhere near winCodeSign.
//
// Sets the four VersionInfo fields Task Manager + Properties dialog
// surface to the user: CompanyName, FileDescription, ProductName,
// LegalCopyright. Also writes ProductVersion + FileVersion so the
// Properties tab shows the right number.

const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  // rcedit@5 is ESM-only with a NAMED export `rcedit` (not a default), so
  // we have to dynamic-import + destructure from this .cjs.
  const { rcedit } = await import('rcedit');

  const exeName = (context.packager.appInfo.productFilename || 'Klar') + '.exe';
  const exePath = path.join(context.appOutDir, exeName);
  const version = context.packager.appInfo.version || '0.0.0';

  console.log('[after-pack] rcedit ' + exePath);
  try {
    await rcedit(exePath, {
      'version-string': {
        CompanyName:      'Crystalix LLC',
        FileDescription:  'Klar',
        ProductName:      'Klar',
        OriginalFilename: exeName,
        LegalCopyright:   'Copyright © 2026 Crystalix LLC',
        LegalTrademarks:  'Klar - Crystalix LLC',
      },
      'file-version':    version,
      'product-version': version,
    });
    console.log('[after-pack] rcedit OK');
  } catch (e) {
    console.error('[after-pack] rcedit failed:', e.message);
    throw e;
  }
};
