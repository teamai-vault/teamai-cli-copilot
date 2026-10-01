export type Role = string;

export interface MarketplaceConfig {
  name: string;
  source: string;
}

export type PluginMutationAction = "install" | "enable" | "disable" | "update";

export interface PluginObservedState {
  installed: boolean;
  version?: string;
  enabled?: boolean;
  cachePath?: string;
  manifestHash?: string;
  source?: string;
  installedFrom?: string;
}

export interface PluginMutationJournal {
  spec: string;
  action: PluginMutationAction;
  sourceManifestHash: string;
  marketplaceSource?: string;
  expectedBefore: PluginObservedState;
  expectedAfter: PluginObservedState;
}

export interface ManagedPluginReceipt {
  spec: string;
  manifestHash: string;
  version: string;
  enabled: boolean;
  marketplaceSource?: string;
  cachePath?: string;
  source?: string;
  installedFrom?: string;
}

export interface TeamAiConfig {
  version: 1;
  marketplace: MarketplaceConfig;
  marketplaceRevision?: string;
  role?: Role;
  managedPlugins?: string[];
  pendingPluginMutation?: PluginMutationJournal;
  managedPluginReceipts?: ManagedPluginReceipt[];
  managedSkills?: string[];
  managedSkillPaths?: Record<string, string>;
}

export function createConfig(marketplace: MarketplaceConfig): TeamAiConfig {
  return {
    version: 1,
    marketplace,
    managedPlugins: [],
    managedPluginReceipts: [],
    managedSkills: [],
    managedSkillPaths: {},
  };
}

export function validateConfig(value: unknown): TeamAiConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Team AI config must be a YAML object.");
  }

  const candidate = value as {
    version?: unknown;
    marketplace?: { name?: unknown; source?: unknown };
    marketplaceRevision?: unknown;
    role?: unknown;
    managedPlugins?: unknown;
    pendingPluginMutation?: unknown;
    managedPluginReceipts?: unknown;
    managedSkills?: unknown;
    managedSkillPaths?: unknown;
  };

  if (candidate.version !== 1) {
    throw new Error(`Unsupported Team AI config version: ${String(candidate.version)}`);
  }
  if (!candidate.marketplace || typeof candidate.marketplace.name !== "string") {
    throw new Error("Team AI config requires marketplace.name.");
  }
  const source = candidate.marketplace.source;
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("Team AI config requires marketplace.source.");
  }
  if (candidate.marketplaceRevision !== undefined && (typeof candidate.marketplaceRevision !== "string" || candidate.marketplaceRevision.length === 0)) {
    throw new Error(`Invalid marketplace revision in Team AI config: ${String(candidate.marketplaceRevision)}`);
  }
  if (candidate.role !== undefined && (typeof candidate.role !== "string" || candidate.role.length === 0)) {
    throw new Error(`Invalid role in Team AI config: ${String(candidate.role)}`);
  }
  if (candidate.managedPlugins !== undefined && (!Array.isArray(candidate.managedPlugins) || candidate.managedPlugins.some((item) => typeof item !== "string"))) {
    throw new Error("Team AI config managedPlugins must be a string array.");
  }
  if (candidate.pendingPluginMutation !== undefined && !isPluginMutationJournal(candidate.pendingPluginMutation)) {
    throw new Error("Team AI config pendingPluginMutation is invalid.");
  }
  if (candidate.managedPluginReceipts !== undefined && (!Array.isArray(candidate.managedPluginReceipts) || candidate.managedPluginReceipts.some((item) => !isManagedPluginReceipt(item)))) {
    throw new Error("Team AI config managedPluginReceipts is invalid.");
  }
  if (candidate.managedSkills !== undefined && (!Array.isArray(candidate.managedSkills) || candidate.managedSkills.some((item) => typeof item !== "string"))) {
    throw new Error("Team AI config managedSkills must be a string array.");
  }
  if (candidate.managedSkillPaths !== undefined && (!candidate.managedSkillPaths || typeof candidate.managedSkillPaths !== "object" || Array.isArray(candidate.managedSkillPaths) || Object.entries(candidate.managedSkillPaths).some(([name, target]) => typeof name !== "string" || typeof target !== "string"))) {
    throw new Error("Team AI config managedSkillPaths must map skill names to paths.");
  }

  return {
    version: 1,
    marketplace: {
      name: candidate.marketplace.name,
      source,
    },
    marketplaceRevision: candidate.marketplaceRevision as string | undefined,
    role: candidate.role as Role | undefined,
    managedPlugins: candidate.managedPlugins ?? [],
    pendingPluginMutation: candidate.pendingPluginMutation as PluginMutationJournal | undefined,
    managedPluginReceipts: candidate.managedPluginReceipts as ManagedPluginReceipt[] | undefined ?? [],
    managedSkills: candidate.managedSkills ?? [],
    managedSkillPaths: candidate.managedSkillPaths as Record<string, string> | undefined ?? {},
  };
}

function isPluginMutationJournal(value: unknown): value is PluginMutationJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PluginMutationJournal>;
  return typeof candidate.spec === "string"
    && (candidate.action === "install" || candidate.action === "enable" || candidate.action === "disable" || candidate.action === "update")
    && typeof candidate.sourceManifestHash === "string"
    && (candidate.marketplaceSource === undefined || typeof candidate.marketplaceSource === "string")
    && isPluginObservedState(candidate.expectedBefore)
    && isPluginObservedState(candidate.expectedAfter);
}

function isPluginObservedState(value: unknown): value is PluginObservedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PluginObservedState>;
  return typeof candidate.installed === "boolean"
    && (candidate.version === undefined || typeof candidate.version === "string")
    && (candidate.enabled === undefined || typeof candidate.enabled === "boolean")
    && (candidate.cachePath === undefined || typeof candidate.cachePath === "string")
    && (candidate.manifestHash === undefined || typeof candidate.manifestHash === "string")
    && (candidate.source === undefined || typeof candidate.source === "string")
    && (candidate.installedFrom === undefined || typeof candidate.installedFrom === "string");
}

function isManagedPluginReceipt(value: unknown): value is ManagedPluginReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ManagedPluginReceipt>;
  return typeof candidate.spec === "string"
    && typeof candidate.manifestHash === "string"
    && typeof candidate.version === "string"
    && typeof candidate.enabled === "boolean"
    && (candidate.marketplaceSource === undefined || typeof candidate.marketplaceSource === "string")
    && (candidate.cachePath === undefined || typeof candidate.cachePath === "string")
    && (candidate.source === undefined || typeof candidate.source === "string")
    && (candidate.installedFrom === undefined || typeof candidate.installedFrom === "string");
}
