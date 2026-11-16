import { desktopStage } from '../../../scripts/lib/artifacts.mjs';
import { cp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = desktopStage;
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const names = JSON.parse(await readFile(path.join(root, 'dist/runtime-dependencies.json'), 'utf8'));
if (!Array.isArray(names) || names.some((name) => !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)))
  throw new Error('Invalid build runtime manifest');
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'node_modules'), { recursive: true });
await cp(path.join(root, 'dist'), path.join(stage, 'dist'), {
  recursive: true,
  filter: (file) => !file.endsWith('.map'),
});
await mkdir(path.join(stage, 'resources'), { recursive: true });
for (const name of ['icons', 'ocr', 'entitlements.mac.plist'])
  await cp(path.join(root, 'resources', name), path.join(stage, 'resources', name), {
    recursive: true,
  });

async function resolvePackage(name, from) {
  const require = createRequire(path.join(from, 'package.json'));
  // Native optional packages may export only a binary subpath, with no '.' or package.json export.
  for (const modules of require.resolve.paths(name) ?? []) {
    try {
      const directory = await realpath(path.join(modules, name));
      const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (info.name === name) return { root: directory, info };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  let filename;
  try {
    filename = require.resolve(`${name}/package.json`);
  } catch {
    filename = require.resolve(name);
  }
  let directory = path.dirname(await realpath(filename));
  while (true) {
    try {
      const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (info.name === name) return { root: directory, info };
    } catch {
      /* Keep walking until the owning package manifest is found. */
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot find runtime package ${name}`);
    directory = parent;
  }
}
const supported = (values, target) =>
  !values ||
  (!values.includes(`!${target}`) &&
    (!values.some((value) => !value.startsWith('!')) || values.includes(target)));
const copies = new Map();
const top = new Map();
const dependencies = {};
const expanded = new Set();
async function copyPackage(pkg, destination) {
  if (copies.get(destination) === pkg.root) return;
  if (copies.has(destination)) throw new Error(`Conflicting packaged dependency: ${destination}`);
  copies.set(destination, pkg.root);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(pkg.root, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => {
      const relative = path.relative(pkg.root, file).replaceAll('\\', '/');
      if (pkg.info.name === 'node-pty') {
        const prebuild = /^prebuilds\/([^/]+)/.exec(relative)?.[1];
        if (prebuild && prebuild !== `${process.platform}-${process.arch}`) return false;
      }
      if (/\.(?:pdb|lib)$/.test(relative)) return false;
      if (
        relative
          .split('/')
          .some((part) =>
            [
              'node_modules',
              '.git',
              'test',
              'tests',
              '__tests__',
              'coverage',
              'docs',
              'examples',
              'benchmarks',
            ].includes(part),
          )
      )
        return false;
      if (/\.(?:map|ts|tsx|cpp|cc|h)$/.test(relative)) return false;
      if (/\.md$/i.test(relative) && !/licen[cs]e/i.test(path.basename(relative))) return false;
      return true;
    },
  });
}
// Reserve all direct dependencies before recursively selecting transitive versions.
for (const name of names) {
  const pkg = await resolvePackage(name, root);
  const destination = path.join(stage, 'node_modules', name);
  top.set(name, { ...pkg, destination });
  dependencies[name] = pkg.info.version;
  await copyPackage(pkg, destination);
}
async function expand(pkg, destination, ancestors = new Map()) {
  if (expanded.has(destination)) return;
  expanded.add(destination);
  const branch = new Map(ancestors).set(pkg.root, destination);
  for (const [name] of Object.entries({
    ...pkg.info.peerDependencies,
    ...pkg.info.dependencies,
    ...pkg.info.optionalDependencies,
  })) {
    let dependency;
    try {
      dependency = await resolvePackage(name, pkg.root);
    } catch (error) {
      if (
        name in (pkg.info.optionalDependencies ?? {}) ||
        pkg.info.peerDependenciesMeta?.[name]?.optional
      )
        continue;
      throw error;
    }
    if (
      !supported(dependency.info.os, process.platform) ||
      !supported(dependency.info.cpu, process.arch)
    )
      continue;
    if (top.get(name)?.root === dependency.root) continue;
    // Packages in an ancestor's dependency path already resolve correctly, including cycles.
    if (branch.has(dependency.root)) continue;
    const target = !top.has(name)
      ? path.join(stage, 'node_modules', name)
      : path.join(destination, 'node_modules', name);
    if (!top.has(name)) top.set(name, { ...dependency, destination: target });
    await copyPackage(dependency, target);
    await expand(dependency, target, branch);
  }
}
for (const pkg of top.values()) await expand(pkg, pkg.destination);
for (const [name, pkg] of top) dependencies[name] = pkg.info.version;
await writeFile(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      main: manifest.main,
      type: manifest.type,
      dependencies,
    },
    null,
    2,
  ),
);
const packages = { '': { name: manifest.name, version: manifest.version, dependencies } };
for (const [destination] of copies) {
  const info = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'));
  packages[path.relative(stage, destination).replaceAll('\\', '/')] = {
    name: info.name,
    version: info.version,
    dependencies: info.dependencies,
    optionalDependencies: info.optionalDependencies,
    peerDependencies: info.peerDependencies,
    peerDependenciesMeta: info.peerDependenciesMeta,
    os: info.os,
    cpu: info.cpu,
  };
}
await writeFile(
  path.join(stage, 'package-lock.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    },
    null,
    2,
  ),
);
async function bytes(directory) {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    total += entry.isDirectory() ? await bytes(filename) : (await stat(filename)).size;
  }
  return total;
}
const workerPackages = new Set();
const workerVisited = new Set();
async function workerClosure(name, from) {
  const pkg = await resolvePackage(name, from);
  if (!pkg.root.startsWith(stage + path.sep))
    throw new Error(`Worker dependency escaped the production app: ${name}`);
  if (workerVisited.has(pkg.root)) return;
  workerVisited.add(pkg.root);
  workerPackages.add(name);
  for (const dependency of Object.keys(pkg.info.dependencies ?? {}))
    await workerClosure(dependency, pkg.root);
}
await workerClosure('tesseract.js', stage);
const report = {
  version: 1,
  platform: process.platform,
  arch: process.arch,
  browser: 'electron-isolated-process',
  runtimePackages: Object.keys(dependencies),
  stageBytes: await bytes(stage),
  copies: copies.size,
  workerPackages: [...workerPackages].sort(),
};
await writeFile(path.join(root, 'dist/package-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
