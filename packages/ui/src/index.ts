// @sturdle/ui — presentational design system + dashboard components.
//
// No data fetching, no router, no React Query: every component takes its data via props.
// Consumers render links with a plain `href` (there is no `Link` re-export). Import the
// stylesheet once from the app root: `@sturdle/ui/styles/tokens.css`.

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------
export { Chip } from "./components/Chip.js";
export type { ChipProps } from "./components/Chip.js";

export { Panel, Surface } from "./components/Panel.js";
export type { PanelProps, SurfaceProps } from "./components/Panel.js";

export { Figure } from "./components/Figure.js";
export type { FigureProps } from "./components/Figure.js";

export { LiveText } from "./components/LiveText.js";
export type { LiveTextProps } from "./components/LiveText.js";

export { StatusDot } from "./components/StatusDot.js";
export type { DotStatus, StatusDotProps } from "./components/StatusDot.js";

export { StatusBadge } from "./components/StatusBadge.js";
export type { BadgeStatus, StatusBadgeProps } from "./components/StatusBadge.js";

export { WorkerMeter } from "./components/WorkerMeter.js";
export type { WorkerMeterProps } from "./components/WorkerMeter.js";

export { ErrorNotice } from "./components/ErrorNotice.js";
export type { ErrorNoticeProps } from "./components/ErrorNotice.js";

export { SturdleMark } from "./components/SturdleMark.js";
export type { SturdleMarkProps } from "./components/SturdleMark.js";

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------
export { JobDetailTimeline } from "./components/JobDetailTimeline.js";
export type { JobDetailTimelineProps } from "./components/JobDetailTimeline.js";

export { JobSteps } from "./components/JobSteps.js";
export type { JobStepsProps } from "./components/JobSteps.js";

export { JobLogs } from "./components/JobLogs.js";
export type { JobLogsProps } from "./components/JobLogs.js";

export { JobFacts } from "./components/JobFacts.js";
export type { JobFactsProps } from "./components/JobFacts.js";

export { CopyTextButton, JobDetailJson, JsonWell } from "./components/JobDetailJson.js";
export type {
  CopyTextButtonProps,
  JobDetailJsonProps,
  JsonWellProps,
} from "./components/JobDetailJson.js";

export { FleetTable } from "./components/FleetTable.js";
export type { FleetTableProps } from "./components/FleetTable.js";

export { ActivityChart } from "./components/ActivityChart.js";
export type { ActivityChartProps } from "./components/ActivityChart.js";

// ---------------------------------------------------------------------------------------------
// Local shadcn primitives (cva + @radix-ui/react-slot), used by the dashboard components above
// and available to consumers that want the same button/table shapes elsewhere. Their `primary`/
// `secondary`/`accent`/`destructive`/`background`/`ring`/`muted` Tailwind classes are NOT defined
// by this package's tokens — the host app maps them (see the design tokens doc for the Sturdle
// tokens each one should resolve to).
// ---------------------------------------------------------------------------------------------
export { Button, buttonVariants } from "./components/ui/button.js";
export type { ButtonProps } from "./components/ui/button.js";

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.js";

// ---------------------------------------------------------------------------------------------
// lib
// ---------------------------------------------------------------------------------------------
export { cn } from "./lib/cn.js";

export {
  formatAbsolute,
  formatDuration,
  formatRelative,
  formatShortId,
  formatUptime,
} from "./lib/format.js";

export {
  failedAt,
  failedWithin,
  isTerminalJobStatus,
  normaliseJobStatus,
} from "./lib/job-status.js";
export type { JobStatusKind } from "./lib/job-status.js";

export {
  attemptFromStepKey,
  buildStepRows,
  formatResultSize,
  isLargeResult,
  LARGE_RESULT_CHARS,
  stepKey,
  stringifyJson,
} from "./lib/job-steps.js";
export type { StepRow } from "./lib/job-steps.js";

export { formatRate, toFleetRows } from "./lib/fleet.js";
export type { FleetRow } from "./lib/fleet.js";

export { jobPath, JOBS_PATH, taskCodeFromSplat, taskPath, TASKS_PATH } from "./lib/paths.js";

export {
  FLIPPERS,
  hexagonPath,
  hexagonVertices,
  MARK_COLORS,
  MARK_VIEWBOX,
  SCUTES,
  shellPath,
} from "./lib/sturdle-mark.js";
export type { Flipper, Scute } from "./lib/sturdle-mark.js";

export { buildTimelineModel } from "./lib/timeline-model.js";
export type {
  TimelineGapBreak,
  TimelineLane,
  TimelineLaneKind,
  TimelineModel,
  TimelineSegment,
  TimelineSegmentKind,
  TimelineTick,
} from "./lib/timeline-model.js";

// ---------------------------------------------------------------------------------------------
// View-model types
// ---------------------------------------------------------------------------------------------
export type {
  ActivitySeriesPoint,
  AttemptHistoryEntry,
  CronLastRun,
  JobAttempt,
  JobChildSummary,
  JobDetail,
  JobLog,
  JobParentSummary,
  JobStatus,
  JobStep,
  JobTypeSummary,
  TaskStats24h,
  TaskStats24hSeriesPoint,
} from "./types.js";
