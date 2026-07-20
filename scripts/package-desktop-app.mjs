#!/usr/bin/env node
/**
 * Local macOS .app packager for monorepo desktop.
 * Stages production app + walked node_modules into Electron.app → release/Maka.app
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const OUT_DIR = join(ROOT, 'release');
const APP_NAME = 'Maka';
const PRODUCT_NAME = 'Maka';

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.DS_Store',
  'test',
  'tests',
  '__tests__',
  'example',
  'examples',
  'storybook-static',
  'coverage',
  '.turbo',
  'tsconfig.tsbuildinfo',
]);

const SKIP_FILE_SUFFIXES = [
  '.test.js',
  '.test.d.ts',
  '.test.ts',
  '.spec.js',
  '.map',
  '.tsbuildinfo',
];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function shouldSkipName(name) {
  if (SKIP_DIR_NAMES.has(name)) return true;
  if (name.startsWith('.') && name !== '.package-lock.json') return true;
  return false;
}

function shouldSkipFile(name) {
  return SKIP_FILE_SUFFIXES.some((s) => name.endsWith(s));
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function copyFileFiltered(src, dest) {
  ensureDir(dirname(dest));
  cpSync(src, dest);
}

function copyTreeFiltered(src, dest) {
  if (!existsSync(src)) return;
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    const target = realpathSync(src);
    return copyTreeFiltered(target, dest);
  }
  if (st.isDirectory()) {
    ensureDir(dest);
    for (const name of readdirSync(src)) {
      if (shouldSkipName(name)) continue;
      if (shouldSkipFile(name)) continue;
      copyTreeFiltered(join(src, name), join(dest, name));
    }
    return;
  }
  if (st.isFile()) {
    if (shouldSkipFile(src.split(sep).pop() || '')) return;
    copyFileFiltered(src, dest);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageNameToPath(name) {
  if (name.startsWith('@')) {
    const [scope, pkg] = name.split('/');
    return join(scope, pkg);
  }
  return name;
}

const BUILD_ONLY_DEPS = new Set([
  'electron',
  'vite',
  '@vitejs/plugin-react',
  'esbuild',
  'rollup',
  '@rolldown/pluginutils',
  'postcss',
  'tailwindcss',
  '@tailwindcss/vite',
  'typescript',
  'storybook',
  '@storybook/react-vite',
  '@playwright/test',
  '@babel/parser',
  '@types/react',
  '@types/react-dom',
  '@types/ws',
  '@types/node',
]);

function findPackageDir(name, fromPackageDir) {
  // Node resolves nested dependencies from the requesting package first. Keep
  // the same order so non-hoisted dependencies (and version-isolated trees)
  // are not reported as missing merely because they do not exist at repo root.
  const roots = [];
  for (const start of [fromPackageDir, DESKTOP, ROOT]) {
    let cur = start;
    while (true) {
      const root = join(cur, 'node_modules');
      if (!roots.includes(root)) roots.push(root);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  const rel = packageNameToPath(name);
  for (const root of roots) {
    const candidate = join(root, rel, 'package.json');
    if (existsSync(candidate)) {
      try {
        return realpathSync(dirname(candidate));
      } catch {
        return dirname(candidate);
      }
    }
  }
  // Fallback: ask Node from the requesting package, then walk to package root.
  try {
    const requireFrom = createRequire(join(fromPackageDir, 'package.json'));
    const entry = requireFrom.resolve(name);
    let cur = dirname(entry);
    while (true) {
      const pj = join(cur, 'package.json');
      if (existsSync(pj)) {
        try {
          const pkg = readJson(pj);
          if (!pkg.name || pkg.name === name) return cur;
        } catch {
          return cur;
        }
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    return null;
  }
  return null;
}

function collectDependencies(entryPkgDir) {
  const visited = new Set();
  const queue = [entryPkgDir];
  const packages = new Map(); // name -> real path

  while (queue.length) {
    const pkgDir = queue.pop();
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    let pkg;
    try {
      pkg = readJson(pkgJsonPath);
    } catch {
      continue;
    }
    const name = pkg.name || pkgDir;
    if (visited.has(name)) continue;
    visited.add(name);

    let realPkgDir;
    try {
      realPkgDir = realpathSync(pkgDir);
    } catch {
      realPkgDir = pkgDir;
    }
    packages.set(name, realPkgDir);

    const depNames = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    };
    for (const dep of BUILD_ONLY_DEPS) delete depNames[dep];

    for (const dep of Object.keys(depNames || {})) {
      if (visited.has(dep)) continue;
      if (BUILD_ONLY_DEPS.has(dep)) continue;
      const resolvedDir = findPackageDir(dep, realPkgDir);
      if (!resolvedDir) {
        // optional native extras are fine to skip
        if (dep.startsWith('@esbuild/') || dep.startsWith('@rollup/') || dep.startsWith('lightningcss-') || dep.includes('darwin-x64') || dep.includes('linux-') || dep.includes('win32-') || dep.includes('android-') || dep.includes('freebsd-')) {
          continue;
        }
        log(`  warn: skip unresolved dep ${dep}`);
        continue;
      }
      queue.push(resolvedDir);
    }
  }

  return packages;
}

function writeProductionPackageJson(stageDir) {
  const src = readJson(join(DESKTOP, 'package.json'));
  const prod = {
    name: 'maka',
    productName: PRODUCT_NAME,
    version: src.version || '0.1.0',
    private: true,
    type: 'module',
    main: 'dist/main/main.js',
  };
  writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(prod, null, 2)}\n`);
}

function buildIconIcns(iconPng, icnsPath) {
  if (!existsSync(iconPng)) return false;
  const iconset = mkdtempSync(join(tmpdir(), 'maka-iconset-'));
  const setDir = join(iconset, 'Maka.iconset');
  ensureDir(setDir);
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    const out = join(setDir, `icon_${size}x${size}.png`);
    const ret = spawnSync('sips', ['-z', String(size), String(size), iconPng, '--out', out], { encoding: 'utf8' });
    if (ret.status !== 0) {
      log(`  warn: sips failed for ${size}: ${ret.stderr}`);
    }
    if (size <= 512) {
      const out2 = join(setDir, `icon_${size}x${size}@2x.png`);
      spawnSync('sips', ['-z', String(size * 2), String(size * 2), iconPng, '--out', out2], { encoding: 'utf8' });
    }
  }
  const ret = spawnSync('iconutil', ['-c', 'icns', setDir, '-o', icnsPath], { encoding: 'utf8' });
  rmSync(iconset, { recursive: true, force: true });
  if (ret.status !== 0) {
    log(`  warn: iconutil failed: ${ret.stderr || ret.stdout}`);
    return false;
  }
  return true;
}

function patchInfoPlist(plistPath, { bundleName, displayName, version }) {
  let plist = readFileSync(plistPath, 'utf8');
  const replacements = [
    [/<key>CFBundleDisplayName<\/key>\s*<string>.*?<\/string>/, `<key>CFBundleDisplayName</key>\n  <string>${displayName}</string>`],
    [/<key>CFBundleName<\/key>\s*<string>.*?<\/string>/, `<key>CFBundleName</key>\n  <string>${bundleName}</string>`],
    [/<key>CFBundleIdentifier<\/key>\s*<string>.*?<\/string>/, `<key>CFBundleIdentifier</key>\n  <string>app.maka.desktop</string>`],
    [/<key>CFBundleShortVersionString<\/key>\s*<string>.*?<\/string>/, `<key>CFBundleShortVersionString</key>\n  <string>${version}</string>`],
    [/<key>CFBundleVersion<\/key>\s*<string>.*?<\/string>/, `<key>CFBundleVersion</key>\n  <string>${version}</string>`],
  ];
  for (const [re, rep] of replacements) {
    if (re.test(plist)) plist = plist.replace(re, rep);
  }
  // Prefer custom icon if present
  if (!plist.includes('electron.icns') && !plist.includes('Maka.icns')) {
    // keep default
  } else {
    plist = plist.replace(/<key>CFBundleIconFile<\/key>\s*<string>.*?<\/string>/, `<key>CFBundleIconFile</key>\n  <string>Maka.icns</string>`);
  }
  writeFileSync(plistPath, plist);
}

function main() {
  log('==> package desktop app');

  // Sanity: built artifacts
  const mainJs = join(DESKTOP, 'dist', 'main', 'main.js');
  const renderer = join(DESKTOP, 'dist-renderer', 'index.html');
  if (!existsSync(mainJs) || !existsSync(renderer)) {
    log('Missing build artifacts. Run: npm run build');
    process.exit(1);
  }

  const electronDist = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (!existsSync(electronDist)) {
    log('Electron binary missing. Reinstall electron first.');
    process.exit(1);
  }

  ensureDir(OUT_DIR);
  const stageDir = join(OUT_DIR, 'stage');
  const appPath = join(OUT_DIR, `${APP_NAME}.app`);
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(appPath, { recursive: true, force: true });
  ensureDir(stageDir);

  log('==> stage app files');
  writeProductionPackageJson(stageDir);
  copyTreeFiltered(join(DESKTOP, 'dist'), join(stageDir, 'dist'));
  // strip main tests from staged dist
  rmSync(join(stageDir, 'dist', 'main', '__tests__'), { recursive: true, force: true });
  copyTreeFiltered(join(DESKTOP, 'dist-renderer'), join(stageDir, 'dist-renderer'));
  if (existsSync(join(DESKTOP, 'resources'))) {
    copyTreeFiltered(join(DESKTOP, 'resources'), join(stageDir, 'resources'));
  }
  if (existsSync(join(DESKTOP, 'assets'))) {
    copyTreeFiltered(join(DESKTOP, 'assets'), join(stageDir, 'assets'));
  }
  if (existsSync(join(DESKTOP, 'bundled-tools.json'))) {
    cpSync(join(DESKTOP, 'bundled-tools.json'), join(stageDir, 'bundled-tools.json'));
  }

  log('==> collect production dependencies');
  const packages = collectDependencies(DESKTOP);
  // The root desktop app is staged separately; Electron supplies its own shell.
  packages.delete('@maka/desktop');
  packages.delete('electron');

  log(`  packages: ${packages.size}`);
  const nm = join(stageDir, 'node_modules');
  ensureDir(nm);

  for (const [name, pkgDir] of packages) {
    // Skip workspace packages' source-heavy trees: copy only package.json + dist/exports needed
    const rel = packageNameToPath(name);
    const dest = join(nm, rel);
    const pkg = readJson(join(pkgDir, 'package.json'));
    const isWorkspace = pkgDir.startsWith(join(ROOT, 'packages') + sep) || pkgDir.startsWith(join(ROOT, 'apps') + sep);

    ensureDir(dirname(dest));
    if (isWorkspace) {
      ensureDir(dest);
      writeFileSync(join(dest, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
      // copy dist if present
      if (existsSync(join(pkgDir, 'dist'))) {
        copyTreeFiltered(join(pkgDir, 'dist'), join(dest, 'dist'));
        rmSync(join(dest, 'dist', '__tests__'), { recursive: true, force: true });
      }
      // copy non-src runtime files sometimes required
      for (const extra of ['resources', 'bin', 'wasm', 'vendor']) {
        if (existsSync(join(pkgDir, extra))) {
          copyTreeFiltered(join(pkgDir, extra), join(dest, extra));
        }
      }
      // if package main points outside dist, copy those files
      for (const field of ['main', 'module', 'browser']) {
        const entry = pkg[field];
        if (typeof entry === 'string' && !entry.includes('dist/') && !entry.startsWith('./dist')) {
          const srcFile = join(pkgDir, entry);
          if (existsSync(srcFile)) {
            copyTreeFiltered(dirname(srcFile) === pkgDir ? srcFile : join(pkgDir, entry), join(dest, entry));
          }
        }
      }
      // exports map may reference files
      if (pkg.exports && typeof pkg.exports === 'object') {
        // best-effort: if no dist, copy whole package filtered
        if (!existsSync(join(pkgDir, 'dist'))) {
          copyTreeFiltered(pkgDir, dest);
        }
      }
    } else {
      copyTreeFiltered(pkgDir, dest);
    }
  }

  // node-pty and fs-native-extensions need their prebuilds/binaries; copyTree should have them
  log('==> assemble Electron.app');
  // Preserve relative framework symlinks (Node cpSync rewrites them to absolute paths).
  const cpRet = spawnSync('cp', ['-a', electronDist, appPath], { encoding: 'utf8' });
  if (cpRet.status !== 0) {
    log(`cp failed: ${cpRet.stderr || cpRet.stdout}`);
    process.exit(1);
  }

  const contents = join(appPath, 'Contents');
  const resources = join(contents, 'Resources');
  const appDest = join(resources, 'app');
  rmSync(appDest, { recursive: true, force: true });
  // move stage into Resources/app
  cpSync(stageDir, appDest, { recursive: true });

  // Icon
  const iconPng = join(DESKTOP, 'assets', 'icon.png');
  const icnsPath = join(resources, 'Maka.icns');
  if (buildIconIcns(iconPng, icnsPath)) {
    log('  icon: Maka.icns');
  }

  const version = readJson(join(DESKTOP, 'package.json')).version || '0.1.0';
  patchInfoPlist(join(contents, 'Info.plist'), {
    bundleName: PRODUCT_NAME,
    displayName: PRODUCT_NAME,
    version,
  });

  // Rename executable helper for nicer process name is optional; keep Electron binary name for compatibility
  // Ad-hoc sign for local Gatekeeper friendliness on arm64
  log('==> ad-hoc codesign');
  const sign = spawnSync('codesign', ['--force', '--deep', '-s', '-', appPath], { encoding: 'utf8' });
  if (sign.status !== 0) {
    log(`  warn: codesign: ${sign.stderr || sign.stdout}`);
  }

  // Cleanup stage
  rmSync(stageDir, { recursive: true, force: true });

  log(`==> done: ${appPath}`);
  log(`Open with: open "${appPath}"`);
}

main();
