import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GatewayConfig, getJobsForApp } from './config.ts';
import { renderActiveUpstream, renderGatewaySite } from './nginx.ts';
import { renderJobService, renderJobTimer } from './systemd.ts';

export async function buildArtifacts(config: GatewayConfig, outDir: string): Promise<void> {
  const nginxDir = join(outDir, 'nginx');
  const upstreamDir = join(nginxDir, 'upstreams');
  const jobsDir = join(outDir, 'systemd', 'jobs');
  await mkdir(upstreamDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });

  await writeFile(join(nginxDir, 'gateway-site.conf'), renderGatewaySite(config), 'utf8');

  for (const app of config.apps.filter((candidate) => candidate.enabled)) {
    await writeFile(join(upstreamDir, `${app.id}-blue.conf`), renderActiveUpstream(app, 'blue'), 'utf8');
    await writeFile(join(upstreamDir, `${app.id}-green.conf`), renderActiveUpstream(app, 'green'), 'utf8');
  }

  for (const app of config.apps.filter((candidate) => candidate.enabled)) {
    for (const job of getJobsForApp(config, app.id)) {
      await writeFile(join(jobsDir, `${job.id}.service`), renderJobService(config, app, job), 'utf8');
      await writeFile(join(jobsDir, `${job.id}.timer`), renderJobTimer(job), 'utf8');
    }
  }
}

