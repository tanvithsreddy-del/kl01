const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtimeDir = process.env.KL01_RUNTIME_DIR
  ? path.resolve(process.env.KL01_RUNTIME_DIR)
  : path.join(root, 'runtime');

module.exports = {
  appId: 'com.kondalabs.kl01',
  productName: 'KL01 Pre Beta',
  asar: true,
  files: ['main.cjs', 'preload.cjs', 'package.json'],
  extraResources: [
    { from: path.join(root, 'server'), to: 'app/server' },
    { from: path.join(root, 'web'), to: 'app/web' },
    {
      from: runtimeDir,
      to: 'app/runtime',
      filter: [
        'llama-server',
        'llama-server.exe',
        'llama-server-impl.dll',
        'llama-common.dll',
        'llama.dll',
        'mtmd.dll',
        'ggml*.dll',
        'libomp*.dll',
        'libllama.dylib',
        'libllama-common.dylib',
        'libllama-server-impl.dylib',
        'libggml*.dylib',
        'libmtmd*.dylib',
        'libomp*.dylib',
        'libllama.so*',
        'libllama-common.so*',
        'libllama-server-impl.so*',
        'libggml*.so*',
        'libmtmd*.so*',
        'libomp*.so*',
      ],
    },
    { from: path.join(root, 'kl01.ico'), to: 'app/kl01.ico' },
    { from: path.join(root, 'kl01.png'), to: 'app/kl01.png' },
    { from: path.join(root, 'package.json'), to: 'app/package.json' },
    { from: path.join(root, 'product.json'), to: 'app/product.json' },
    { from: path.join(root, 'LICENSE'), to: 'app/LICENSE' },
    { from: path.join(root, 'ATTRIBUTION.md'), to: 'app/ATTRIBUTION.md' },
    { from: path.join(root, 'THIRD_PARTY_NOTICES.md'), to: 'app/THIRD_PARTY_NOTICES.md' },
    { from: path.join(root, 'licenses'), to: 'app/licenses' },
  ],
  win: {
    icon: path.join(root, 'kl01.ico'),
    target: ['nsis', 'portable', 'zip'],
    artifactName: 'KL01 Pre Beta Windows.${ext}',
  },
  nsis: {
    artifactName: 'KL01 Pre Beta Setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'KL01 Pre Beta',
    uninstallDisplayName: 'KL01 Pre Beta',
  },
  portable: {
    artifactName: 'KL01 Pre Beta Portable.${ext}',
  },
  mac: {
    icon: path.join(root, 'kl01.png'),
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    artifactName: 'KL01 Pre Beta Mac.${ext}',
  },
  dmg: {
    artifactName: 'KL01 Pre Beta.${ext}',
  },
  linux: {
    icon: path.join(root, 'kl01.png'),
    category: 'Utility',
    syncDesktopName: true,
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'tar.gz', arch: ['x64'] }],
    artifactName: 'KL01 Pre Beta Linux.${ext}',
  },
  appImage: {
    artifactName: 'KL01 Pre Beta.${ext}',
  },
};
