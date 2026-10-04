import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { readGlobalConfig } from "../config/global.js";
import { inspectBuiltInTeamAiSkill } from "../copilot/builtin-skill.js";
import { inspectBuiltInRecallAgent } from "../copilot/builtin-agent.js";
import { enabledUserPlugins, inspectPluginSkillDelivery, inspectUserPluginResources } from "../copilot/plugins.js";
import { personalSkillPath } from "../copilot/skills.js";
import { checkUserInstructionState, discoverMarketplaceUserInstructions, userInstructionTargetRoot } from "../copilot/user-instructions.js";
import { installedPluginsRoot, marketplaceRegistrationMatches, readCopilotState, recordedUserPluginInventory } from "../copilot/user-state.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { convergeLogicalProjectContext, projectionFor } from "../project/context.js";
import { readProjectState, type ProjectComponentReceipt } from "../project/state.js";
import { readPublishedLearningSnapshot, readPublishedLearningSnapshotAt, type PublishedLearningFile } from "../project/published-cache.js";
import { directoriesEqual, pathsEqual } from "../utils/fs.js";
import { VERSION } from "../version.js";
import { computeResourceSnapshot, resourceSourceHash, type ResourceDiagnostic, type ResourceRecordInput, type ResourceSnapshot } from "../resources/snapshot.js";
import type { CommandContext } from "./context.js";

export async function collectResourceSnapshot(context: CommandContext): Promise<ResourceSnapshot> {
  const [config, identity] = await Promise.all([
    readGlobalConfig(context.homeDir),
    detectProjectIdentity(context.cwd),
  ]);
  const resources: ResourceRecordInput[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  let resourceRevision = config?.marketplaceRevision;
  const learningCache = config ? await readPublishedLearningSnapshot(config.marketplace.source, context.homeDir) : undefined;
  const learningsRevision = learningCache?.snapshot?.revision;
  if (config && !learningCache?.snapshot) {
    diagnostics.push({
      code: "LEARNINGS_CACHE_UNAVAILABLE",
      severity: "warning",
      message: learningCache?.error ?? "Published Learnings snapshot is unavailable. Run `teamai sync` to refresh it.",
    });
  }
  let sourceHash = resourceSourceHash(config?.marketplace.source ?? "teamai-cli");

  if (!config) {
    diagnostics.push({ code: "CONFIG_MISSING", severity: "warning", message: "Team AI is not initialized." });
  } else {
    if (config.pendingPluginMutation) {
      diagnostics.push({
        code: "PLUGIN_MUTATION_PENDING",
        severity: "warning",
        message: `Copilot Plugin ${config.pendingPluginMutation.action} for ${config.pendingPluginMutation.spec} has a durable pending checkpoint; run teamai sync to reconcile.`,
      });
    }
    const local = await readCopilotState(context.homeDir);
    const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
    try {
      if (catalog.name !== config.marketplace.name) {
        throw new Error(`Configured Marketplace name '${config.marketplace.name}' does not match source manifest '${catalog.name}'.`);
      }
      sourceHash = resourceSourceHash(config.marketplace.source);
      resourceRevision = catalog.revision ?? config.marketplaceRevision;
      const installed = await recordedUserPluginInventory(local, catalog, context.homeDir);
      const marketplaceRegistration = local.settings.extraKnownMarketplaces?.[config.marketplace.name];
      if (!marketplaceRegistration) {
        diagnostics.push({ code: "MARKETPLACE_NOT_REGISTERED", severity: "warning", message: "Marketplace registration is missing from Copilot settings." });
      } else if (!marketplaceRegistrationMatches(local.settings, config.marketplace.name, config.marketplace.source)) {
        diagnostics.push({ code: "MARKETPLACE_SOURCE_MISMATCH", severity: "error", message: "Marketplace registration source differs from Team AI config." });
      }
      let enabled = new Set<string>();
      if (config.role) {
        try {
          enabled = new Set(enabledUserPlugins(config.role, catalog.plugins, config.marketplace.name));
        } catch (error) {
          diagnostics.push({ code: "ROLE_UNAVAILABLE", severity: "error", message: (error as Error).message });
        }
      } else diagnostics.push({ code: "ROLE_UNCONFIGURED", severity: "warning", message: "Team AI role is not configured." });

      const pluginRows = await inspectUserPluginResources(catalog.plugins, config.marketplace.name, sourceHash, installed, {
        managedPlugins: config.managedPlugins,
        expectedEnabled: config.role ? enabled : undefined,
        settingsEnabled: local.settings.enabledPlugins,
        resourceRevision: catalog.revision,
      });
      for (const record of pluginRows) {
        const spec = record.pluginSpec!;
        if (record.delivery !== "missing" && record.owned && config.role && typeof record.configuredActive === "boolean" && record.configuredActive !== enabled.has(spec)) {
          diagnostics.push({
            code: "CONFIGURATION_MISMATCH",
            severity: "error",
            message: `${spec} does not match the selected role. Run teamai sync.`,
            resourceId: record.id,
          });
        }
      }
      resources.push(...pluginRows);
      const pluginBySpec = new Map(pluginRows.map((plugin) => [plugin.pluginSpec!, plugin]));
      const installedBySpec = new Map(installed.map((plugin) => [`${plugin.name}@${plugin.marketplace}`, plugin]));

      const desiredInstructions = await discoverMarketplaceUserInstructions(catalog.root);
      const instructionState = await checkUserInstructionState(desiredInstructions, userInstructionTargetRoot(context.homeDir));
      if (!instructionState.targetWritable) {
        diagnostics.push({ code: "TARGET_NOT_WRITABLE", severity: "error", message: "Managed user instruction target is not writable." });
      }
      const instructionChanges = new Map(instructionState.changes.map((change) => [change.relativePath, change.type]));
      for (const instruction of desiredInstructions) {
        const change = instructionChanges.get(instruction.relativePath);
        resources.push({
          kind: "instruction",
          name: instruction.relativePath,
          scope: "user",
          source: {
            sourceHash,
            relativePath: `instructions/${instruction.relativePath}`,
            revision: catalog.revision,
          },
          selected: true,
          owned: true,
          targetPath: path.join(userInstructionTargetRoot(context.homeDir), ...instruction.relativePath.split("/")),
          delivery: change === "create" ? "missing" : change === "update" ? "stale" : "present",
          configuredActive: "unknown",
        });
      }
      for (const change of instructionState.changes.filter((item) => item.type === "remove")) {
        resources.push({
          kind: "instruction",
          name: change.relativePath,
          scope: "user",
          source: { sourceHash, relativePath: `instructions/${change.relativePath}`, revision: catalog.revision },
          selected: false,
          owned: true,
          targetPath: path.join(userInstructionTargetRoot(context.homeDir), ...change.relativePath.split("/")),
          delivery: "stale",
          configuredActive: "unknown",
          reasons: ["No longer present in the Marketplace source."],
        });
      }

      for (const name of config.managedSkills ?? []) {
        const skill = catalog.skills.find((candidate) => candidate.name === name);
        if (!skill) {
          diagnostics.push({ code: "SKILL_SOURCE_MISSING", severity: "error", message: `Managed skill '${name}' is missing from the Marketplace catalog.` });
          continue;
        }
        const spec = skill.plugin ? `${skill.plugin}@${catalog.name}` : undefined;
        const plugin = spec ? pluginBySpec.get(spec) : undefined;
        const installedPlugin = spec ? installedBySpec.get(spec) : undefined;
        const pluginSkillDelivery = skill.sourceType === "plugin" && spec
          ? installedPlugin ? await inspectPluginSkillDelivery(installedPlugin, skill) : plugin?.delivery ?? "missing"
          : undefined;
        const availableViaPlugin = plugin?.configuredActive === true && pluginSkillDelivery === "present";
        if (skill.sourceType === "plugin" && spec && (plugin?.configuredActive === true || !skill.standalone)) {
          resources.push({
            kind: "skill",
            name,
            scope: "plugin",
            pluginSpec: spec,
            source: { sourceHash, relativePath: skill.sourcePath, revision: catalog.revision },
            selected: true,
            owned: plugin?.owned ?? false,
            targetPath: plugin?.targetPath ? path.join(plugin.targetPath, "skills", skill.name, "SKILL.md") : undefined,
            delivery: pluginSkillDelivery ?? plugin?.delivery ?? "missing",
            configuredActive: plugin?.configuredActive ?? "unknown",
            reasons: plugin && !plugin.owned ? ["NOT_MANAGED"] : [],
          });
          if (availableViaPlugin || !skill.standalone) continue;
        }
        const target = personalSkillPath(context.homeDir, name);
        const recordedTarget = config.managedSkillPaths?.[name];
        const owned = typeof recordedTarget === "string" && pathsEqual(recordedTarget, target);
        let delivery: ResourceRecordInput["delivery"];
        try {
          await lstat(target);
          delivery = owned ? (await directoriesEqual(skill.root, target) ? "present" : "stale") : "collision";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          delivery = owned ? "stale" : "missing";
        }
        resources.push({
          kind: "skill",
          name,
          scope: "user",
          source: { sourceHash, relativePath: skill.sourcePath, revision: catalog.revision },
          selected: true,
          owned,
          targetPath: target,
          delivery,
          configuredActive: true,
          reasons: delivery === "collision" ? ["UNOWNED_TARGET", "Target is not owned by Team AI."] : [],
        });
      }

      if (identity) {
        const state = await readProjectState(identity.projectAnchor, context.homeDir);
        const projection = projectionFor(state, identity.workspaceRoot);
        if (projection && (projection.logicalProjects.length > 0 || projection.pendingLogicalProjects !== undefined || projection.pendingProjectComponents !== undefined)) {
          const desiredLogicalProjects = projection.pendingLogicalProjects ?? projection.logicalProjects;
          const visibleLogicalProjects = [...new Set([...projection.logicalProjects, ...desiredLogicalProjects])];
          const unbind = projection.pendingLogicalProjects !== undefined && desiredLogicalProjects.length === 0;
          if (projection.pendingPublishedLearningRevision) {
            diagnostics.push({
              code: "LEARNINGS_PROJECTION_INCOMPLETE",
              severity: "warning",
              message: `Published Learnings projection is pending revision ${projection.pendingPublishedLearningRevision}. Run teamai sync.`,
            });
          }
          if (projection.pendingLogicalProjects !== undefined || projection.pendingProjectComponents !== undefined) {
            diagnostics.push({
              code: "PROJECT_PROJECTION_INCOMPLETE",
              severity: "warning",
              message: "Workspace Project projection is pending or incomplete. Run teamai sync.",
            });
          }
          let planned: Awaited<ReturnType<typeof convergeLogicalProjectContext>> | undefined;
          try {
            planned = await convergeLogicalProjectContext({
              marketplaceRoot: catalog.root,
              plugins: catalog.plugins,
              marketplace: config.marketplace,
              identity,
              state,
              logicalProjects: desiredLogicalProjects,
              homeDir: context.homeDir,
              sourceRevision: catalog.revision,
              publishedLearningRoot: learningCache?.snapshot?.root,
              unbind,
              dryRun: true,
            });
          } catch (error) {
            diagnostics.push({ code: "PROJECT_COMPONENT_PREFLIGHT_FAILED", severity: "error", message: (error as Error).message });
          }
          const changes = (planned?.changes ?? []).map((item) => path.resolve(item));
          const activeReceipts = planned?.projection.managedProjectComponents ?? (unbind ? [] : projection.pendingProjectComponents ?? projection.managedProjectComponents ?? []);
          const desiredTargets = new Set(activeReceipts.map((receipt) => receipt.targetPath));
          const oldReceipts = [...(projection.managedProjectComponents ?? []), ...(projection.pendingProjectComponents ?? [])];
          const componentSummaries = new Map<string, { receipt: ProjectComponentReceipt; selected: boolean; delivery: string }[]>();
          const componentObservations = new Map<string, Awaited<ReturnType<typeof workspaceComponentResource>>>();
          const addComponent = async (receipt: ProjectComponentReceipt, selected: boolean, reason?: string) => {
            const key = `${receipt.targetPath}\0${receipt.contentHash}`;
            const previous = componentObservations.get(key);
            if (previous) return;
            const observation = await workspaceComponentResource(receipt, selected, identity.workspaceRoot, sourceHash, changes, reason);
            componentObservations.set(key, observation);
            if (observation.resource) resources.push(observation.resource);
            else {
              const summaryKey = `${receipt.plugin}\0${receipt.kind}`;
              const summary = componentSummaries.get(summaryKey) ?? [];
              summary.push({ receipt, selected, delivery: observation.delivery });
              componentSummaries.set(summaryKey, summary);
            }
          };
          for (const receipt of activeReceipts) await addComponent(receipt, true);
          for (const receipt of oldReceipts) {
            if (desiredTargets.has(receipt.targetPath)) continue;
            await addComponent(receipt, false, "No longer selected by this Workspace projection.");
          }
          for (const summary of componentSummaries.values()) {
            const first = summary[0]!;
            const kind = first.receipt.kind.toUpperCase();
            const status = [...new Set(summary.map((item) => item.delivery))].sort().join(", ");
            diagnostics.push({
              code: `PROJECT_PLUGIN_${first.receipt.kind.toUpperCase()}_DECLARED`,
              severity: status.includes("collision") || status.includes("stale") ? "warning" : "info",
              message: `Project Plugin '${first.receipt.plugin}' declares ${kind} component files; ${summary.length} owned declaration(s), delivery ${status}; consumer runtime is unobserved.`,
            });
          }
          const projectPlugins = planned?.projection.selectedProjectPlugins ?? (unbind ? [] : projection.selectedProjectPlugins ?? []);
          for (const projectPlugin of projectPlugins) {
            let filesystemPackage = false;
            try {
              const packageInfo = await lstat(path.join(installedPluginsRoot(context.homeDir), config.marketplace.name, projectPlugin.plugin));
              filesystemPackage = packageInfo.isDirectory() || packageInfo.isSymbolicLink();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            if (installed.some((plugin) => plugin.name === projectPlugin.plugin && !plugin.discoveredOnly) || filesystemPackage) {
              diagnostics.push({
                code: "PROJECT_PLUGIN_USER_OVERRIDE",
                severity: "warning",
                message: "User-level Plugin '" + projectPlugin.plugin + "' is preserved; Workspace Project delivery is isolated from user-level installed/enabled Plugin state, and consumer isolation remains runtime-unverified.",
              });
            }
          }
          for (const id of visibleLogicalProjects) {
            const instructionRoot = path.join(projection.instructionRoot, id);
            const docsRoot = path.join(projection.contextRoot, id, "docs");
            const instruction = await workspaceProjectionResource("instruction", id, `contexts/${id}/instructions`, instructionRoot, identity.workspaceRoot, sourceHash, catalog.revision, changes);
            const docs = await workspaceProjectionResource("doc", id, `contexts/${id}/docs`, docsRoot, identity.workspaceRoot, sourceHash, catalog.revision, changes);
            if (instruction) resources.push(instruction);
            if (docs) resources.push(docs);
          }
          const pointer = path.join(projection.instructionRoot, "context.instructions.md");
          const pointerRecord = await workspaceProjectionResource("instruction", "context-pointer", "contexts/context.instructions.md", pointer, identity.workspaceRoot, sourceHash, catalog.revision, changes, true);
          if (pointerRecord) resources.push(pointerRecord);
          if (learningCache?.snapshot) {
            const active = new Set(visibleLogicalProjects);
            const currentPaths = new Set(learningCache.snapshot.files.map((file) => file.relativePath));
            for (const file of learningCache.snapshot.files) {
              if (file.logicalProject !== "shared" && !active.has(file.logicalProject)) continue;
              const target = workspaceLearningPath(projection.contextRoot, file);
              resources.push(await learningResource(file, target, "workspace", identity.workspaceRoot, sourceHash, learningCache.snapshot.revision));
            }
            if (projection.publishedLearningRevision && projection.publishedLearningRevision !== learningCache.snapshot.revision) {
              const previousRead = await readPublishedLearningSnapshotAt(config.marketplace.source, context.homeDir, projection.publishedLearningRevision);
              if (previousRead.snapshot) {
                for (const file of previousRead.snapshot.files) {
                  if ((file.logicalProject !== "shared" && !active.has(file.logicalProject)) || currentPaths.has(file.relativePath)) continue;
                  const stale = await learningResource(file, workspaceLearningPath(projection.contextRoot, file), "workspace", identity.workspaceRoot, sourceHash, previousRead.snapshot.revision);
                  if (stale.delivery === "missing") continue;
                  resources.push({
                    ...stale,
                    selected: false,
                    delivery: stale.delivery === "present" ? "stale" : stale.delivery,
                    reasons: [...(stale.reasons ?? []), "PUBLISHED_SOURCE_REMOVED"],
                  });
                }
              } else {
                diagnostics.push({
                  code: "LEARNINGS_PREVIOUS_SNAPSHOT_UNAVAILABLE",
                  severity: "warning",
                  message: `Could not verify prior Workspace Learnings revision ${projection.publishedLearningRevision}; run teamai sync.`,
                });
              }
            }
          }
        } else if (learningCache?.snapshot) {
          resources.push(...await userLearningResources(learningCache.snapshot.files, learningCache.snapshot.root, sourceHash, learningCache.snapshot.revision));
        }
      } else if (learningCache?.snapshot) {
        resources.push(...await userLearningResources(learningCache.snapshot.files, learningCache.snapshot.root, sourceHash, learningCache.snapshot.revision));
      }
    } finally {
      await catalog.dispose();
    }
  }

  const bundledSkill = await inspectBuiltInTeamAiSkill(context.homeDir);
  resources.push({
    kind: "skill",
    name: "teamai",
    scope: "user",
    source: { sourceHash: resourceSourceHash("teamai-cli:skills/teamai"), relativePath: "skills/teamai", revision: bundledSkill.version },
    selected: true,
    owned: bundledSkill.status === "current" || bundledSkill.status === "stale",
    targetPath: bundledSkill.target,
    delivery: bundledSkill.status === "current" ? "present" : bundledSkill.status,
    configuredActive: "unknown",
    reasons: bundledSkill.reason ? [bundledSkill.reason] : [],
  });

  const bundledAgent = await inspectBuiltInRecallAgent(context.homeDir);
  resources.push({
    kind: "agent",
    name: "teamai-recall",
    scope: "user",
    source: { sourceHash: resourceSourceHash("teamai-cli"), relativePath: "agents/teamai-recall.agent.md", revision: bundledAgent.version, contentHash: bundledAgent.contentHash },
    selected: true,
    owned: bundledAgent.owned,
    targetPath: bundledAgent.target,
    delivery: bundledAgent.status === "current" ? "present" : bundledAgent.status,
    configuredActive: "unknown",
    reasons: bundledAgent.reason ? [bundledAgent.reason] : [],
  });
  if (bundledAgent.pending) {
    diagnostics.push({ code: "BUILTIN_AGENT_DELIVERY_PENDING", severity: bundledAgent.status === "collision" ? "error" : "warning", message: bundledAgent.reason ?? "Partial Recall Agent delivery awaits receipt confirmation." });
  }

  return computeResourceSnapshot({
    cliVersion: VERSION,
    scope: identity ? "workspace" : "user",
    resourceRevision,
    learningsRevision,
    resources,
    diagnostics,
  });
}

function workspaceLearningPath(contextRoot: string, file: PublishedLearningFile): string {
  const relativeFile = file.relativePath.split("/").slice(2);
  return file.logicalProject === "shared"
    ? path.join(contextRoot, "shared", "learnings", ...relativeFile)
    : path.join(contextRoot, file.logicalProject, "learnings", ...relativeFile);
}

async function userLearningResources(
  files: PublishedLearningFile[],
  cacheRoot: string,
  sourceHash: string,
  revision: string,
): Promise<ResourceRecordInput[]> {
  const records: ResourceRecordInput[] = [];
  for (const file of files.filter((candidate) => candidate.logicalProject === "shared")) {
    const target = path.join(cacheRoot, ...file.relativePath.split("/"));
    records.push(await learningResource(file, target, "user", undefined, sourceHash, revision, true));
  }
  return records;
}

async function learningResource(
  file: PublishedLearningFile,
  targetPath: string,
  scope: "user" | "workspace",
  workspaceKey: string | undefined,
  sourceHash: string,
  revision: string,
  verifiedCacheFile = false,
): Promise<ResourceRecordInput> {
  let delivery: ResourceRecordInput["delivery"] = "present";
  if (!verifiedCacheFile) {
    try {
      const info = await lstat(targetPath);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) delivery = "collision";
      else delivery = (await readFile(targetPath)).equals(file.content) ? "present" : "stale";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") delivery = "missing";
      else throw error;
    }
  }
  return {
    kind: "learning",
    name: file.relativePath,
    scope,
    ...(workspaceKey ? { workspaceKey } : {}),
    source: { sourceHash, relativePath: file.relativePath, revision, contentHash: file.contentHash },
    selected: true,
    owned: true,
    targetPath,
    delivery,
    configuredActive: true,
    reasons: delivery === "collision" ? ["UNSAFE_TARGET"] : [],
  };
}

async function workspaceComponentResource(
  receipt: ProjectComponentReceipt,
  selected: boolean,
  workspaceRoot: string,
  sourceHash: string,
  plannedChanges: string[],
  reason?: string,
): Promise<{ resource?: ResourceRecordInput; delivery: ResourceRecordInput["delivery"] }> {
  const mcpEntry = receipt.targetPath.startsWith(".mcp.json#mcpServers/");
  const targetPath = mcpEntry
    ? path.join(workspaceRoot, ".mcp.json") + receipt.targetPath.slice(".mcp.json".length)
    : path.resolve(workspaceRoot, ...receipt.targetPath.split("/"));
  let actualHash: string | undefined;
  let exists = false;
  try {
    if (mcpEntry) {
      const raw = await readFile(path.join(workspaceRoot, ".mcp.json"), "utf8");
      const errors: ParseError[] = [];
      const document = parseJsonc(raw, errors, { allowTrailingComma: false, disallowComments: false }) as { mcpServers?: Record<string, unknown> } | undefined;
      if (errors.length > 0) exists = true;
      else if (document?.mcpServers) {
        const name = receipt.targetPath.slice(".mcp.json#mcpServers/".length);
        const value = document.mcpServers[name];
        if (value !== undefined) {
          exists = true;
          actualHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
        }
      }
    } else {
      const info = await lstat(targetPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Unsafe Project component target: " + targetPath);
      exists = true;
      actualHash = createHash("sha256").update(await readFile(targetPath)).digest("hex");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hashMatches = actualHash === receipt.contentHash;
  const plannedTarget = mcpEntry
    ? path.resolve(workspaceRoot, ".mcp.json")
    : path.resolve(targetPath);
  const planned = plannedChanges.some((change) => path.resolve(change) === plannedTarget);
  const delivery: ResourceRecordInput["delivery"] = hashMatches
    ? "present"
    : exists ? "stale" : planned ? "missing" : "missing";
  if (receipt.kind === "hook" || receipt.kind === "mcp") return { delivery };
  return { delivery, resource: {
    kind: receipt.kind,
    name: receipt.projectIds.join(",") + ":" + receipt.plugin + ":" + receipt.sourcePath,
    scope: "workspace",
    workspaceKey: workspaceRoot,
    pluginSpec: receipt.plugin,
    source: {
      sourceHash,
      relativePath: receipt.sourcePath,
      ...(receipt.sourceRevision ? { revision: receipt.sourceRevision } : {}),
      contentHash: receipt.contentHash,
    },
    selected,
    owned: true,
    targetPath,
    delivery,
    configuredActive: true,
    reasons: [
      ...(reason ? [reason] : []),
      ...(!selected ? ["PROJECT_COMPONENT_RETIRED"] : []),
    ],
  } };
}

async function workspaceProjectionResource(
  kind: "instruction" | "doc",
  name: string,
  relativePath: string,
  targetPath: string,
  workspaceRoot: string,
  sourceHash: string,
  revision: string | undefined,
  changes: string[],
  file = false,
): Promise<ResourceRecordInput | undefined> {
  const target = path.resolve(targetPath);
  const changed = changes.some((change) => change === target || (!file && isWithin(change, target)));
  let present = false;
  try {
    await lstat(target);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!present && !changed) return undefined;
  return {
    kind,
    name,
    scope: "workspace",
    workspaceKey: workspaceRoot,
    source: { sourceHash, relativePath, revision },
    selected: true,
    owned: true,
    targetPath: target,
    delivery: changed ? present ? "stale" : "missing" : present ? "present" : "missing",
    configuredActive: true,
  };
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
