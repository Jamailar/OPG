#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const modules = {
  system: {
    label: 'OPG distribution',
    packagePath: 'package.json',
    workspace: null,
    tagPrefix: 'opg-system',
    commitScope: 'release',
    verify: ['npm run web:build', 'npm run gateway:build'],
    release: 'Docker images: opg-system, opg-system-gateway, opg-system-web',
  },
  gateway: {
    label: 'Gateway API',
    packagePath: 'services/gateway/package.json',
    workspace: 'services/gateway',
    tagPrefix: 'opg-gateway',
    commitScope: 'gateway',
    verify: ['npm run gateway:build'],
    release: 'Docker image: opg-system-gateway',
  },
  web: {
    label: 'Platform Web',
    packagePath: 'apps/web/package.json',
    workspace: 'apps/web',
    tagPrefix: 'opg-web',
    commitScope: 'web',
    verify: ['npm run web:build'],
    release: 'Docker image: opg-system-web',
  },
  sdk: {
    label: 'Developer SDK',
    packagePath: 'packages/sdk/package.json',
    workspace: 'packages/sdk',
    tagPrefix: 'opg-sdk',
    commitScope: 'sdk',
    verify: ['npm run sdk:build'],
    release: 'npm package: opg-sdk',
  },
  cli: {
    label: 'CLI and MCP bridge',
    packagePath: 'packages/cli/package.json',
    workspace: 'packages/cli',
    tagPrefix: 'opg-cli',
    commitScope: 'cli',
    verify: ['npm run cli:build'],
    release: 'npm package: @jamba/opg-cli',
  },
};

const allowedBumps = new Set(['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease']);

function usage(exitCode = 0) {
  const moduleList = Object.keys(modules).join('|');
  console.log(`Usage:
  npm run release:bump -- <${moduleList}> <patch|minor|major|x.y.z> [--skip-verify] [--allow-dirty]

Examples:
  npm run release:bump -- system minor
  npm run release:bump -- gateway patch
  npm run release:bump -- cli 0.1.7

After the script succeeds:
  git add <changed package files>
  git commit -m "chore(<scope>): release <version>"
  git tag <tag-prefix>/v<version>
  git push origin main <tag-prefix>/v<version>
`);
  process.exit(exitCode);
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `Command failed: ${printable}`);
  }
  return result.stdout || '';
}

function readPackageVersion(packagePath) {
  const absolutePath = resolve(process.cwd(), packagePath);
  const raw = readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  return String(parsed.version || '');
}

function ensureCleanGitState(allowDirty) {
  if (allowDirty) return;
  const status = run('git', ['status', '--porcelain'], { capture: true }).trim();
  if (!status) return;
  throw new Error(
    [
      'Release bump requires a clean worktree so the version commit stays atomic.',
      'Commit or stash current changes first, or pass --allow-dirty only for local rehearsal.',
      '',
      status,
    ].join('\n'),
  );
}

function isExplicitVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) usage(0);
  const options = {
    skipVerify: argv.includes('--skip-verify'),
    allowDirty: argv.includes('--allow-dirty'),
  };
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const [moduleName, bump] = positional;
  if (!moduleName || !bump) usage(1);
  const module = modules[moduleName];
  if (!module) throw new Error(`Unknown release module: ${moduleName}`);
  if (!allowedBumps.has(bump) && !isExplicitVersion(bump)) {
    throw new Error(`Invalid version bump: ${bump}`);
  }
  return { moduleName, module, bump, options };
}

function bumpVersion(module, bump) {
  const args = ['version', bump, '--no-git-tag-version'];
  if (module.workspace) {
    args.push('--workspace', module.workspace);
  }
  run('npm', args);
}

function runVerification(module, skipVerify) {
  if (skipVerify) return;
  for (const command of module.verify) {
    run('sh', ['-lc', command]);
  }
}

function buildGitAddFiles(module) {
  const candidates = [
    module.packagePath,
    'package-lock.json',
    module.workspace ? `${module.workspace}/package-lock.json` : null,
  ].filter(Boolean);
  return [...new Set(candidates)].filter((file) => existsSync(resolve(process.cwd(), file)));
}

try {
  const { moduleName, module, bump, options } = parseArgs(process.argv.slice(2));
  ensureCleanGitState(options.allowDirty);

  const before = readPackageVersion(module.packagePath);
  console.log(`Preparing ${module.label} release from ${before} with bump "${bump}".`);
  bumpVersion(module, bump);
  const after = readPackageVersion(module.packagePath);
  runVerification(module, options.skipVerify);

  console.log('');
  console.log(`Release bump prepared: ${moduleName} ${before} -> ${after}`);
  console.log(`Release target: ${module.release}`);
  console.log('');
  console.log('Next commands:');
  console.log('  git status --short');
  console.log(`  git add ${buildGitAddFiles(module).join(' ')}`);
  console.log(`  git commit -m "chore(${module.commitScope}): release ${after}"`);
  console.log(`  git tag ${module.tagPrefix}/v${after}`);
  console.log(`  git push origin main ${module.tagPrefix}/v${after}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
