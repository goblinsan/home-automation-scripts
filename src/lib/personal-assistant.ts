import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  GatewayChatAgentConfig,
  GatewayConfig,
  PersonalAssistantConfig,
  PersonalAssistantEventConfig,
  PersonalAssistantGoalConfig,
  PersonalAssistantObligationConfig,
  PersonalAssistantProjectConfig,
} from './config.ts';
import type { ProjectTrackingProjectUpsert } from './metrics.ts';
import type { WorkflowSeedRecord } from './workflows.ts';

function formatList(items: string[], empty = '- none yet'): string {
  if (items.length === 0) {
    return empty;
  }
  return items.map((item) => `- ${item}`).join('\n');
}

function formatOptionalLine(label: string, value?: string): string {
  return value && value.trim() ? `  ${label}: ${value.trim()}` : '';
}

function indentBlock(text: string, prefix = '  > '): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function summarizeProject(
  project: PersonalAssistantProjectConfig,
  planContent?: string,
): string {
  const lines = [
    `- ${project.name} [${project.status}, ${project.priority}]`,
    `  Summary: ${project.summary}`,
    `  Next: ${project.nextAction}`,
    formatOptionalLine('Repo', project.repoSlug),
    formatOptionalLine('Project plan', project.planFilePath),
    formatOptionalLine('Deadline', project.deadline),
    formatOptionalLine('Reminder', project.reminder),
    formatOptionalLine('Notes', project.notes),
  ].filter(Boolean);
  if (planContent && planContent.trim()) {
    lines.push('  Project plan content:');
    lines.push(indentBlock(planContent.trim()));
  } else if (project.planFilePath && project.planFilePath.trim()) {
    lines.push(`  Project plan content: (could not read ${project.planFilePath.trim()})`);
  }
  return lines.join('\n');
}

const MAX_PROJECT_PLAN_BYTES = 64 * 1024;

async function loadProjectPlanContents(
  projects: PersonalAssistantProjectConfig[],
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  await Promise.all(
    projects.map(async (project) => {
      const path = project.planFilePath?.trim();
      if (!path) {
        return;
      }
      try {
        const absolutePath = resolve(path);
        const content = await readFile(absolutePath, 'utf8');
        const truncated = content.length > MAX_PROJECT_PLAN_BYTES
          ? `${content.slice(0, MAX_PROJECT_PLAN_BYTES)}\n…(truncated)…`
          : content;
        results.set(project.id, truncated);
      } catch {
        // Leave entry unset; summarizeProject will note that the file could not be read.
      }
    }),
  );
  return results;
}

function summarizeObligation(obligation: PersonalAssistantObligationConfig): string {
  const lines = [
    `- ${obligation.title} [${obligation.category}, ${obligation.status}, ${obligation.priority}]`,
    formatOptionalLine('Deadline', obligation.deadline),
    formatOptionalLine('Schedule', obligation.schedule),
    formatOptionalLine('Notes', obligation.notes),
  ].filter(Boolean);
  return lines.join('\n');
}

function summarizeGoal(goal: PersonalAssistantGoalConfig): string {
  const lines = [
    `- ${goal.title} [${goal.status}, ${goal.priority}]`,
    `  Target: ${goal.target}`,
    formatOptionalLine('Cadence', goal.cadence),
    formatOptionalLine('Notes', goal.notes),
  ].filter(Boolean);
  return lines.join('\n');
}

function summarizeEvent(event: PersonalAssistantEventConfig): string {
  const lines = [
    `- ${event.title} [${event.priority}]`,
    `  Starts: ${event.startDate}`,
    formatOptionalLine('Ends', event.endDate),
    formatOptionalLine('Location', event.location),
    formatOptionalLine('Notes', event.notes),
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildPersonalAssistantPlanMarkdown(
  profile: PersonalAssistantConfig,
  projectPlanContents?: Map<string, string>,
): string {
  const generatedAt = new Date().toISOString();
  return [
    `# ${profile.assistantName} Operating Plan`,
    '',
    `Generated: ${generatedAt}`,
    `Owner: ${profile.ownerName}`,
    `Time zone: ${profile.timezone}`,
    '',
    '## Coaching Intent',
    profile.focusStrategy,
    '',
    '## Coach Personality',
    profile.personality,
    '',
    '## Weekly Outcome',
    profile.weeklyOutcome,
    '',
    '## Priority Stack',
    formatList(profile.priorities),
    '',
    '## Weekly Themes',
    formatList(profile.weeklyThemes),
    '',
    '## Active Projects',
    profile.projects.length > 0
      ? profile.projects
          .map((project) => summarizeProject(project, projectPlanContents?.get(project.id)))
          .join('\n\n')
      : '- none yet',
    '',
    '## Obligations And Responsibilities',
    profile.obligations.length > 0 ? profile.obligations.map(summarizeObligation).join('\n\n') : '- none yet',
    '',
    '## Workout Goals',
    profile.fitnessGoals.length > 0 ? profile.fitnessGoals.map(summarizeGoal).join('\n\n') : '- none yet',
    '',
    '## Nutrition Goals',
    profile.nutritionGoals.length > 0 ? profile.nutritionGoals.map(summarizeGoal).join('\n\n') : '- none yet',
    '',
    '## Trips, Events, And Important Dates',
    profile.events.length > 0 ? profile.events.map(summarizeEvent).join('\n\n') : '- none yet',
    '',
    '## Assistant Rules',
    '- Keep daily plans tight and realistic.',
    '- Surface deadline pressure early.',
    '- Balance project momentum with obligations and recovery.',
    '- Name the next concrete action instead of broad advice.',
    '- Bias toward consistency over heroics.',
    '',
  ].join('\n');
}

export async function writePersonalAssistantPlanFile(profile: PersonalAssistantConfig): Promise<{ path: string; bytes: number }> {
  const absolutePath = resolve(profile.planFilePath);
  const projectPlanContents = await loadProjectPlanContents(profile.projects);
  const content = buildPersonalAssistantPlanMarkdown(profile, projectPlanContents);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${content.trim()}\n`, 'utf8');
  return {
    path: absolutePath,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function buildLocalAssistantPrompt(profile: PersonalAssistantConfig): string {
  return [
    `You are ${profile.assistantName}, the user's direct personal assistant and execution coach.`,
    `You help ${profile.ownerName} keep projects, obligations, health goals, and upcoming events aligned.`,
    'Operate as a practical daily coach: concise, honest, and specific.',
    `Coach personality: ${profile.personality}`,
    `Primary coaching intent: ${profile.focusStrategy}`,
    `Weekly success definition: ${profile.weeklyOutcome}`,
    'When multiple items compete, favor the highest-priority work with the nearest real-world consequence.',
    'Use the notes repo and generated operating plan as the source of truth when available.',
    'For dependency analysis, major replanning, or architecture tradeoffs, tell the user to switch the next message to the expert planner agent.',
  ].join(' ');
}

function buildExpertPlannerPrompt(profile: PersonalAssistantConfig): string {
  return [
    `You are ${profile.assistantName}'s expert planning counterpart.`,
    `Help ${profile.ownerName} redesign plans, sequence dependencies, and tighten milestones across projects and life commitments.`,
    'Prefer tradeoffs, sequencing decisions, and concrete execution plans over brainstorming.',
    'Assume the daily coach handles routine accountability and short check-ins.',
  ].join(' ');
}

export function buildPersonalAssistantAgent(profile: PersonalAssistantConfig): GatewayChatAgentConfig {
  return {
    id: profile.localAgentId,
    name: profile.assistantName,
    icon: '🧭',
    color: '#52796F',
    providerName: profile.localProviderName,
    model: profile.localModel,
    costClass: 'free',
    systemPrompt: buildLocalAssistantPrompt(profile),
    temperature: 0.4,
    maxTokens: 4096,
    enableReasoning: false,
    enabled: true,
    featureFlags: {
      webSearch: false,
      codeExecution: false,
    },
    routingPolicy: {
      allowedProviders: [profile.localProviderName],
      preferredCostClass: 'free',
      requiredCapabilities: ['chat'],
    },
    endpointConfig: {
      baseUrl: profile.localBaseUrl,
      modelParams: {
        notesSync: {
          repoPath: profile.notesRepoPath,
          timeZone: profile.timezone,
          sectionTitle: `${profile.assistantName} Chat`,
          commit: true,
          push: true,
        },
      },
    },
    contextSources: [],
  };
}

export function buildExpertPlannerAgent(profile: PersonalAssistantConfig): GatewayChatAgentConfig {
  return {
    id: profile.expertAgentId,
    name: 'Expert Planner',
    icon: '📐',
    color: '#354F52',
    providerName: profile.expertProviderName,
    model: profile.expertModel,
    costClass: 'premium',
    systemPrompt: buildExpertPlannerPrompt(profile),
    temperature: 0.2,
    maxTokens: 8192,
    enableReasoning: true,
    enabled: true,
    featureFlags: {
      webSearch: false,
      codeExecution: false,
    },
    routingPolicy: {
      allowedProviders: [profile.expertProviderName],
      preferredCostClass: 'premium',
      requiredCapabilities: ['chat'],
    },
    endpointConfig: {
      baseUrl: profile.expertBaseUrl,
      apiKey: profile.expertApiKey,
      modelParams: {},
    },
    contextSources: [],
  };
}

export function upsertManagedAssistantAgents(config: GatewayConfig, profile: PersonalAssistantConfig): string[] {
  const managedAgents = [buildPersonalAssistantAgent(profile), buildExpertPlannerAgent(profile)];
  const updatedIds: string[] = [];
  for (const managedAgent of managedAgents) {
    const existingIndex = config.serviceProfiles.gatewayChatPlatform.agents.findIndex((candidate) => candidate.id === managedAgent.id);
    if (existingIndex >= 0) {
      config.serviceProfiles.gatewayChatPlatform.agents[existingIndex] = managedAgent;
    } else {
      config.serviceProfiles.gatewayChatPlatform.agents.push(managedAgent);
    }
    updatedIds.push(managedAgent.id);
  }
  return updatedIds;
}

function buildWorkflowInput(profile: PersonalAssistantConfig, phase: 'morning' | 'midday' | 'evening', title: string): Record<string, unknown> {
  const notesSearchDirs = Array.isArray(profile.notesSearchDirs) && profile.notesSearchDirs.length > 0
    ? profile.notesSearchDirs
    : undefined;
  return {
    mode: 'check-in',
    phase,
    timeZone: profile.timezone,
    agentId: profile.localAgentId,
    planFilePath: profile.planFilePath,
    notesRepoPath: profile.notesRepoPath,
    notesSearchDirs,
    recentNotesLimit: profile.recentNotesLimit,
    inbox: {
      userId: profile.chatUserId,
      channelId: profile.chatChannelId,
      threadId: profile.chatThreadId,
      threadTitle: profile.chatThreadTitle,
      title,
      kind: 'coach_prompt',
    },
    noteLog: {
      enabled: true,
      commit: true,
    },
  };
}

export function buildPersonalAssistantWorkflowSeeds(profile: PersonalAssistantConfig): WorkflowSeedRecord[] {
  const prefix = profile.localAgentId;
  const notesSearchDirs = Array.isArray(profile.notesSearchDirs) && profile.notesSearchDirs.length > 0
    ? profile.notesSearchDirs
    : undefined;
  return [
    {
      name: `${prefix}-morning`,
      schedule: profile.schedules.morningCheckInCron,
      enabled: true,
      target: { type: 'gateway-jobs.run', ref: 'plan_progress_coach' },
      input: buildWorkflowInput(profile, 'morning', 'Morning Check-In'),
      timeoutSeconds: 120,
    },
    {
      name: `${prefix}-midday`,
      schedule: profile.schedules.middayCheckInCron,
      enabled: true,
      target: { type: 'gateway-jobs.run', ref: 'plan_progress_coach' },
      input: buildWorkflowInput(profile, 'midday', 'Midday Check-In'),
      timeoutSeconds: 120,
    },
    {
      name: `${prefix}-evening`,
      schedule: profile.schedules.eveningCheckInCron,
      enabled: true,
      target: { type: 'gateway-jobs.run', ref: 'plan_progress_coach' },
      input: buildWorkflowInput(profile, 'evening', 'Evening Reset'),
      timeoutSeconds: 120,
    },
    {
      name: `${prefix}-weekly-planning`,
      schedule: profile.schedules.weeklyPlanningCron,
      enabled: true,
      target: { type: 'gateway-jobs.run', ref: 'plan_progress_coach' },
      input: buildWorkflowInput(profile, 'morning', 'Weekly Kickoff'),
      timeoutSeconds: 120,
    },
    {
      name: `${prefix}-weekly-review`,
      schedule: profile.schedules.weeklyReviewCron,
      enabled: true,
      target: { type: 'gateway-jobs.run', ref: 'plan_progress_coach' },
      input: buildWorkflowInput(profile, 'evening', 'Weekly Review'),
      timeoutSeconds: 120,
    },
    {
      name: `${prefix}-log-progress`,
      schedule: '59 23 * * *',
      enabled: false,
      target: { type: 'gateway-jobs.run', ref: 'plan_progress_coach' },
      input: {
        mode: 'log-progress',
        timeZone: profile.timezone,
        agentId: profile.localAgentId,
        planFilePath: profile.planFilePath,
        notesRepoPath: profile.notesRepoPath,
        notesSearchDirs,
        recentNotesLimit: profile.recentNotesLimit,
        progressSource: 'manual-workflow-run',
        progressEntry: 'Replace this text before clicking Run.',
        includeReflection: true,
        inbox: {
          userId: profile.chatUserId,
          channelId: profile.chatChannelId,
          threadId: profile.chatThreadId,
          threadTitle: profile.chatThreadTitle,
          title: 'Progress Reflection',
          kind: 'coach_reflection',
        },
        noteLog: {
          enabled: true,
          commit: true,
        },
      },
      timeoutSeconds: 120,
    },
  ];
}

export function buildProjectTrackingUpserts(profile: PersonalAssistantConfig): ProjectTrackingProjectUpsert[] {
  return profile.projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    status: project.status,
    priority: project.priority,
    summary: project.summary,
    nextAction: project.nextAction,
    notesRepoPath: profile.notesRepoPath,
    planFilePath: profile.planFilePath,
    metadata: {
      notes: project.notes || null,
      repoSlug: project.repoSlug || null,
      planFilePath: project.planFilePath || null,
      reminder: project.reminder || null,
      managedBy: 'personal-assistant-builder',
    },
    milestones: project.deadline
      ? [
          {
            id: `${project.id}-deadline`,
            title: `${project.name} deadline`,
            status: project.status === 'done' ? 'done' : 'pending',
            targetDate: project.deadline,
            sortOrder: 1,
            notes: project.notes,
          },
        ]
      : [],
    update: {
      source: 'assistant-builder',
      kind: 'profile-sync',
      summary: project.summary,
      details: {
        nextAction: project.nextAction,
        deadline: project.deadline || null,
      },
    },
  }));
}
