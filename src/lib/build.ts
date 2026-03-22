import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GatewayConfig, getJobsForApp } from './config.ts';
import { renderActiveUpstream, renderGatewaySite } from './nginx.ts';
import { renderGatewayApiEnv, renderGatewayChatAgents, renderGatewayChatPlatformEnv } from './service-profiles.ts';
import { renderControlPlaneService, renderJobService, renderJobTimer } from './systemd.ts';

export async function buildArtifacts(config: GatewayConfig, outDir: string): Promise<void> {
  const nginxDir = join(outDir, 'nginx');
  const upstreamDir = join(nginxDir, 'upstreams');
  const jobsDir = join(outDir, 'systemd', 'jobs');
  const controlPlaneDir = join(outDir, 'systemd', 'control-plane');
  const servicesDir = join(outDir, 'services');
  const gatewayApiDir = join(servicesDir, 'gateway-api');
  const gatewayChatPlatformDir = join(servicesDir, 'gateway-chat-platform');
  await mkdir(upstreamDir, { recursive: true });
  await mkdir(jobsDir, { recursive: true });
  await mkdir(controlPlaneDir, { recursive: true });
  await mkdir(gatewayApiDir, { recursive: true });
  await mkdir(gatewayChatPlatformDir, { recursive: true });

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

  if (config.gateway.adminUi.enabled) {
    await writeFile(
      join(controlPlaneDir, config.gateway.adminUi.serviceName),
      renderControlPlaneService(config.gateway.adminUi),
      'utf8'
    );
  }

  if (config.serviceProfiles.gatewayApi.enabled) {
    await writeFile(join(gatewayApiDir, 'gateway-api.env'), renderGatewayApiEnv(config.serviceProfiles.gatewayApi), 'utf8');
  }

  if (config.serviceProfiles.gatewayChatPlatform.enabled) {
    await writeFile(
      join(gatewayChatPlatformDir, 'chat-api.env'),
      renderGatewayChatPlatformEnv(config.serviceProfiles.gatewayChatPlatform),
      'utf8'
    );
    await writeFile(
      join(gatewayChatPlatformDir, 'agents.json'),
      renderGatewayChatAgents(config.serviceProfiles.gatewayChatPlatform),
      'utf8'
    );
  }
}
