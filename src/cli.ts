import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildArtifacts } from './lib/build.ts';
import {
  deployApp,
  installControlPlaneService,
  installJobs,
  installServiceProfileFiles,
  rollbackApp,
  runServiceProfileAgent,
  smokeTest,
  syncServiceProfileRuntime
} from './lib/deploy.ts';
import { getApp, loadGatewayConfig } from './lib/config.ts';
import { renderActiveUpstream, renderGatewaySite } from './lib/nginx.ts';
import { startAdminServer } from './lib/admin-ui.ts';
import { DEFAULT_WORKFLOW_SEED_PATH, importWorkflowSeed } from './lib/workflows.ts';
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

async function listFiles(root: string, extensions: string[]): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (['.git', 'generated', 'node_modules', 'plans'].includes(entry.name)) {
        continue;
      }
      results.push(...await listFiles(fullPath, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      results.push(fullPath);
    }
  }
  return results;
}

async function lintRepo(): Promise<void> {
  const files = await listFiles(resolve('.'), ['.ts', '.md', '.json', '.yml', '.yaml', '.sh']);
  const problems: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    text.split('\n').forEach((line, index) => {
      if (line.includes('\t')) {
        problems.push(`${file}:${index + 1} contains a tab character`);
      }
      if (/[ \t]+$/.test(line)) {
        problems.push(`${file}:${index + 1} has trailing whitespace`);
      }
    });
  }
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

async function typecheckRepo(): Promise<void> {
  const files = await listFiles(resolve('src'), ['.ts']);
  for (const file of files) {
    await import(file);
  }
}

function requireStringArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function parseOptionalJsonArg(args: Record<string, string | boolean>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(value) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const configPath = typeof args.config === 'string' ? args.config : 'configs/gateway.config.example.json';

  switch (command) {
    case 'validate': {
      await loadGatewayConfig(configPath);
      console.log(`Config OK: ${configPath}`);
      return;
    }
    case 'lint': {
      await lintRepo();
      console.log('Lint OK');
      return;
    }
    case 'typecheck': {
      await typecheckRepo();
      console.log('Typecheck OK');
      return;
    }
    case 'build': {
      const outDir = typeof args.out === 'string' ? args.out : 'generated';
      const config = await loadGatewayConfig(configPath);
      await buildArtifacts(config, outDir);
      console.log(`Rendered artifacts into ${outDir}`);
      return;
    }
    case 'render-nginx-site': {
      const out = requireStringArg(args, 'out');
      const config = await loadGatewayConfig(configPath);
      await mkdir(resolve(dirname(out)), { recursive: true });
      await writeFile(out, renderGatewaySite(config), 'utf8');
      return;
    }
    case 'render-upstream': {
      const appId = requireStringArg(args, 'app');
      const slot = requireStringArg(args, 'slot');
      if (slot !== 'blue' && slot !== 'green') {
        throw new Error(`Invalid slot: ${slot}`);
      }
      const out = requireStringArg(args, 'out');
      const config = await loadGatewayConfig(configPath);
      const app = getApp(config, appId);
      await writeFile(out, renderActiveUpstream(app, slot), 'utf8');
      return;
    }
    case 'deploy-app': {
      const appId = requireStringArg(args, 'app');
      const revision = typeof args.revision === 'string' ? args.revision : undefined;
      const skipFetch = args['skip-fetch'] === true;
      const dryRun = args['dry-run'] === true;
      const config = await loadGatewayConfig(configPath);
      await deployApp(config, appId, revision, skipFetch, { dryRun, log: console.log });
      return;
    }
    case 'rollback-app': {
      const appId = requireStringArg(args, 'app');
      const dryRun = args['dry-run'] === true;
      const config = await loadGatewayConfig(configPath);
      await rollbackApp(config, appId, { dryRun, log: console.log });
      return;
    }
    case 'install-jobs': {
      const appId = requireStringArg(args, 'app');
      const dryRun = args['dry-run'] === true;
      const config = await loadGatewayConfig(configPath);
      await installJobs(config, appId, { dryRun, log: console.log });
      return;
    }
    case 'apply-service-profiles': {
      const appId = requireStringArg(args, 'app');
      const dryRun = args['dry-run'] === true;
      const baseUrl = typeof args['base-url'] === 'string' ? args['base-url'] : undefined;
      const config = await loadGatewayConfig(configPath);
      await installServiceProfileFiles(config, appId, { dryRun, log: console.log });
      await syncServiceProfileRuntime(config, appId, { dryRun, log: console.log }, baseUrl);
      return;
    }
    case 'run-agent': {
      const appId = requireStringArg(args, 'app');
      const agentId = requireStringArg(args, 'agent');
      const prompt = requireStringArg(args, 'prompt');
      const dryRun = args['dry-run'] === true;
      const baseUrl = typeof args['base-url'] === 'string' ? args['base-url'] : undefined;
      const contextJson = parseOptionalJsonArg(args, 'context');
      const deliveryJson = parseOptionalJsonArg(args, 'delivery');
      const config = await loadGatewayConfig(configPath);
      const result = await runServiceProfileAgent(
        config,
        appId,
        agentId,
        {
          prompt,
          context: contextJson as { workflowId?: string; source?: string; metadata?: Record<string, unknown> } | undefined,
          delivery: deliveryJson as { mode?: string; channel?: string; to?: string } | undefined
        },
        { dryRun, log: console.log },
        baseUrl
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'import-workflow-seed': {
      const baseUrl = requireStringArg(args, 'base-url');
      const filePath = typeof args.file === 'string' ? args.file : DEFAULT_WORKFLOW_SEED_PATH;
      const dryRun = args['dry-run'] === true;
      const result = await importWorkflowSeed(baseUrl, filePath, { dryRun, log: console.log });
      console.log(`Imported workflow seed from ${result.filePath}`);
      return;
    }
    case 'install-control-plane-service': {
      const dryRun = args['dry-run'] === true;
      const config = await loadGatewayConfig(configPath);
      await installControlPlaneService(config, { dryRun, log: console.log });
      return;
    }
    case 'smoke-test': {
      const url = requireStringArg(args, 'url');
      await smokeTest(url);
      console.log(`Smoke test OK: ${url}`);
      return;
    }
    case 'serve-ui': {
      const config = await loadGatewayConfig(configPath);
      const host = typeof args.host === 'string' ? args.host : config.gateway.adminUi.host;
      const portValue = typeof args.port === 'string' ? Number(args.port) : config.gateway.adminUi.port;
      if (!Number.isInteger(portValue) || portValue <= 0) {
        throw new Error(`Invalid port: ${String(args.port)}`);
      }
      const outDir = typeof args.out === 'string' ? args.out : config.gateway.adminUi.buildOutDir;
      await startAdminServer({ configPath, host, port: portValue, buildOutDir: outDir });
      return;
    }
    default:
      console.log(`Available commands:
  validate --config <path>
  lint
  typecheck
  build --config <path> --out <dir>
  serve-ui --config <path> [--host <bind>] [--port <port>] [--out <dir>]
  deploy-app --config <path> --app <id> [--revision <sha>] [--skip-fetch] [--dry-run]
  rollback-app --config <path> --app <id> [--dry-run]
  install-jobs --config <path> --app <id> [--dry-run]
  apply-service-profiles --config <path> --app <id> [--base-url <url>] [--dry-run]
  run-agent --config <path> --app <id> --agent <id> --prompt <text> [--context <json>] [--delivery <json>] [--base-url <url>] [--dry-run]
  import-workflow-seed --base-url <url> [--file <path>] [--dry-run]
  install-control-plane-service --config <path> [--dry-run]
  smoke-test --url <url>`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
