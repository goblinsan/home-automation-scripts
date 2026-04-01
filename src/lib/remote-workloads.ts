import { join } from 'node:path';
import type {
  GatewayConfig,
  JsonFileConfig,
  MinecraftBedrockPackConfig,
  MinecraftBedrockWorkloadConfig,
  RemoteWorkloadConfig,
  ScheduledContainerJobWorkloadConfig,
  WorkerNodeConfig
} from './config.ts';
import { renderEnvFile } from './service-profiles.ts';

export interface RenderedRemoteFile {
  relativePath: string;
  contents: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function sanitizeProjectName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replaceAll(/^-+|-+$/g, '') || 'workload';
}

export function getRemoteWorkloadStackDir(node: WorkerNodeConfig, workload: RemoteWorkloadConfig): string {
  return `${node.stackRoot}/${workload.id}`;
}

export function getRemoteWorkloadSourceDir(node: WorkerNodeConfig, workload: RemoteWorkloadConfig): string {
  return `${node.buildRoot}/${workload.id}/source`;
}

export function getRemoteWorkloadDataDir(node: WorkerNodeConfig, workload: RemoteWorkloadConfig): string {
  return `${node.volumeRoot}/${workload.id}`;
}

export function getRemoteWorkloadProjectName(workload: RemoteWorkloadConfig): string {
  return `gateway-${sanitizeProjectName(workload.id)}`;
}

function renderJsonRuntimeFile(file: JsonFileConfig): string {
  return `${JSON.stringify(file.payload, null, 2)}\n`;
}

function renderGeneratedNodeDockerfile(job: ScheduledContainerJobWorkloadConfig): string {
  const packageRoot = job.build.packageRoot || '.';
  const installCommand = job.build.installCommand || 'npm ci --omit=dev';
  const nodeVersion = job.build.nodeVersion || '24';
  return `FROM node:${nodeVersion}-bookworm-slim
WORKDIR /app
COPY source/${packageRoot}/package*.json ./
RUN ${installCommand}
COPY source/${packageRoot}/ ./
CMD ["/bin/sh", "-lc", ${JSON.stringify(job.runCommand)}]
`;
}

function renderScheduledContainerCompose(node: WorkerNodeConfig, workload: RemoteWorkloadConfig, job: ScheduledContainerJobWorkloadConfig): string {
  const stackDir = getRemoteWorkloadStackDir(node, workload);
  const sourceDir = getRemoteWorkloadSourceDir(node, workload);
  const projectName = getRemoteWorkloadProjectName(workload);
  const runtimeMount = `${stackDir}/runtime:/runtime:ro`;
  const buildContext = job.build.strategy === 'generated-node'
    ? `${node.buildRoot}/${workload.id}`
    : `${sourceDir}/${job.build.contextPath}`;
  const dockerfilePath = job.build.strategy === 'generated-node'
    ? `${node.buildRoot}/${workload.id}/Dockerfile`
    : `${sourceDir}/${job.build.dockerfilePath || 'Dockerfile'}`;

  const mounts = [runtimeMount].concat(
    job.volumeMounts.map((mount) => `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`)
  );

  return [
    'services:',
    '  runner:',
    '    build:',
    `      context: ${yamlString(buildContext)}`,
    `      dockerfile: ${yamlString(dockerfilePath)}`,
    '    env_file:',
    `      - ${yamlString(`${stackDir}/job.env`)}`,
    '    command:',
    `      - ${yamlString('/bin/sh')}`,
    `      - ${yamlString('-lc')}`,
    `      - ${yamlString(job.runCommand)}`,
    '    volumes:',
    ...mounts.map((mount) => `      - ${yamlString(mount)}`),
    `    container_name: ${yamlString(`${projectName}-runner`)}`,
    `    restart: ${yamlString('no')}`,
    ''
  ].join('\n');
}

function renderBedrockPackManifest(packs: MinecraftBedrockPackConfig[]): string {
  return `${JSON.stringify(
    packs.map((pack) => ({
      pack_id: pack.manifestUuid,
      version: pack.manifestVersion
    })),
    null,
    2
  )}\n`;
}

function renderBedrockBootstrapScript(node: WorkerNodeConfig, workload: RemoteWorkloadConfig, minecraft: MinecraftBedrockWorkloadConfig): string {
  const dataDir = `${getRemoteWorkloadDataDir(node, workload)}/data`;
  const worldName = minecraft.worldName;
  const worldDir = `${dataDir}/worlds/${worldName}`;
  const worldSourcePath = minecraft.worldSourcePath || '';
  const worldCopyMode = minecraft.worldCopyMode;

  const worldCopyBlock = !worldSourcePath
    ? 'echo "No world source path configured; skipping world import"\n'
    : `if [ ${yamlString(worldCopyMode)} = "always" ] || [ ! -d ${yamlString(worldDir)} ]; then
  rm -rf ${yamlString(worldDir)}
  mkdir -p ${yamlString(worldDir)}
  if [ -d ${yamlString(worldSourcePath)} ]; then
    cp -R ${yamlString(`${worldSourcePath}/.`)} ${yamlString(`${worldDir}/`)}
  else
    TMP_WORLD_DIR="${yamlString(`${dataDir}/.world-import-tmp`)}"
    rm -rf "$TMP_WORLD_DIR"
    mkdir -p "$TMP_WORLD_DIR"
    unzip -oq ${yamlString(worldSourcePath)} -d "$TMP_WORLD_DIR"
    set -- "$TMP_WORLD_DIR"/*
    if [ "$#" -eq 1 ] && [ -d "$1" ]; then
      cp -R "$1"/. ${yamlString(`${worldDir}/`)}
    else
      cp -R "$TMP_WORLD_DIR"/. ${yamlString(`${worldDir}/`)}
    fi
    rm -rf "$TMP_WORLD_DIR"
  fi
else
  echo "World already present; skipping import"
fi
`;

  const packCopyLines = [
    ...minecraft.behaviorPacks.map((pack) =>
      `copy_pack ${yamlString(pack.sourcePath)} ${yamlString(`${dataDir}/behavior_packs/${pack.id}`)}`
    ),
    ...minecraft.resourcePacks.map((pack) =>
      `copy_pack ${yamlString(pack.sourcePath)} ${yamlString(`${dataDir}/resource_packs/${pack.id}`)}`
    )
  ].join('\n');

  const manifestLines = [
    minecraft.behaviorPacks.length > 0
      ? `cp ${yamlString(`${getRemoteWorkloadStackDir(node, workload)}/runtime/world_behavior_packs.json`)} ${yamlString(`${worldDir}/world_behavior_packs.json`)}`
      : `rm -f ${yamlString(`${worldDir}/world_behavior_packs.json`)}`,
    minecraft.resourcePacks.length > 0
      ? `cp ${yamlString(`${getRemoteWorkloadStackDir(node, workload)}/runtime/world_resource_packs.json`)} ${yamlString(`${worldDir}/world_resource_packs.json`)}`
      : `rm -f ${yamlString(`${worldDir}/world_resource_packs.json`)}`
  ].join('\n');

  return `#!/bin/sh
set -eu

copy_pack() {
  src="$1"
  dst="$2"
  rm -rf "$dst"
  mkdir -p "$dst"
  if [ -d "$src" ]; then
    cp -R "$src"/. "$dst"/
    return
  fi

  tmp_dir="\${dst}.tmp"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"
  unzip -oq "$src" -d "$tmp_dir"
  set -- "$tmp_dir"/*
  if [ "$#" -eq 1 ] && [ -d "$1" ]; then
    cp -R "$1"/. "$dst"/
  else
    cp -R "$tmp_dir"/. "$dst"/
  fi
  rm -rf "$tmp_dir"
}

mkdir -p ${yamlString(`${dataDir}/worlds`)} ${yamlString(`${dataDir}/behavior_packs`)} ${yamlString(`${dataDir}/resource_packs`)}

${worldCopyBlock}

${packCopyLines || 'true'}
${manifestLines}
chmod -R a+rwX ${yamlString(dataDir)}
`;
}

function renderMinecraftCompose(node: WorkerNodeConfig, workload: RemoteWorkloadConfig, minecraft: MinecraftBedrockWorkloadConfig): string {
  const dataDir = getRemoteWorkloadDataDir(node, workload);
  const volumeLines = [`      - ${yamlString(`${dataDir}/data:/data`)}`];
  const networkLines = minecraft.networkMode === 'host'
    ? ['    network_mode: "host"']
    : ['    ports:', `      - ${yamlString(`${minecraft.serverPort}:${minecraft.serverPort}/udp`)}`];
  const environmentLines = [
    `      EULA: ${yamlString('TRUE')}`,
    `      SERVER_NAME: ${yamlString(minecraft.serverName)}`,
    `      LEVEL_NAME: ${yamlString(minecraft.worldName)}`,
    `      GAMEMODE: ${yamlString(minecraft.gameMode)}`,
    `      DIFFICULTY: ${yamlString(minecraft.difficulty)}`,
    `      ALLOW_CHEATS: ${yamlString(minecraft.allowCheats ? 'true' : 'false')}`,
    `      ONLINE_MODE: ${yamlString(minecraft.onlineMode ? 'true' : 'false')}`,
    `      MAX_PLAYERS: ${yamlString(String(minecraft.maxPlayers))}`,
    `      SERVER_PORT: ${yamlString(String(minecraft.serverPort))}`,
    `      ENABLE_LAN_VISIBILITY: ${yamlString('true')}`,
    `      TEXTUREPACK_REQUIRED: ${yamlString(minecraft.texturepackRequired ? 'true' : 'false')}`
  ];

  if (minecraft.levelSeed) {
    environmentLines.push(`      LEVEL_SEED: ${yamlString(minecraft.levelSeed)}`);
  }

  return [
    'services:',
    '  server:',
    `    image: ${yamlString(minecraft.image)}`,
    '    stdin_open: true',
    '    tty: true',
    ...networkLines,
    '    environment:',
    ...environmentLines,
    '    volumes:',
    ...volumeLines,
    `    container_name: ${yamlString(`${getRemoteWorkloadProjectName(workload)}-server`)}`,
    '    restart: unless-stopped',
    ''
  ].join('\n');
}

function renderMinecraftUpdateScript(node: WorkerNodeConfig, workload: RemoteWorkloadConfig): string {
  const stackDir = getRemoteWorkloadStackDir(node, workload);
  const composeCommand = `${node.dockerComposeCommand} -f ${stackDir}/compose.yml --project-name ${getRemoteWorkloadProjectName(workload)}`;
  const containerName = `${getRemoteWorkloadProjectName(workload)}-server`;
  return `#!/bin/sh
set -eu

MODE="\${GCP_BEDROCK_UPDATE_MODE:-safe}"
SINCE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
BEFORE_IMAGE_ID="$(/bin/sh -lc ${JSON.stringify(`${node.dockerCommand} inspect -f '{{.Image}}' ${containerName} 2>/dev/null || true`)})"
BEFORE_VERSION="$(/bin/sh -lc ${JSON.stringify(`${composeCommand} logs server 2>/dev/null | sed -n 's/.*Version: \\{0,1\\}\\([0-9][0-9.]*\\).*/\\1/p' | tail -n 1`)})"

if [ "$MODE" != "force" ]; then
  /bin/sh -lc ${JSON.stringify(`${composeCommand} exec -T server send-command list >/dev/null 2>&1 || true`)}
  sleep 2
  LOGS="$(/bin/sh -lc ${JSON.stringify(`${composeCommand} logs --since "$SINCE" server 2>/dev/null || true`)})"
  ONLINE="$(printf '%s\n' "$LOGS" | sed -n 's/.*There are \\([0-9][0-9]*\\)\\/[0-9][0-9]* players online.*/\\1/p' | tail -n 1)"

  if [ -z "$ONLINE" ]; then
    echo "__GCP_UPDATE_STATUS__ skipped-player-count-unknown"
    echo "__GCP_UPDATE_DETAIL__ Could not determine player count from Bedrock logs"
    echo "Could not determine player count; skipping update"
    exit 0
  fi

  if [ "$ONLINE" != "0" ]; then
    echo "__GCP_UPDATE_STATUS__ skipped-players-online"
    echo "__GCP_UPDATE_DETAIL__ Players online: $ONLINE"
    echo "Players online: $ONLINE; skipping update"
    exit 0
  fi
else
  echo "__GCP_UPDATE_DETAIL__ Force mode bypassed player-count safety checks"
fi

/bin/sh -lc ${JSON.stringify(`${composeCommand} pull server`)}
/bin/sh -lc ${JSON.stringify(`${stackDir}/scripts/bootstrap-world.sh`)}
/bin/sh -lc ${JSON.stringify(`${composeCommand} up -d server`)}
AFTER_IMAGE_ID="$(/bin/sh -lc ${JSON.stringify(`${node.dockerCommand} inspect -f '{{.Image}}' ${containerName} 2>/dev/null || true`)})"
AFTER_LOGS=""
AFTER_VERSION=""
DOWNLOADED_VERSION=""

for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  AFTER_LOGS="$(/bin/sh -lc ${JSON.stringify(`${composeCommand} logs --since "$SINCE" server 2>/dev/null || true`)})"
  AFTER_VERSION="$(printf '%s\n' "$AFTER_LOGS" | sed -n 's/.*Version: \\{0,1\\}\\([0-9][0-9.]*\\).*/\\1/p' | tail -n 1)"
  DOWNLOADED_VERSION="$(printf '%s\n' "$AFTER_LOGS" | sed -n 's/.*Downloading Bedrock server version \\([0-9][0-9.]*\\).*/\\1/p' | tail -n 1)"
  if [ -n "$AFTER_VERSION" ] || [ -n "$DOWNLOADED_VERSION" ]; then
    break
  fi
  sleep 2
done

if [ -n "$AFTER_VERSION" ]; then
  if [ -n "$BEFORE_VERSION" ] && [ "$BEFORE_VERSION" != "$AFTER_VERSION" ]; then
    if [ "$MODE" = "force" ]; then
      echo "__GCP_UPDATE_STATUS__ force-updated"
      echo "__GCP_UPDATE_DETAIL__ Force mode changed server version from $BEFORE_VERSION to $AFTER_VERSION"
    else
      echo "__GCP_UPDATE_STATUS__ updated-version"
      echo "__GCP_UPDATE_DETAIL__ Server version changed from $BEFORE_VERSION to $AFTER_VERSION"
    fi
    exit 0
  fi

  if [ -z "$BEFORE_VERSION" ]; then
    if [ "$MODE" = "force" ]; then
      echo "__GCP_UPDATE_STATUS__ force-updated"
      echo "__GCP_UPDATE_DETAIL__ Force mode restarted the server on version $AFTER_VERSION"
    else
      echo "__GCP_UPDATE_STATUS__ updated-version"
      echo "__GCP_UPDATE_DETAIL__ Server restarted on version $AFTER_VERSION"
    fi
    exit 0
  fi

  echo "__GCP_UPDATE_STATUS__ no-version-change"
  if [ "$MODE" = "force" ]; then
    echo "__GCP_UPDATE_DETAIL__ Force mode restarted the server, but version remained $AFTER_VERSION"
  else
    echo "__GCP_UPDATE_DETAIL__ Server restarted, but version remained $AFTER_VERSION"
  fi
  exit 0
fi

if [ -n "$DOWNLOADED_VERSION" ]; then
  if [ "$MODE" = "force" ]; then
    echo "__GCP_UPDATE_STATUS__ force-updated"
    echo "__GCP_UPDATE_DETAIL__ Force mode downloaded Bedrock server version $DOWNLOADED_VERSION"
  else
    echo "__GCP_UPDATE_STATUS__ updated-version"
    echo "__GCP_UPDATE_DETAIL__ Downloaded Bedrock server version $DOWNLOADED_VERSION"
  fi
  exit 0
fi

if [ -n "$BEFORE_IMAGE_ID" ] && [ -n "$AFTER_IMAGE_ID" ] && [ "$BEFORE_IMAGE_ID" = "$AFTER_IMAGE_ID" ]; then
  echo "__GCP_UPDATE_STATUS__ no-image-change"
  if [ "$MODE" = "force" ]; then
    echo "__GCP_UPDATE_DETAIL__ Force mode restarted the container, but no new Bedrock version or image change was detected"
  else
    echo "__GCP_UPDATE_DETAIL__ No new Bedrock version or image change was detected"
  fi
else
  if [ "$MODE" = "force" ]; then
    echo "__GCP_UPDATE_STATUS__ force-updated"
    echo "__GCP_UPDATE_DETAIL__ Force mode bypassed safety checks and recreated the container"
  else
    echo "__GCP_UPDATE_STATUS__ updated"
    echo "__GCP_UPDATE_DETAIL__ Server container was recreated"
  fi
fi
`;
}

export function renderRemoteWorkloadFiles(
  _config: GatewayConfig,
  node: WorkerNodeConfig,
  workload: RemoteWorkloadConfig
): RenderedRemoteFile[] {
  const files: RenderedRemoteFile[] = [];

  if (workload.kind === 'scheduled-container-job' && workload.job) {
    const stackDir = getRemoteWorkloadStackDir(node, workload);
    files.push({
      relativePath: 'compose.yml',
      contents: renderScheduledContainerCompose(node, workload, workload.job)
    });
    files.push({
      relativePath: 'job.env',
      contents: renderEnvFile(workload.job.environment)
    });

    if (workload.job.build.strategy === 'generated-node') {
      files.push({
        relativePath: 'Dockerfile',
        contents: renderGeneratedNodeDockerfile(workload.job)
      });
    }

    for (const file of workload.job.jsonFiles) {
      files.push({
        relativePath: join('runtime', file.relativePath),
        contents: renderJsonRuntimeFile(file)
      });
    }
  }

  if (workload.kind === 'minecraft-bedrock-server' && workload.minecraft) {
    const stackDir = getRemoteWorkloadStackDir(node, workload);
    files.push({
      relativePath: 'compose.yml',
      contents: renderMinecraftCompose(node, workload, workload.minecraft)
    });
    files.push({
      relativePath: 'scripts/bootstrap-world.sh',
      contents: renderBedrockBootstrapScript(node, workload, workload.minecraft)
    });
    files.push({
      relativePath: 'runtime/world_behavior_packs.json',
      contents: renderBedrockPackManifest(workload.minecraft.behaviorPacks)
    });
    files.push({
      relativePath: 'runtime/world_resource_packs.json',
      contents: renderBedrockPackManifest(workload.minecraft.resourcePacks)
    });

    if (workload.minecraft.autoUpdateEnabled) {
      files.push({
        relativePath: 'scripts/update-if-empty.sh',
        contents: renderMinecraftUpdateScript(node, workload)
      });
    }

    files.push({
      relativePath: 'README.txt',
      contents: `Stack dir: ${stackDir}\nData dir: ${getRemoteWorkloadDataDir(node, workload)}/data\n`
    });
  }

  return files;
}
