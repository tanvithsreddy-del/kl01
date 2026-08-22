import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('KL01 identity and root dependency boundary are canonical', async () => {
  const [product, pkg, desktopPkg, builder, health, preferences, diagnostics, settings, index] = await Promise.all([
    fs.readFile(path.join(root, 'product.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'desktop', 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'desktop', 'electron-builder.config.cjs'), 'utf8'),
    fs.readFile(path.join(root, 'server', 'routes', 'health.js'), 'utf8'),
    fs.readFile(path.join(root, 'server', 'services', 'preferences.js'), 'utf8'),
    fs.readFile(path.join(root, 'server', 'services', 'diagnostics.js'), 'utf8'),
    fs.readFile(path.join(root, 'web', 'js', 'screens', 'settings.js'), 'utf8'),
    fs.readFile(path.join(root, 'web', 'index.html'), 'utf8'),
  ]);
  assert.deepEqual(product, { name:'KL01', stage:'Pre Beta', appId:'com.kondalabs.kl01', bugReportEmail:'tanvithsreddy@gmail.com' });
  assert.equal(pkg.name, 'kl01');
  assert.equal(pkg.version, '0.0.0');
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
  assert.equal(desktopPkg.version, '0.0.0');
  assert.match(builder, /productName: 'KL01 Pre Beta'/u);
  for (const artifact of ['KL01 Pre Beta Setup', 'KL01 Pre Beta Portable', 'KL01 Pre Beta Windows', 'KL01 Pre Beta Mac', 'KL01 Pre Beta Linux']) assert.match(builder, new RegExp(artifact, 'u'));
  assert.doesNotMatch(builder, /\$\{version\}/u);
  assert.doesNotMatch(health, /BUILD_VERSION|version:\s*BUILD_VERSION/u);
  assert.doesNotMatch(preferences, /about:\s*\{[^}]*version/u);
  assert.doesNotMatch(diagnostics, /appVersion/u);
  assert.doesNotMatch(settings, /product\.version|report\.appVersion/u);
  assert.match(index, /<title>KL01 Pre Beta<\/title>/u);
});

test('whole-product Pre Beta copy does not imply that only selected features are unfinished', async () => {
  const [badge, welcome, effort] = await Promise.all([
    fs.readFile(path.join(root, 'web', 'js', 'components', 'beta.js'), 'utf8'),
    fs.readFile(path.join(root, 'web', 'js', 'screens', 'welcome.js'), 'utf8'),
    fs.readFile(path.join(root, 'web', 'js', 'components', 'advanced-panel.js'), 'utf8'),
  ]);
  assert.match(badge, /KL01 Pre Beta is entirely unfinished/u);
  assert.match(welcome, /KL01 Pre Beta is entirely unfinished/u);
  assert.match(effort, /Every feature is still being validated/u);
  assert.doesNotMatch(badge, /Core local chat is usable/u);
  assert.doesNotMatch(effort, /Deep is pre-beta/u);
});

test('the expanded model catalogue is immutable and checksum pinned', async () => {
  const catalogue = JSON.parse(await fs.readFile(path.join(root, 'server', 'catalogue.json'), 'utf8'));
  assert.equal(catalogue.entries.length, 23);
  for (const entry of catalogue.entries) {
    assert.match(entry.downloadUrl, /^https:\/\/huggingface\.co\/.+\/resolve\/[a-f0-9]{40}\//u);
    assert.doesNotMatch(entry.downloadUrl, /\/main\//u);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0);
    assert.equal(Object.hasOwn(entry, 'logo'), false);
  }
});

test('catalogue loader quarantines an unpinned or unhashed entry', async () => {
  const source = await fs.readFile(path.join(root, 'server', 'services', 'catalogue.js'), 'utf8');
  assert.match(source, /missing or invalid SHA-256/u);
  assert.match(source, /download URL must use a pinned Hugging Face revision/u);
});

test('AnythingLLM runtime datasets stay absent while restored artwork keeps its licences', async () => {
  const removed = [
    path.join(root, 'server', 'provider-identities.json'),
    path.join(root, 'server', 'services', 'provider-identities.js'),
  ];
  for (const item of removed) await assert.rejects(fs.access(item));
  const [desktopLicence, mobileLicence, marks] = await Promise.all([
    fs.readFile(path.join(root, 'licenses', 'AnythingLLM-MIT.txt'), 'utf8'),
    fs.readFile(path.join(root, 'licenses', 'AnythingLLM-Mobile-MIT.txt'), 'utf8'),
    import('../web/js/components/provider-mark.js'),
  ]);
  assert.match(desktopLicence, /MIT License[\s\S]+Mintplex Labs/u);
  assert.match(mobileLicence, /MIT License[\s\S]+Mintplex Labs/u);
  const [attribution, notices, settings] = await Promise.all([
    fs.readFile(path.join(root, 'ATTRIBUTION.md'), 'utf8'),
    fs.readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    fs.readFile(path.join(root, 'web', 'js', 'screens', 'settings.js'), 'utf8'),
  ]);
  for (const text of [attribution, notices, settings]) {
    assert.match(text, /ANYTHINGLLM: LOGOS ONLY/u);
    assert.match(text, /No AnythingLLM code|NO AnythingLLM code/u);
  }
  const catalogue = JSON.parse(await fs.readFile(path.join(root, 'server', 'catalogue.json'), 'utf8'));
  for (const entry of catalogue.entries) {
    const file = marks.providerLogoFile(entry);
    assert.ok(file, `missing logo mapping for ${entry.providerName}`);
    await fs.access(path.join(root, 'web', 'logos', 'providers', file));
  }
  assert.equal(marks.providerLogoFile({ providerName:'Z.AI' }), 'zai.webp');
  assert.equal(marks.providerLogoFile({ providerName:'Text generation web UI' }), 'text-generation-webui.webp');
});

test('ZIP extraction rejects an oversized archive before reading it', async () => {
  const { readZipEntries, zipLimits } = await import('../server/lib/zip.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kl01-zip-limit-'));
  const archive = path.join(directory, 'oversized.zip');
  try {
    await fs.writeFile(archive, Buffer.alloc(1));
    await fs.truncate(archive, zipLimits.MAX_ARCHIVE_BYTES + 1);
    await assert.rejects(readZipEntries(archive), /archive size is unsafe/u);
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

test('diagnostic safety rejects private payload keys', async () => {
  const { assertDiagnosticSafe } = await import('../server/services/diagnostics.js');
  assert.equal(assertDiagnosticSafe({ product:'KL01', status:'ok' }).status, 'ok');
  assert.throws(() => assertDiagnosticSafe({ prompt:'private' }), /forbidden private field/u);
  assert.throws(() => assertDiagnosticSafe({ nested:{ url:'https://private.example' } }), /forbidden private field/u);
});

test('external services stay generic and discard legacy provider artwork fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kl01-services-'));
  const script = [
    `process.env.KL01_DATA_DIR=${JSON.stringify(directory)};`,
    `const services=await import(${JSON.stringify(new URL('../server/services/services.js', import.meta.url).href)});`,
    `await services.saveService({name:'Example',baseUrl:'https://api.example.com/v1',model:'example',apiKey:'secret',providerId:'legacy',logo:'providers/legacy.webp'});`,
    `await services.migrateServiceIdentities();`,
    `const raw=JSON.parse(await (await import('node:fs/promises')).readFile(${JSON.stringify(path.join(directory, 'services.json'))},'utf8'));`,
    `const pub=await services.listServices();`,
    `if(raw.version!==4||raw.services[0].providerId!=='openai-compatible'||'logo' in raw.services[0]||pub[0].hasKey!==true||'apiKey' in pub[0])process.exit(2);`,
  ].join('');
  const { spawn } = await import('node:child_process');
  try {
    const code = await new Promise((resolve,reject) => {
      const child=spawn(process.execPath,['--input-type=module','--eval',script],{stdio:'ignore'});
      child.once('error',reject);child.once('exit',resolve);
    });
    assert.equal(code, 0);
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

test('Electron boundary is sandboxed and denies in-app external navigation', async () => {
  const source = await fs.readFile(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  assert.match(source, /contextIsolation:\s*true/u);
  assert.match(source, /nodeIntegration:\s*false/u);
  assert.match(source, /sandbox:\s*true/u);
  assert.match(source, /setWindowOpenHandler/u);
  assert.match(source, /action:\s*'deny'/u);
  assert.match(source, /setPermissionRequestHandler/u);
  assert.match(source, /createKL01Server\(\{ port: 0 \}\)/u);
  assert.match(source, /once\('did-finish-load',[\s\S]+webContents\.setZoomFactor\(0\.75\)/u);
  assert.match(source, /\[0\.5, 0\.6, 0\.67, 0\.75, 0\.9, 1, 1\.1, 1\.25, 1\.5\]/u);
  assert.match(source, /minimum:50, maximum:150/u);
  assert.match(source, /before-input-event/u);
  assert.match(source, /numpadadd[\s\S]+numpadsubtract[\s\S]+numpad0/u);
  assert.match(source, /ipcMain\.handle\('kl01:zoom'/u);
  assert.match(source, /webContents\.send\('kl01:zoom-changed'/u);
  const preload = await fs.readFile(path.join(root, 'desktop', 'preload.cjs'), 'utf8');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('kl01Desktop'/u);
  assert.match(preload, /removeListener\('kl01:zoom-changed'/u);
  assert.doesNotMatch(preload, /node:fs|child_process|shell/u);
});

test('settings disclose every curated model licence and display-only provider marks', async () => {
  const [catalogue, settings] = await Promise.all([
    fs.readFile(path.join(root, 'server', 'catalogue.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(root, 'web', 'js', 'screens', 'settings.js'), 'utf8'),
  ]);
  assert.equal(catalogue.entries.every(entry => entry.licence && entry.licenceUrl), true);
  assert.match(settings, /Provider and model-maker marks/u);
  assert.match(settings, /Marks identify compatible services or model provenance only/u);
  assert.match(settings, /OpenAI-compatible/u);
  assert.match(settings, /providerMark/u);
});

test('download paths fail closed on release size and hash mismatches', async () => {
  const [models, engine] = await Promise.all([
    fs.readFile(path.join(root, 'server', 'services', 'download.js'), 'utf8'),
    fs.readFile(path.join(root, 'server', 'services', 'engine.js'), 'utf8'),
  ]);
  assert.match(models, /serverTotalBytes !== entry\.size[\s\S]+DOWNLOAD_INTEGRITY/u);
  assert.match(models, /expectedHash: entry\.sha256/u);
  assert.match(engine, /total !== expectedSize[\s\S]+rm\(part[\s\S]+rm\(metaFile[\s\S]+ENGINE_INTEGRITY/u);
  assert.match(engine, /hash !== String\(expectedHash\)\.toLowerCase\(\)[\s\S]+ENGINE_INTEGRITY/u);
});

test('native packages recognise bundled ELF and Mach-O llama servers without enabling acquisition', async () => {
  const { createEngineService } = await import('../server/services/engine.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kl01-native-runtime-'));
  try {
    const linuxBinary = path.join(directory, 'llama-server');
    await fs.writeFile(linuxBinary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
    await fs.chmod(linuxBinary, 0o755);
    const linux = createEngineService({ platform:'linux', arch:'x64', runtimeDir:directory, binaryName:'llama-server' });
    assert.equal(await linux.present(), true);
    assert.deepEqual(await linux.capability(), { present:true, canAcquire:true, platform:'linux', arch:'x64' });

    const macBinary = path.join(directory, 'llama-server-mac');
    await fs.writeFile(macBinary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    await fs.chmod(macBinary, 0o755);
    const mac = createEngineService({ platform:'darwin', arch:'arm64', runtimeDir:directory, binaryName:'llama-server-mac' });
    assert.equal(await mac.present(), true);
    assert.deepEqual(await mac.capability(), { present:true, canAcquire:true, platform:'darwin', arch:'arm64' });
  } finally { await fs.rm(directory, { recursive:true, force:true }); }
});

test('explicit line counts are repaired without inventing new text', async () => {
  const { enforceExplicitOutputConstraints } = await import('../server/services/output-constraints.js');
  const original='Where silence hums softly, a quiet library stands tall,\nBooks whisper tales and shelves glow with light.\nStories await.';
  const repaired=enforceExplicitOutputConstraints('Write a four-line poem about a quiet library.',original);
  assert.equal(repaired.split(/\r?\n/u).length,4);
  assert.equal(repaired.replace(/\s+/gu,' ').trim(),original.replace(/\s+/gu,' ').trim());
});
