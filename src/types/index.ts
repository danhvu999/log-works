export const ERROR_CODES = [
  "slack-auth",
  "slack-rate-limit",
  "netdok-http",
  "netdok-task-missing",
  "netdok-project-unmapped",
  "storage-corrupt",
  "config-missing",
  "export-format",
  "export-write",
  "smart-parse-invalid",
  "setup-invalid",
] as const;

export const EXPORT_FORMATS = ["csv", "json", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ErrorCode = (typeof ERROR_CODES)[number];

export type WorkLogStatus = "pending" | "sent" | "failed";

export const WORK_LOG_SOURCES = ["rule", "smart"] as const;
export type WorkLogSource = (typeof WORK_LOG_SOURCES)[number];

export interface RawSlackMessage {
  ts: string;
  channel: string;
  userId: string;
  text: string;
  raw: unknown;
  fetchedAt: string;
}

export interface WorkLogEntry {
  id: string;
  sourceTs: string;
  date: string;
  project: string;
  text: string;
  hours: number | null;
  status: WorkLogStatus;
  source?: WorkLogSource;
  lastError?: string;
  postedAt?: string;
  postedTaskId?: string;
  postedWorklogId?: string;
}

export interface ParsedWorkLog {
  index: number;
  project: string;
  text: string;
  hours: number | null;
}

export interface NetdokWeekTask {
  id: string;
  project: string;
  projectId: string;
  weekStart: string;
  weekEnd: string;
  taskId: string;
  taskKey?: string;
  taskName: string;
  createdAt: string;
}

export interface Database {
  rawMessages: RawSlackMessage[];
  workLogs: WorkLogEntry[];
  netdokWeekTasks: NetdokWeekTask[];
  meta: {
    lastFetchAt?: string;
    lastFetchCursor?: Record<string, string>;
  };
}

export interface NetdokProjectMapping {
  projectId: string;
  sprintId?: string;
  statusId?: string;
  pinnedTaskId?: string;
  assigneeIds?: string[];
}

export interface LogWorksConfig {
  slack?: {
    userToken?: string;
    userId?: string;
    channels?: string[];
  };
  netdok?: {
    baseUrl?: string;
    authBaseUrl?: string;
    appBaseUrl?: string;
    apiKey?: string; // sent as `x-api-key` header
    workspaceId?: string;
    profileId?: string;
    reporterId?: string;
    projects?: Record<string, NetdokProjectMapping>;
    authHeader?: string;
  };
  storage?: {
    path?: string;
  };
}

export interface SlackFixtureMessage {
  type: "message";
  channel: string;
  user: string;
  ts: string;
  text: string;
}

export interface CommandOptionSpec {
  name: string;
  takesValue: boolean;
}

export interface CommandSpec {
  name: string;
  summary: string;
  options: CommandOptionSpec[];
}

export interface NetdokHint {
  configured: boolean;
  unmappedProjects: string[];
  suggestion?: string;
}

export interface SmartParseHint {
  emptyCount: number;
  partialCount: number;
  totalNeedingReview: number;
  suggestion: string;
}

export interface FetchSummary {
  fetched: number;
  inserted: number;
  skipped: number;
  droppedNonDebrief: number;
  channels: string[];
  from?: string;
  to?: string;
  storagePath: string;
  netdokHint?: NetdokHint;
}

export interface DeriveSummary {
  processed: number;
  inserted: number;
  skipped: number;
  storagePath: string;
  from?: string;
  to?: string;
  netdokHint?: NetdokHint;
  smartParseHint?: SmartParseHint;
}

export interface SummaryProjectStat {
  project: string;
  entries: number;
  hours: number;
  dateMin: string;
  dateMax: string;
}

export interface SummaryTotals {
  rawMessages: number;
  workLogs: number;
  totalHours: number;
  uniqueProjects: number;
  dateMin: string | null;
  dateMax: string | null;
}

export interface SummaryResult {
  totals: SummaryTotals;
  projects: SummaryProjectStat[];
  storagePath: string;
  from?: string;
  to?: string;
}

export interface ExportSummary {
  format: ExportFormat;
  rows: number;
  path: string | null;
  from?: string;
  to?: string;
  status?: WorkLogStatus;
  storagePath: string;
}

export interface StorageClearNetdokSummary {
  clearedWeekTasks: number;
  resetEntries: number;
  applied: boolean;
  storagePath: string;
  from?: string;
  to?: string;
}

export interface StorageResetSummary {
  removedRawMessages: number;
  removedWorkLogs: number;
  removedNetdokWeekTasks: number;
  clearedMeta: boolean;
  applied: boolean;
  storagePath: string;
}

export type NetdokTaskSyncStatus =
  | "existing-local"
  | "existing-remote"
  | "would-create"
  | "created"
  | "pinned";

export interface NetdokPinnedTaskEntry {
  project: string;
  projectId: string;
  pinnedTaskId: string;
  entries: number;
  taskUrl?: string;
}

export interface NetdokTaskSyncEntry {
  project: string;
  projectId: string;
  weekStart: string;
  weekEnd: string;
  expectedTaskName: string;
  status: NetdokTaskSyncStatus;
  taskId?: string;
  taskKey?: string;
  taskUrl?: string;
}

export interface NetdokTaskSyncResult {
  weeks: NetdokTaskSyncEntry[];
  unmapped: Array<{ project: string; entries: number }>;
  pinned: NetdokPinnedTaskEntry[];
  applied: boolean;
  storagePath: string;
  from?: string;
  to?: string;
}

export type NetdokWorklogSyncStatus =
  | "would-post"
  | "posted"
  | "skipped-already-sent"
  | "skipped-no-task"
  | "skipped-no-hours"
  | "skipped-no-project"
  | "skipped-duplicate-remote"
  | "failed";

export interface NetdokWorklogSyncEntry {
  entryId: string;
  date: string;
  project: string;
  text: string;
  hours: number | null;
  taskId?: string;
  projectId?: string;
  taskUrl?: string;
  status: NetdokWorklogSyncStatus;
  worklogId?: string;
  reason?: string;
}

export interface NetdokWorklogSyncResult {
  entries: NetdokWorklogSyncEntry[];
  applied: boolean;
  storagePath: string;
  from?: string;
  to?: string;
}

export type ParseEvaluationStatus = "ok" | "empty" | "partial";

export interface ParseEvaluationFlags {
  missingProject: boolean;
  missingHours: boolean;
  hasDebriefMarker: boolean;
}

export interface ParseEvaluation {
  entries: ParsedWorkLog[];
  status: ParseEvaluationStatus;
  flags: ParseEvaluationFlags;
}

export interface UnparsedRawMessage {
  ts: string;
  channel: string;
  date: string;
  text: string;
  status: ParseEvaluationStatus;
  flags: ParseEvaluationFlags;
  ruleEntries: number;
}

export interface UnparsedListResult {
  messages: UnparsedRawMessage[];
  storagePath: string;
  from?: string;
  to?: string;
}

export interface SmartIngestInputEntry {
  sourceTs: string;
  index?: number;
  date?: string;
  project: string;
  text: string;
  hours?: number | null;
}

export type SmartIngestStatus = "inserted" | "skipped-duplicate";

export interface SmartIngestEntryResult {
  id: string;
  sourceTs: string;
  index: number;
  date: string;
  project: string;
  status: SmartIngestStatus;
}

export interface SmartIngestSummary {
  entries: SmartIngestEntryResult[];
  inserted: number;
  skipped: number;
  storagePath: string;
}

export interface NetdokWorkspaceSummary {
  id: string;
  name: string;
  apiUrl?: string;
}

export interface NetdokProjectSummary {
  id: string;
  name: string;
  key: string;
  workspaceId: string;
}

export interface NetdokStatusSummary {
  id: string;
  name: string;
  type: string;
}

export interface NetdokProjectDetails {
  id: string;
  name: string;
  key: string;
  statuses: NetdokStatusSummary[];
  sprintIds: string[];
  suggestedStatusId?: string;
  suggestedSprintId?: string;
}

export interface NetdokMeSummary {
  profileId: string;
  displayName: string;
  workspaceId: string;
  tz: string;
}

export interface NetdokProjectTaskSummary {
  id: string;
  key: string;
  name: string;
  sprintId: string | null;
  statusId: string;
}

export interface NetdokProjectTasksSummary {
  projectId: string;
  tasks: NetdokProjectTaskSummary[];
}

export interface SlackSetupSummary {
  applied: boolean;
  config: LogWorksConfig;
  configPath: string;
}

export interface NetdokDiscoverResult {
  workspaces: NetdokWorkspaceSummary[];
  me: NetdokMeSummary | null;
  projects: NetdokProjectSummary[];
  projectDetails: NetdokProjectDetails[];
  projectTasks?: NetdokProjectTasksSummary[];
  localProjectsSeen: string[];
  workspaceId?: string;
}

export interface NetdokApplyInput {
  baseUrl?: string;
  authBaseUrl?: string;
  appBaseUrl?: string;
  apiKey: string;
  workspaceId: string;
  profileId: string;
  reporterId?: string;
  projects: Record<string, NetdokProjectMapping>;
}

export interface NetdokApplySummary {
  applied: boolean;
  config: LogWorksConfig;
  configPath: string;
}

export interface SlackReadinessResult {
  ready: boolean;
  missing: string[];
  suggestion: string;
}

export interface NetdokReadinessResult {
  ready: boolean;
  missing: string[];
  knownLocalProjects: string[];
  mappedLocalProjects: string[];
  unmappedLocalProjects: string[];
  suggestion: string;
}

export type ConfigCheckNextStep =
  | "setup-slack"
  | "setup-netdok-discover"
  | "setup-netdok-apply"
  | "fetch-and-derive"
  | "ready";

export interface ConfigReadinessResult {
  slack: SlackReadinessResult;
  netdok: NetdokReadinessResult;
  nextStep: ConfigCheckNextStep;
  configPath: string;
}
