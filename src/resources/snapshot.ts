import { createHash } from "node:crypto";

export type Observation = boolean | "unknown";
export type ResourceKind = "plugin" | "skill" | "instruction" | "agent" | "doc" | "learning";
export type ResourceScope = "user" | "workspace" | "plugin";
export type ResourceDelivery = "present" | "missing" | "stale" | "collision" | "not-applicable" | "unknown";
export type DiagnosticSeverity = "error" | "warning" | "info";

export interface ResourceRecordInput {
  kind: ResourceKind;
  name: string;
  scope: ResourceScope;
  workspaceKey?: string;
  pluginSpec?: string;
  source: {
    sourceHash: string;
    relativePath: string;
    revision?: string;
    contentHash?: string;
  };
  selected: boolean;
  owned: boolean;
  targetPath?: string;
  delivery: ResourceDelivery;
  configuredActive: Observation;
  runtime?: Partial<ResourceRecord["runtime"]>;
  reasons?: string[];
}

export interface ResourceRecord extends Omit<ResourceRecordInput, "runtime" | "reasons"> {
  id: string;
  runtime: {
    copilotCli: Observation;
    vscodeLocal: Observation;
    vscodeAgentHost: Observation;
  };
  reasons: string[];
}

export interface ResourceDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  resourceId?: string;
}

export interface ResourceSnapshot {
  schemaVersion: 1;
  cliVersion: string;
  scope: "user" | "workspace";
  resourceRevision: string | null;
  learningsRevision: null;
  resources: ResourceRecord[];
  diagnostics: ResourceDiagnostic[];
}

export interface ResourceSnapshotInput {
  cliVersion: string;
  scope: "user" | "workspace";
  resourceRevision?: string;
  resources: ResourceRecordInput[];
  diagnostics?: ResourceDiagnostic[];
}

export function resourceSourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function resourceRecord(input: ResourceRecordInput): ResourceRecord {
  const identity = [input.source.sourceHash, input.kind, input.scope, input.workspaceKey ?? "", input.name].join(":");
  return {
    ...input,
    id: identity,
    source: { ...input.source },
    runtime: {
      copilotCli: input.runtime?.copilotCli ?? "unknown",
      vscodeLocal: input.runtime?.vscodeLocal ?? "unknown",
      vscodeAgentHost: input.runtime?.vscodeAgentHost ?? "unknown",
    },
    reasons: [...new Set(input.reasons ?? [])].sort(compare),
  };
}

export function userPluginResource(input: {
  spec: string;
  sourceHash: string;
  relativePath: string;
  revision?: string;
  selected: boolean;
  owned: boolean;
  targetPath?: string;
  delivery: ResourceDelivery;
  configuredActive: Observation;
  expectedActive?: boolean;
}): ResourceRecord {
  const mismatch = input.expectedActive !== undefined && typeof input.configuredActive === "boolean" && input.configuredActive !== input.expectedActive;
  return resourceRecord({
    kind: "plugin",
    name: input.spec,
    scope: "user",
    pluginSpec: input.spec,
    source: {
      sourceHash: input.sourceHash,
      relativePath: input.relativePath,
      ...(input.revision ? { revision: input.revision } : {}),
    },
    selected: input.selected,
    owned: input.owned,
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    delivery: input.delivery,
    configuredActive: input.configuredActive,
    reasons: [
      ...(!input.owned ? ["NOT_MANAGED"] : []),
      ...(!input.owned && mismatch ? ["USER_OVERRIDE"] : []),
    ],
  });
}

export function computeResourceSnapshot(input: ResourceSnapshotInput): ResourceSnapshot {
  const resources = input.resources.map(resourceRecord).sort((left, right) => compare(left.id, right.id));
  const diagnostics = [...(input.diagnostics ?? [])];
  const add = (diagnostic: ResourceDiagnostic) => {
    if (!diagnostics.some((item) => item.code === diagnostic.code && item.resourceId === diagnostic.resourceId)) {
      diagnostics.push(diagnostic);
    }
  };

  for (const resource of resources) {
    if (resource.reasons.includes("USER_OVERRIDE")) {
      add({ code: "USER_OVERRIDE", severity: "warning", message: "Unowned plugin state preserved.", resourceId: resource.id });
    }
    if (resource.selected && resource.delivery === "collision") {
      add({ code: "RESOURCE_COLLISION", severity: "error", message: `${resource.kind} '${resource.name}' conflicts with an unowned target.`, resourceId: resource.id });
    } else if (resource.selected && resource.delivery === "missing") {
      add({ code: "RESOURCE_MISSING", severity: "warning", message: `${resource.kind} '${resource.name}' is not delivered.`, resourceId: resource.id });
    } else if (resource.selected && resource.delivery === "stale") {
      add({ code: "RESOURCE_STALE", severity: "warning", message: `${resource.kind} '${resource.name}' is stale.`, resourceId: resource.id });
    }
  }
  if (resources.some((resource) => Object.values(resource.runtime).includes("unknown"))) {
    add({ code: "RUNTIME_NOT_OBSERVED", severity: "info", message: "Runtime loading was not inspected." });
  }
  diagnostics.sort((left, right) => compare(left.code, right.code) || compare(left.resourceId ?? "", right.resourceId ?? ""));

  return {
    schemaVersion: 1,
    cliVersion: input.cliVersion,
    scope: input.scope,
    resourceRevision: input.resourceRevision ?? null,
    learningsRevision: null,
    resources,
    diagnostics,
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
