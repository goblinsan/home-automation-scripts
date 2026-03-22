import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import type { CommandContext } from './deploy.ts';

export interface WorkflowTarget {
  type: string;
  ref: string;
}

export interface WorkflowRetryPolicy {
  maxAttempts?: number;
  backoffSeconds?: number;
}

export interface WorkflowSeedRecord {
  name: string;
  schedule: string;
  target: WorkflowTarget;
  enabled?: boolean;
  input?: Record<string, unknown>;
  secrets?: string[];
  timeoutSeconds?: number;
  retryPolicy?: WorkflowRetryPolicy;
}

export interface WorkflowRecord extends WorkflowSeedRecord {
  id: string;
}

export interface WorkflowImportOperation {
  type: 'create' | 'update';
  name: string;
  id?: string;
  body: WorkflowSeedRecord;
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function requestWorkflowApi(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST' | 'PUT',
  body?: unknown
): Promise<{ status: number; payload: unknown }> {
  const requestUrl = `${normalizeBaseUrl(baseUrl)}${path}`;
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const requestImpl = requestUrl.startsWith('https://') ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      requestUrl,
      {
        method,
        timeout: 10_000,
        headers: requestBody
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(requestBody)
            }
          : undefined
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        });
        response.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            payload: responseText.length > 0 ? JSON.parse(responseText) as unknown : null
          });
        });
      }
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${requestUrl}`)));
    if (requestBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

export function planWorkflowSeedImport(
  existing: WorkflowRecord[],
  seed: WorkflowSeedRecord[]
): WorkflowImportOperation[] {
  const existingByName = new Map(existing.map((workflow) => [workflow.name, workflow]));

  return seed.map((workflow) => {
    const existingWorkflow = existingByName.get(workflow.name);
    if (existingWorkflow) {
      return {
        type: 'update',
        name: workflow.name,
        id: existingWorkflow.id,
        body: workflow
      };
    }

    return {
      type: 'create',
      name: workflow.name,
      body: workflow
    };
  });
}

export async function loadWorkflowSeed(filePath: string): Promise<WorkflowSeedRecord[]> {
  const absolutePath = resolve(filePath);
  const fileText = await readFile(absolutePath, 'utf8');
  const parsed = JSON.parse(fileText) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Workflow seed file must be an array: ${filePath}`);
  }
  return parsed as WorkflowSeedRecord[];
}

export async function importWorkflowSeed(
  baseUrl: string,
  filePath: string,
  context: CommandContext
): Promise<void> {
  const seed = await loadWorkflowSeed(filePath);
  const listResponse = await requestWorkflowApi(baseUrl, '/api/workflows', 'GET');
  if (listResponse.status !== 200 || !Array.isArray(listResponse.payload)) {
    throw new Error(`Failed to list existing workflows from ${baseUrl}`);
  }

  const operations = planWorkflowSeedImport(listResponse.payload as WorkflowRecord[], seed);
  for (const operation of operations) {
    const description = `${operation.type.toUpperCase()} workflow ${operation.name}`;
    context.log(`${context.dryRun ? '[dry-run] ' : ''}${description}`);
    if (context.dryRun) {
      continue;
    }

    const response = operation.type === 'create'
      ? await requestWorkflowApi(baseUrl, '/api/workflows', 'POST', operation.body)
      : await requestWorkflowApi(baseUrl, `/api/workflows/${operation.id}`, 'PUT', operation.body);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${description} failed: ${response.status} ${JSON.stringify(response.payload)}`);
    }
  }
}
