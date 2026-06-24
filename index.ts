import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, type AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

type Mode = "off" | "ask" | "plan" | "review" | "debug" | "docs" | "deploy" | "execute";
type PlanState = "draft" | "approved" | "executing" | "revise";
type PlanKind = "general" | "bug" | "feature" | "refactor" | "e2e" | "migration";
type BashPolicy = "safe" | "diagnostic" | "unrestricted";
type WritePolicy = "none" | "plans" | "docs" | "all";
type PanelDensity = "compact" | "full";

interface ModeState { mode: Mode; planState: PlanState; planKind: PlanKind; toolsBeforeMode?: string[]; lastPromptedHash?: string; locked?: boolean; previousThinkingLevel?: string; panelDensity?: PanelDensity }
interface ModeProfile { icon: string; tone: "accent" | "warning" | "success" | "error"; tools?: string[]; blockedTools?: string[]; bashPolicy: BashPolicy; writePolicy: WritePolicy; skills: string[]; focus: string; next: string }
interface ModeManagerConfig { docsRoots?: string[]; docsExtensions?: string[]; confirmExecuteFromModes?: Mode[]; extraSafeBashPatterns?: string[]; modeThinkingLevels?: Partial<Record<Mode, "off" | "minimal" | "low" | "medium" | "high" | "xhigh">> }
interface ModePreset { mode: Mode; planKind?: PlanKind; planState?: PlanState; panelDensity?: PanelDensity; thinkingLevel?: string; note?: string; updatedAt: string }

const PLAN_KINDS = new Set<PlanKind>(["general", "bug", "feature", "refactor", "e2e", "migration"]);
const MANAGED_TOOLS = new Set(["read", "bash", "write", "edit", "grep", "find", "ls", "questionnaire", "todo", "task_memory"]);
const SAFE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

const PROFILES: Record<Exclude<Mode, "off">, ModeProfile> = {
  ask: { icon: "💬", tone: "accent", tools: SAFE_TOOLS, blockedTools: ["edit", "write", "todo", "task_memory"], bashPolicy: "safe", writePolicy: "none", skills: ["mode-ask"], focus: "answer questions · explain · compare · summarize", next: "/mode plan or /mode off" },
  plan: { icon: "📋", tone: "warning", tools: [...SAFE_TOOLS, "write", "todo"], blockedTools: ["edit"], bashPolicy: "safe", writePolicy: "plans", skills: ["mode-plan", "testing-strategy", "review-risk-framework"], focus: "read-only planning · markdown plans · todo breakdowns", next: "/plan validate → /plan approve" },
  review: { icon: "🔍", tone: "accent", tools: SAFE_TOOLS, blockedTools: ["edit", "write", "todo"], bashPolicy: "safe", writePolicy: "none", skills: ["pre-review", "security-review", "testing-strategy", "validate-migration"], focus: "review findings only · cite files · no changes", next: "/mode off or /mode execute" },
  debug: { icon: "🐞", tone: "warning", tools: [...SAFE_TOOLS, "todo"], blockedTools: ["edit", "write"], bashPolicy: "diagnostic", writePolicy: "none", skills: ["debug", "testing-strategy"], focus: "hypothesis → evidence → next probe", next: "/mode execute after root cause" },
  docs: { icon: "📝", tone: "success", tools: [...SAFE_TOOLS, "write", "edit"], blockedTools: [], bashPolicy: "safe", writePolicy: "docs", skills: ["confluence", "confluence-research"], focus: "documentation-only changes", next: "write docs or /mode off" },
  deploy: { icon: "🚀", tone: "warning", tools: [...SAFE_TOOLS, "task_memory"], blockedTools: ["edit", "write", "todo"], bashPolicy: "safe", writePolicy: "none", skills: ["deploy-checklist", "observability"], focus: "deploy readiness · post-deploy checks", next: "check readiness or /mode off" },
  execute: { icon: "▶", tone: "success", bashPolicy: "unrestricted", writePolicy: "all", skills: ["feature-dev", "testing-strategy", "desloppify"], focus: "implement approved work · keep todos updated", next: "validate and complete tasks" },
};

const DESTRUCTIVE_PATTERNS = [/\brm\b/i,/\brmdir\b/i,/\bmv\b/i,/\bcp\b/i,/\bmkdir\b/i,/\btouch\b/i,/\bchmod\b/i,/\bchown\b/i,/\bchgrp\b/i,/\bln\b/i,/\btee\b/i,/\btruncate\b/i,/\bdd\b/i,/(^|[^<])>(?!>)/,/>>/,/\b(npm|yarn|pnpm|bun)\s+(install|add|remove|update|ci|link|publish|upgrade)\b/i,/\bpip\s+(install|uninstall)\b/i,/\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,/\bbrew\s+(install|uninstall|upgrade)\b/i,/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|clean)\b/i,/\bsudo\b/i,/\bsu\b/i,/\bkill(all)?\b/i,/\bpkill\b/i,/\breboot\b/i,/\bshutdown\b/i,/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,/\bservice\s+\S+\s+(start|stop|restart)\b/i,/\b(vim?|nano|emacs|code|subl)\b/i];
const SAFE_SEGMENT_PATTERNS = [/^\s*(cat|head|tail|less|more|grep|rg|find|fd|ls|pwd|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|cal|uptime|ps|top|htop|free|jq|awk|bat|eza)\b/i,/^\s*sed\s+-n\b/i,/^\s*echo\b/i,/^\s*printf\b/i,/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|ls-tree|grep|describe)\b/i,/^\s*(npm|yarn|pnpm|bun)\s+(list|ls|view|info|search|outdated|audit|why)\b/i,/^\s*(node|python|python3|ruby|go|rustc|cargo|java)\s+(--version|-v|version)\b/i,/^\s*curl\s+(-I|--head|-s|-fsSL|https?:\/\/)/i,/^\s*wget\s+(-O\s*-|--spider)/i];
const DIAGNOSTIC_SEGMENT_PATTERNS = [/^\s*(npm|yarn|pnpm|bun)\s+(test|run\s+(test|lint|typecheck|build)|lint|typecheck)\b/i,/^\s*(pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b/i];
const REQUIRED_HEADINGS = ["Goal","Context / findings","Assumptions","Proposed approach","Files likely affected","Step-by-step plan","Execution tasks","Testing / validation strategy","Risks and mitigations","Open questions","Rollback plan"];
const DEFAULT_CONFIG: Required<ModeManagerConfig> = { docsRoots: ["docs", "plans", "."], docsExtensions: [".md", ".mdx", ".rst"], confirmExecuteFromModes: ["ask", "review", "debug", "deploy"], extraSafeBashPatterns: [], modeThinkingLevels: { ask: "medium", plan: "high", review: "high", debug: "high", docs: "medium", deploy: "medium", execute: "medium" } };

function unique(values: string[]) { return [...new Set(values)]; }
function splitCommand(command: string) { return command.split(/\s*(?:&&|\|\||\||;)\s*/g).map((p) => p.trim()).filter(Boolean); }
function commandMatches(command: string, patterns: RegExp[]) { return splitCommand(command).every((segment) => patterns.some((p) => p.test(segment))); }
function isSafeCommand(command: string) { return !!command.trim() && !DESTRUCTIVE_PATTERNS.some((p) => p.test(command)) && commandMatches(command, SAFE_SEGMENT_PATTERNS); }
function isDiagnosticCommand(command: string) { return !!command.trim() && !DESTRUCTIVE_PATTERNS.some((p) => p.test(command)) && commandMatches(command, [...SAFE_SEGMENT_PATTERNS, ...DIAGNOSTIC_SEGMENT_PATTERNS]); }
function isUnder(cwd: string, inputPath: string, roots: string[], exts: string[]) { const abs = resolve(cwd, inputPath); return exts.some((e) => abs.endsWith(e)) && roots.some((r) => { const rel = relative(resolve(cwd, r), abs); return Boolean(rel) && !rel.startsWith("..") && !rel.startsWith(sep); }); }
function isAssistantMessage(message: AgentMessage): message is AssistantMessage { return message.role === "assistant" && Array.isArray(message.content); }
function getTextContent(message: AssistantMessage) { return message.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("\n"); }
function latestAssistantText(ctx: ExtensionContext) { const entries = ctx.sessionManager.getEntries(); for (let i = entries.length - 1; i >= 0; i--) { const e = entries[i]; if (e.type === "message" && "message" in e && isAssistantMessage(e.message as AgentMessage)) return getTextContent(e.message as AssistantMessage); } }
function hashText(text: string) { let hash = 5381; for (let i = 0; i < text.length; i++) hash = (hash * 33) ^ text.charCodeAt(i); return (hash >>> 0).toString(16); }
function hasHeading(text: string, heading: string) { const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return new RegExp(`^#{2,3}\\s+${escaped}\\s*$`, "im").test(text); }
function validatePlanText(text: string) { const issues: string[] = []; for (const h of REQUIRED_HEADINGS) if (!hasHeading(text, h)) issues.push(`Missing heading: ## ${h}`); if (!/^---\n[\s\S]*?\n---/m.test(text)) issues.push("Missing YAML frontmatter metadata block"); if (!/##\s+Risk score/im.test(text)) issues.push("Missing risk score section"); if (!/##\s+Acceptance criteria/im.test(text)) issues.push("Missing acceptance criteria section"); const m = (text.match(/```mermaid/g) ?? []).length; const f = (text.match(/```/g) ?? []).length; if (m > 0 && f < m * 2) issues.push("Mermaid fence appears unclosed"); return issues; }

function completeFrom(values: string[], prefix: string, descriptions: Record<string, string> = {}): AutocompleteItem[] | null {
  const current = prefix.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  const items = values
    .filter((value) => value.startsWith(current) || value.split(/\s+/)[0] === current)
    .map((value) => ({ value, label: value, description: descriptions[value] }));
  return items.length ? items : null;
}

const MODE_COMMANDS = ["ask", "plan", "review", "debug", "docs", "deploy", "execute", "off", "status", "doctor", "history", "tools", "config", "reset", "compact", "full", "preset", "presets", "reload-config", "lock", "unlock"];
const MODE_DESCRIPTIONS: Record<string, string> = { ask: "read-only Q&A", plan: "structured planning", review: "read-only review", debug: "diagnostics/tests", docs: "documentation-only writes", deploy: "deploy checklist", execute: "normal implementation", off: "restore tools", doctor: "diagnose mode setup", history: "show transition audit", tools: "show tool policy", config: "show loaded config", reset: "clear mode state", compact: "compact mode panel", full: "full mode panel", preset: "apply/save preset", presets: "list presets", "reload-config": "reload config.json", lock: "prevent accidental mode switches", unlock: "allow mode switches" };
const PLAN_COMMANDS = ["draft", "approve", "execute", "execute force", "revise", "save", "tasks", "todos", "validate", "preflight", "diff", "review", "pr", "deploy", "graph", "evidence", "index", "memory", "bug", "feature", "refactor", "e2e", "migration", "off", "status"];
const PLAN_DESCRIPTIONS: Record<string, string> = { draft: "enter draft planning", approve: "approve valid plan", execute: "execute approved plan", "execute force": "execute without approval", revise: "revise latest plan", save: "save latest plan", tasks: "create todo breakdown", validate: "validate plan shape", memory: "save secret-safe memory note", preflight: "check execute readiness", diff: "compare plans", review: "critique plan", pr: "draft PR body", deploy: "deployment checklist", graph: "task dependency graph", evidence: "completion evidence checklist", index: "update plans/index.md" };

function presetNameItems(): AutocompleteItem[] {
  return Object.keys(readPresets()).sort().map((name) => ({ value: name, label: name, description: "saved mode preset" }));
}
function completeModeArgs(prefix: string): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(prefix);
  if (parts[0] === "preset") {
    if (parts.length === 1 && !endsWithSpace) return completeFrom(["preset"], prefix, MODE_DESCRIPTIONS);
    if (parts.length <= 2 && !endsWithSpace) return completeFrom(["list", "save", "delete", ...Object.keys(readPresets()).sort()], parts[1] ?? "", { list: "list presets", save: "save current mode", delete: "delete preset" });
    if (parts[1] === "delete" || parts[1] === "rm") return presetNameItems().filter((item) => item.value.startsWith(parts[2] ?? ""));
    return null;
  }
  if (parts[0] === "presets") return completeFrom(["presets"], prefix, MODE_DESCRIPTIONS);
  return completeFrom(MODE_COMMANDS, prefix, MODE_DESCRIPTIONS);
}
function completePlanArgs(prefix: string): AutocompleteItem[] | null {
  const parts = prefix.trimStart().split(/\s+/).filter(Boolean);
  if (parts[0] === "execute" && /\s$/.test(prefix)) return [{ value: "force", label: "force", description: "execute without approval" }];
  if (parts[0] === "execute" && parts.length === 2) return completeFrom(["force"], parts[1], { force: "execute without approval" });
  return completeFrom(PLAN_COMMANDS, prefix, PLAN_DESCRIPTIONS);
}

function extensionConfigPath(): string { return join(dirname(fileURLToPath(import.meta.url)), "config.json"); }
function projectConfigPath(cwd: string): string { return join(cwd, ".pi", "mode-manager.json"); }
function mergeConfig(base: Required<ModeManagerConfig>, override: ModeManagerConfig): Required<ModeManagerConfig> {
  return {
    ...base,
    ...override,
    modeThinkingLevels: { ...base.modeThinkingLevels, ...(override.modeThinkingLevels ?? {}) },
  };
}
function readConfigFile(path: string): ModeManagerConfig | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as ModeManagerConfig; }
  catch { return undefined; }
}
function loadConfig(cwd?: string, trusted = false): { config: Required<ModeManagerConfig>; sources: string[] } {
  let config = DEFAULT_CONFIG;
  const sources = ["defaults"];
  const extensionConfig = readConfigFile(extensionConfigPath());
  if (extensionConfig) { config = mergeConfig(config, extensionConfig); sources.push(extensionConfigPath()); }
  if (cwd && trusted) {
    const projectPath = projectConfigPath(cwd);
    const projectConfig = readConfigFile(projectPath);
    if (projectConfig) { config = mergeConfig(config, projectConfig); sources.push(projectPath); }
  }
  return { config, sources };
}

function presetsPath(): string { return join(dirname(fileURLToPath(import.meta.url)), "presets.json"); }
function normalizePresetName(name: string): string { return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); }
function readPresets(): Record<string, ModePreset> {
  const path = presetsPath();
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, ModePreset>; }
  catch { return {}; }
}
function writePresets(presets: Record<string, ModePreset>) {
  mkdirSync(dirname(presetsPath()), { recursive: true });
  writeFileSync(presetsPath(), `${JSON.stringify(presets, null, 2)}
`, "utf8");
}

function commandForKind(kind: PlanKind) { return ({ general: "Create a general implementation plan.", bug: "Create a bug investigation and fix plan with hypotheses, repro steps, diagnostics, regression tests, and rollback.", feature: "Create a feature implementation plan with rollout, flags if useful, acceptance criteria, observability, and PR/deploy considerations.", refactor: "Create a refactor plan emphasizing behavior preservation, staged changes, tests, and rollback.", e2e: "Create an end-to-end test plan with personas, fixtures, setup/teardown, assertions, and failure diagnostics.", migration: "Create a migration plan with backward compatibility, data safety, validation, rollback, schema dump expectations, and cross-service impact." } satisfies Record<PlanKind,string>)[kind]; }

export default function modeManager(pi: ExtensionAPI): void {
  let mode: Mode = "off";
  let planState: PlanState = "draft";
  let planKind: PlanKind = "general";
  let toolsBeforeMode: string[] | undefined;
  let lastPromptedHash: string | undefined;
  let locked = false;
  let previousThinkingLevel: string | undefined;
  let panelDensity: PanelDensity = "full";
  let loaded = loadConfig();
  let config = loaded.config;
  let configSources = loaded.sources;

  pi.registerFlag("start-mode", { description: "Start in mode: ask, plan, review, debug, docs, deploy, execute", type: "string" });

  function persist() { pi.appendEntry("mode-manager", { mode, planState, planKind, toolsBeforeMode, lastPromptedHash, locked, previousThinkingLevel, panelDensity } satisfies ModeState); }
  function audit(from: Mode, to: Mode, reason: string) { pi.appendEntry("mode-manager-audit", { at: new Date().toISOString(), from, to, reason, planState, planKind, locked }); }
  function profile() { return mode === "off" ? undefined : PROFILES[mode]; }
  function activeToolsFor(p: ModeProfile) { if (p.writePolicy === "all" && !p.tools) return toolsBeforeMode ?? pi.getActiveTools(); return unique([...(toolsBeforeMode ?? pi.getActiveTools()).filter((t) => !MANAGED_TOOLS.has(t)), ...(p.tools ?? toolsBeforeMode ?? pi.getActiveTools())]); }
  function modeLabel() { return mode === "plan" ? `PLAN ${planState.toUpperCase()} ─ ${planKind}` : mode.toUpperCase(); }

  function updateStatus(ctx: ExtensionContext) {
    const p = profile();
    ctx.ui.setStatus("mode-manager", p ? ctx.ui.theme.fg(p.tone, `${p.icon} ${mode}`) : undefined);
    const widget = !p ? undefined : panelDensity === "compact" ? [
      ctx.ui.theme.fg(p.tone, `🧭 ${p.icon} ${modeLabel()} · write:${p.writePolicy} · bash:${p.bashPolicy} · ${locked ? "locked" : "unlocked"} · /mode full`),
    ] : [
      ctx.ui.theme.fg(p.tone, `╭─ 🧭 MODE: ${p.icon} ${modeLabel()}`),
      `│ Focus      ${p.focus}`,
      `│ Safety     ${p.writePolicy === "all" ? ctx.ui.theme.fg("warning", "normal tool access") : ctx.ui.theme.fg("success", "constrained")} · write: ${p.writePolicy} · bash: ${p.bashPolicy}`,
      `│ Tools      ${(p.tools ?? ["previous/default"]).join(" · ")}`,
      `│ Skills     ${p.skills.join(" · ")}`,
      `│ Next       ${ctx.ui.theme.fg("accent", mode === "plan" ? (planState === "approved" ? "/plan execute" : p.next) : p.next)}`,
      `│ Lock       ${locked ? ctx.ui.theme.fg("warning", "locked") : "unlocked"} · Thinking ${config.modeThinkingLevels[mode] ?? "default"} · Panel ${panelDensity}`,
      `│ Switch     /mode ask · /mode plan · /mode review · /mode off · /mode compact`,
      ctx.ui.theme.fg(p.tone, "╰────────────────────────────────────────────────────────"),
    ];
    ctx.ui.setWidget("mode-manager", widget);
  }

  function setMode(next: Mode, ctx: ExtensionContext) {
    if (next === "off") {
      mode = "off";
      if (toolsBeforeMode) pi.setActiveTools(toolsBeforeMode);
      toolsBeforeMode = undefined;
      if (previousThinkingLevel) pi.setThinkingLevel(previousThinkingLevel as any);
      previousThinkingLevel = undefined;
      audit(mode, "off", "mode off");
      ctx.ui.notify("Mode manager off. Previous tools restored.", "info");
      updateStatus(ctx); persist(); return;
    }
    if (locked && mode !== "off" && next !== mode) { ctx.ui.notify(`Mode is locked to ${mode}. Use /mode unlock first.`, "warning"); return; }
    toolsBeforeMode = toolsBeforeMode ?? pi.getActiveTools();
    previousThinkingLevel = previousThinkingLevel ?? pi.getThinkingLevel();
    const from = mode;
    mode = next;
    if (next === "plan" && planState === "executing") planState = "draft";
    pi.setActiveTools(activeToolsFor(PROFILES[next]));
    const thinking = config.modeThinkingLevels[next];
    if (thinking) pi.setThinkingLevel(thinking);
    audit(from, next, "mode switch");
    ctx.ui.notify(`Mode set: ${next}`, "info");
    updateStatus(ctx); persist();
  }

  function requestSave(name: string) { const path = `plans/${new Date().toISOString().slice(0,10)}-${name}.md`; pi.sendUserMessage(`Save the latest plan to ${path}. Add YAML frontmatter with status: ${planState}, kind: ${planKind}, created date, risk, repos if known, related task/Jira if known, and plan_mode: true. Use the write tool only for that markdown plan file. After saving, update plans/index.md with a one-line entry for date, path, status, kind, and risk.`, { deliverAs: "followUp" }); }
  function requestTasks() { pi.sendUserMessage("Turn the latest plan into todo tasks using the todo tool. Create one top-level task for the overall outcome when useful, then create ordered execution tasks with clear subjects, descriptions, activeForm values, and blockedBy dependencies that match the plan order. Keep planning-created execution tasks pending unless execution starts.", { deliverAs: "followUp" }); }
  function requestPreflight() { pi.sendUserMessage("Run a read-only preflight review of the latest plan. Check approval state, open questions, blockers, task breakdown/dependencies, validation commands, rollback path, affected files, branch/worktree assumptions, and whether execute mode is safe. Do not edit files.", { deliverAs: "followUp" }); }
  function requestDiff() { pi.sendUserMessage("Compare the latest plan against the previous saved/approved plan if available. Summarize changed scope, risks, tasks, validation, rollout, and rollback. If no previous plan is available, say so and summarize the current plan baseline. Do not edit files.", { deliverAs: "followUp" }); }
  function requestPlanReview() { pi.sendUserMessage("Review the latest plan critically. Look for missing risks, weak tests, unsafe migrations, vague acceptance criteria, service-boundary issues, unclear task dependencies, rollout/rollback gaps, and Mermaid clarity issues. Produce findings with severity and suggested plan edits. Do not edit files.", { deliverAs: "followUp" }); }
  function requestPrDraft() { pi.sendUserMessage("Draft a PR description from the latest approved plan. Include summary, linked task, implementation notes, test table, risk/rollback, screenshots/manual QA placeholders, deploy notes, and reviewer focus. Do not create or edit files unless in docs mode and explicitly asked.", { deliverAs: "followUp" }); }
  function requestDeployChecklist() { pi.sendUserMessage("Convert the latest plan into a deployment readiness and post-deploy verification checklist. Include prerequisites, feature flags/rollout, migrations, monitoring, rollback, smoke tests, owner notifications, and go/no-go criteria. Do not edit files.", { deliverAs: "followUp" }); }
  function requestTaskGraph() { pi.sendUserMessage("Create a Mermaid flowchart of the latest plan's todo/task dependencies. Use simple flowchart TD syntax and include task IDs if available. Do not edit files unless asked to save to plans/**/*.md.", { deliverAs: "followUp" }); }
  function requestEvidenceChecklist() { pi.sendUserMessage("Create an evidence checklist for executing the latest plan. For each execution task, list required proof before completion: changed files, tests/commands, validation output, manual verification, residual risks, and rollback notes. Do not edit files.", { deliverAs: "followUp" }); }
  function requestIndex() { pi.sendUserMessage("Inspect plans/*.md and update plans/index.md with a concise table of saved plans: date, status, kind, risk, task, path, and title. Use write only for plans/index.md.", { deliverAs: "followUp" }); }
  function approve(ctx: ExtensionContext) { const text = latestAssistantText(ctx); if (!text) return ctx.ui.notify("No assistant plan found to approve.", "warning"); const issues = validatePlanText(text); if (issues.length) { planState = "revise"; updateStatus(ctx); persist(); return ctx.ui.notify(`Plan needs revision before approval:\n${issues.map((i)=>`- ${i}`).join("\n")}`, "warning"); } planState = "approved"; updateStatus(ctx); persist(); ctx.ui.notify("Plan approved. Use /plan execute.", "info"); }
  function execute(ctx: ExtensionContext, force = false) { if (!force && planState !== "approved") return ctx.ui.notify("Approve the plan first with /plan approve. Use /plan execute force to bypass.", "warning"); planState = "executing"; setMode("execute", ctx); pi.sendUserMessage("Execute the approved plan. First, use the todo tool to mark the first executable task in_progress (or create tasks if none exist). Work step by step, keep exactly one task in_progress, update tasks as steps complete, run focused validation, and stop/ask if the plan no longer matches reality.", { deliverAs: "followUp" }); }

  function commandSources(): string {
    const commands = pi.getCommands().filter((command) => ["mode", "ask", "plan"].includes(command.name.split(":")[0]));
    return commands.map((command) => `/${command.name} from ${command.sourceInfo.path}`).join("\n") || "none";
  }

  function doctor(ctx: ExtensionContext) {
    const active = pi.getActiveTools().join(", ");
    const legacyDirs = [
      "/home/daviaaze/.pi/agent-work/extensions/ask-mode",
      "/home/daviaaze/.pi/agent-work/extensions/plan-mode",
      "/home/daviaaze/.pi/agent/extensions/ask-mode",
      "/home/daviaaze/.pi/agent/extensions/plan-mode",
    ].filter((candidate) => existsSync(candidate));
    ctx.ui.notify(`Mode manager doctor:
- mode: ${mode}${mode === "plan" ? ` (${planState}/${planKind})` : ""}
- active tools: ${active}
- docs roots: ${config.docsRoots.join(", ")}
- docs extensions: ${config.docsExtensions.join(", ")}
- locked: ${locked}
- panel: ${panelDensity}
- thinking: ${mode === "off" ? "default" : config.modeThinkingLevels[mode] ?? "default"}
- config sources: ${configSources.join(", ")}
- legacy active dirs: ${legacyDirs.length ? legacyDirs.join(", ") : "none"}
- mode commands:
${commandSources()}`, "info");
  }

  function showHistory(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getEntries()
      .filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "mode-manager-audit")
      .slice(-12) as Array<{ data?: { at?: string; from?: Mode; to?: Mode; reason?: string; planState?: PlanState; planKind?: PlanKind; locked?: boolean } }>;
    const lines = entries.map((entry) => {
      const d = entry.data ?? {};
      return `- ${d.at ?? "unknown"}: ${d.from ?? "?"} → ${d.to ?? "?"} (${d.reason ?? "switch"}; ${d.planState ?? "draft"}/${d.planKind ?? "general"}; locked=${d.locked ?? false})`;
    });
    ctx.ui.notify(`Mode history:
${lines.length ? lines.join("\n") : "No mode transitions recorded."}`, "info");
  }

  function showTools(ctx: ExtensionContext) {
    const p = profile();
    ctx.ui.notify(`Mode tools:
- mode: ${mode}
- active: ${pi.getActiveTools().join(", ")}
- profile tools: ${p?.tools?.join(", ") ?? "previous/default"}
- blocked: ${p?.blockedTools?.join(", ") ?? "none"}
- bash policy: ${p?.bashPolicy ?? "none"}
- write policy: ${p?.writePolicy ?? "none"}`, "info");
  }

  function showConfig(ctx: ExtensionContext) {
    ctx.ui.notify(`Mode manager config sources:
${configSources.map((s) => `- ${s}`).join("\n")}

${JSON.stringify(config, null, 2)}`, "info");
  }

  function resetMode(ctx: ExtensionContext) {
    const from = mode;
    mode = "off";
    planState = "draft";
    planKind = "general";
    locked = false;
    panelDensity = "full";
    lastPromptedHash = undefined;
    if (toolsBeforeMode) pi.setActiveTools(toolsBeforeMode);
    toolsBeforeMode = undefined;
    if (previousThinkingLevel) pi.setThinkingLevel(previousThinkingLevel as any);
    previousThinkingLevel = undefined;
    audit(from, "off", "reset");
    updateStatus(ctx);
    persist();
    ctx.ui.notify("Mode manager reset. Mode off, lock cleared, tools/thinking restored.", "info");
  }


  function savePreset(ctx: ExtensionContext, rawName: string) {
    const name = normalizePresetName(rawName);
    if (!name) return ctx.ui.notify("Usage: /mode preset save <name>", "warning");
    const presets = readPresets();
    presets[name] = { mode, planKind, planState, panelDensity, thinkingLevel: pi.getThinkingLevel(), updatedAt: new Date().toISOString() };
    writePresets(presets);
    ctx.ui.notify(`Saved mode preset '${name}'.`, "info");
  }

  function listPresets(ctx: ExtensionContext) {
    const presets = readPresets();
    const lines = Object.entries(presets).sort(([a], [b]) => a.localeCompare(b)).map(([name, preset]) => `- ${name}: ${preset.mode}${preset.mode === "plan" ? ` (${preset.planState ?? "draft"}/${preset.planKind ?? "general"})` : ""} · panel=${preset.panelDensity ?? "full"} · thinking=${preset.thinkingLevel ?? "default"}`);
    ctx.ui.notify(`Mode presets (${presetsPath()}):\n${lines.length ? lines.join("\n") : "No presets saved."}`, "info");
  }

  function deletePreset(ctx: ExtensionContext, rawName: string) {
    const name = normalizePresetName(rawName);
    const presets = readPresets();
    if (!name || !presets[name]) return ctx.ui.notify("Preset not found. Usage: /mode preset delete <name>", "warning");
    delete presets[name];
    writePresets(presets);
    ctx.ui.notify(`Deleted mode preset '${name}'.`, "info");
  }

  function applyPreset(ctx: ExtensionContext, rawName: string) {
    const name = normalizePresetName(rawName);
    const preset = readPresets()[name];
    if (!preset) return ctx.ui.notify("Preset not found. Use /mode presets to list saved presets.", "warning");
    panelDensity = preset.panelDensity ?? panelDensity;
    planKind = preset.planKind ?? planKind;
    planState = preset.planState ?? planState;
    setMode(preset.mode, ctx);
    if (preset.thinkingLevel) pi.setThinkingLevel(preset.thinkingLevel as any);
    persist();
    updateStatus(ctx);
    ctx.ui.notify(`Applied mode preset '${name}'.`, "info");
  }

  function handlePreset(args: string[], ctx: ExtensionContext) {
    const sub = args[0]?.toLowerCase() ?? "list";
    if (sub === "list" || sub === "ls") return listPresets(ctx);
    if (sub === "save") return savePreset(ctx, args.slice(1).join(" "));
    if (sub === "delete" || sub === "rm") return deletePreset(ctx, args.slice(1).join(" "));
    return applyPreset(ctx, args.join(" "));
  }


  pi.registerCommand("mode", { description: "Switch mode: ask|plan|review|debug|docs|deploy|execute|off|status|doctor", getArgumentCompletions: completeModeArgs, handler: async (args, ctx) => { const arg = args.trim().toLowerCase() || "status"; if (arg === "status") return ctx.ui.notify(`Mode: ${mode}${mode === "plan" ? ` (${planState}/${planKind})` : ""}`, "info"); if (arg === "doctor") return doctor(ctx); if (arg === "history") return showHistory(ctx); if (arg === "tools") return showTools(ctx); if (arg === "config") return showConfig(ctx); if (arg === "presets") return listPresets(ctx); if (arg.startsWith("preset")) return handlePreset(args.trim().split(/\s+/).slice(1), ctx); if (arg === "reset") return resetMode(ctx); if (arg === "compact") { panelDensity = "compact"; persist(); updateStatus(ctx); return ctx.ui.notify("Mode panel set to compact.", "info"); } if (arg === "full") { panelDensity = "full"; persist(); updateStatus(ctx); return ctx.ui.notify("Mode panel set to full.", "info"); } if (arg === "lock") { locked = true; persist(); updateStatus(ctx); return ctx.ui.notify(`Mode locked to ${mode}.`, "info"); } if (arg === "unlock") { locked = false; persist(); updateStatus(ctx); return ctx.ui.notify("Mode unlocked.", "info"); } if (arg === "reload-config") { loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted()); config = loaded.config; configSources = loaded.sources; updateStatus(ctx); return ctx.ui.notify(`Mode manager config reloaded from ${configSources.join(", ")}.`, "info"); } if (["off","ask","plan","review","debug","docs","deploy","execute"].includes(arg)) { if (arg === "execute" && mode !== "off" && mode !== "plan" && config.confirmExecuteFromModes.includes(mode)) { const ok = !ctx.hasUI || await ctx.ui.confirm("Switch to execute mode?", `This restores normal implementation tools from ${mode} mode.`); if (!ok) return ctx.ui.notify("Execute mode cancelled.", "info"); } return setMode(arg as Mode, ctx); } ctx.ui.notify("Usage: /mode ask|plan|review|debug|docs|deploy|execute|off|status|doctor|history|tools|config|reset|compact|full|preset|presets|reload-config|lock|unlock", "info"); } });
  pi.registerCommand("ask", { description: "Ask mode alias: /ask on|off|status", getArgumentCompletions: (prefix) => completeFrom(["on", "off", "status", "toggle"], prefix, { on: "enable ask mode", off: "restore previous tools", status: "show ask state", toggle: "toggle ask mode" }), handler: async (args, ctx) => { const arg = args.trim().toLowerCase(); if (!arg || arg === "on" || arg === "toggle") return setMode(mode === "ask" && arg !== "on" ? "off" : "ask", ctx); if (arg === "off") return setMode("off", ctx); if (arg === "status") return ctx.ui.notify(mode === "ask" ? "Ask mode is ON." : "Ask mode is OFF.", "info"); ctx.ui.notify("Usage: /ask, /ask on, /ask off, /ask status", "info"); } });
  pi.registerCommand("plan", { description: "Plan alias: draft|approve|execute|revise|save|tasks|validate|bug|feature|refactor|e2e|migration", getArgumentCompletions: completePlanArgs, handler: async (rawArgs, ctx) => { const args = rawArgs.trim(); const [cmd, ...rest] = args.split(/\s+/); const n = (cmd?.toLowerCase() || "toggle") as string; if (!args || n === "on" || n === "draft" || n === "toggle") { planState = "draft"; return setMode(mode === "plan" && n === "toggle" ? "off" : "plan", ctx); } if (n === "off") return setMode("off", ctx); if (n === "status") return ctx.ui.notify(`Plan: ${mode === "plan" ? "on" : "off"} ${planState}/${planKind}`, "info"); if (PLAN_KINDS.has(n as PlanKind)) { planKind = n as PlanKind; planState = "draft"; setMode("plan", ctx); return pi.sendUserMessage(commandForKind(planKind), { deliverAs: "followUp" }); } if (n === "revise") { planState = "revise"; setMode("plan", ctx); return pi.sendUserMessage("Revise the latest plan. Address validation gaps, open questions, task dependencies, risk score, test strategy, and Mermaid diagram clarity. Do not edit implementation files.", { deliverAs: "followUp" }); } if (n === "validate") { const text = latestAssistantText(ctx); if (!text) return ctx.ui.notify("No assistant plan found to validate.", "warning"); const issues = validatePlanText(text); return ctx.ui.notify(issues.length ? `Plan validation issues:\n${issues.map((i)=>`- ${i}`).join("\n")}` : "Plan validation passed.", issues.length ? "warning" : "info"); } if (n === "approve") return approve(ctx); if (n === "execute") return execute(ctx, rest[0]?.toLowerCase() === "force"); if (n === "save") { if (!latestAssistantText(ctx)) return ctx.ui.notify("No assistant plan found to save yet.", "warning"); const name = rest.join("-").toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"") || `${planKind}-plan`; return requestSave(name); } if (n === "tasks" || n === "todos") return requestTasks(); if (n === "preflight") return requestPreflight(); if (n === "diff") return requestDiff(); if (n === "review") return requestPlanReview(); if (n === "pr") return requestPrDraft(); if (n === "deploy") return requestDeployChecklist(); if (n === "graph") return requestTaskGraph(); if (n === "evidence") return requestEvidenceChecklist(); if (n === "index") return requestIndex(); if (n === "memory") return pi.sendUserMessage("If a task_memory tool is available, save a concise, secret-safe note with the plan path if known, current state, next action, validation strategy, and blockers. Do not store secrets or .env values.", { deliverAs: "followUp" }); ctx.ui.notify("Usage: /plan draft|approve|execute|revise|save|tasks|validate|preflight|diff|review|pr|deploy|graph|evidence|index|memory|bug|feature|refactor|e2e|migration", "info"); } });
  pi.registerShortcut(Key.ctrlAlt("m"), { description: "Mode status", handler: async (ctx) => ctx.ui.notify(`Mode: ${mode}`, "info") });
  pi.registerShortcut(Key.ctrlAlt("a"), { description: "Toggle ask mode", handler: async (ctx) => setMode(mode === "ask" ? "off" : "ask", ctx) });
  pi.registerShortcut(Key.ctrlAlt("p"), { description: "Toggle plan mode", handler: async (ctx) => setMode(mode === "plan" ? "off" : "plan", ctx) });

  pi.on("tool_call", async (event, ctx) => { const p = profile(); if (!p || mode === "execute") return undefined; if (p.blockedTools?.includes(event.toolName)) return { block: true, reason: `${mode} mode: ${event.toolName} is blocked.` }; if (event.toolName === "write" || event.toolName === "edit") { const target = event.input.path as string | undefined; if (p.writePolicy === "none") return { block: true, reason: `${mode} mode: writes/edits are blocked.` }; if (!target) return { block: true, reason: `${mode} mode: missing target path.` }; if (p.writePolicy === "plans" && !isUnder(ctx.cwd, target, ["plans"], [".md"])) return { block: true, reason: "plan mode: writes are only allowed to plans/**/*.md" }; if (p.writePolicy === "docs" && !isUnder(ctx.cwd, target, config.docsRoots, config.docsExtensions)) return { block: true, reason: `docs mode: writes are only allowed to documentation files (${config.docsExtensions.join(", ")}).` }; } if (event.toolName === "bash") { const command = event.input.command as string | undefined; if (!command) return { block: true, reason: `${mode} mode: empty bash command blocked.` }; if (p.bashPolicy === "safe" && !isSafeCommand(command) && !config.extraSafeBashPatterns.some((pattern) => new RegExp(pattern).test(command))) return { block: true, reason: `${mode} mode: bash command blocked; only read-only inspection commands are allowed.\nCommand: ${command}` }; if (p.bashPolicy === "diagnostic" && !isDiagnosticCommand(command) && !config.extraSafeBashPatterns.some((pattern) => new RegExp(pattern).test(command))) return { block: true, reason: `${mode} mode: bash command blocked; only inspection/test diagnostics are allowed.\nCommand: ${command}` }; } return undefined; });

  pi.on("context", async (event) => { return { messages: event.messages.filter((m) => { const c = m as AgentMessage & { customType?: string }; return !["ask-mode-context", "plan-mode-context", "mode-manager-context"].includes(c.customType ?? ""); }) }; });
  pi.on("before_agent_start", async () => { const p = profile(); if (!p) return undefined; return { message: { customType: "mode-manager-context", display: false, content: `[MODE ACTIVE]\nMode: ${mode}\nPlan state: ${planState}\nPlan kind: ${planKind}\n\nTool/write policy:\n- Bash policy: ${p.bashPolicy}\n- Write policy: ${p.writePolicy}\n- Blocked tools: ${(p.blockedTools ?? []).join(", ") || "none"}\n- Recommended skills: ${p.skills.join(", ")}\n\nBehavior:\n${modeContext(mode, planKind, planState)}` } }; });
  pi.on("agent_end", async (_event, ctx) => { if (mode !== "plan" || !ctx.hasUI || planState === "executing") return; const text = latestAssistantText(ctx); if (!text || !/^#\s+Plan:/im.test(text)) return; const h = hashText(text); if (h === lastPromptedHash) return; lastPromptedHash = h; persist(); const choice = await ctx.ui.select("Plan produced. Next action?", ["Stay in plan mode", "Validate plan", "Save plan", "Create todo tasks", "Approve plan"]); if (choice === "Validate plan") { const issues = validatePlanText(text); ctx.ui.notify(issues.length ? `Plan validation issues:\n${issues.map((i)=>`- ${i}`).join("\n")}` : "Plan validation passed.", issues.length ? "warning" : "info"); } else if (choice === "Save plan") requestSave(`${planKind}-plan`); else if (choice === "Create todo tasks") requestTasks(); else if (choice === "Approve plan") approve(ctx); });
  pi.on("session_start", async (_event, ctx) => { loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted()); config = loaded.config; configSources = loaded.sources; const flagMode = pi.getFlag("start-mode") as string | undefined; if (flagMode && ["ask","plan","review","debug","docs","deploy","execute"].includes(flagMode)) mode = flagMode as Mode; const latest = ctx.sessionManager.getEntries().filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "mode-manager").pop() as { data?: ModeState } | undefined; if (latest?.data) { mode = latest.data.mode ?? mode; planState = latest.data.planState ?? planState; planKind = latest.data.planKind ?? planKind; toolsBeforeMode = latest.data.toolsBeforeMode; lastPromptedHash = latest.data.lastPromptedHash; locked = latest.data.locked ?? locked; previousThinkingLevel = latest.data.previousThinkingLevel; panelDensity = latest.data.panelDensity ?? panelDensity; } if (mode !== "off") { toolsBeforeMode = toolsBeforeMode ?? pi.getActiveTools(); pi.setActiveTools(activeToolsFor(PROFILES[mode])); } updateStatus(ctx); });
}

function modeContext(mode: Mode, kind: PlanKind, state: PlanState): string {
  if (mode === "ask") return "Answer questions only. Do not start tasks, implementation plans, or execution workflows. Do not edit/write files or create todos/task memory. Answer directly and cite inspected files.";
  if (mode === "plan") return `Create structured markdown plans only. Do not edit implementation files. Writes only to plans/**/*.md. Include YAML frontmatter, Goal, Context / findings, Assumptions, Proposed approach, Files likely affected, Step-by-step plan, Execution tasks, Acceptance criteria, Testing / validation strategy, Risk score, Risks and mitigations, Open questions, Rollback plan, Task memory notes, and simple Mermaid diagrams when useful. Current plan state: ${state}; kind: ${kind}. ${commandForKind(kind)}`;
  if (mode === "review") return "Review only. Produce findings with severity, file path, rationale, and suggested fix. Do not modify files or create tasks by default. Prefer security, migration, test, and service-boundary risks.";
  if (mode === "debug") return "Hypothesis-driven debugging. Use hypothesis → evidence → next probe → conclusion. You may run safe diagnostics/tests but must not edit files unless switched to execute mode.";
  if (mode === "docs") return "Documentation mode. Only write documentation files (.md/.mdx/.rst). Do not change implementation code. Prefer clear structure, examples, and links.";
  if (mode === "deploy") return "Deploy readiness mode. Produce checklists, risk/rollback/post-deploy verification. Read-only checks only; no code edits.";
  if (mode === "execute") return "Implementation mode. Execute approved work step by step, keep todos updated, run focused validation, and stop if reality diverges from the plan.";
  return "No active mode.";
}
