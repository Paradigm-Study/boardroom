import { z } from 'zod'

// One captured Claude Code session as observed from ~/.claude/sessions/<pid>.json.
// Registry-level facts + best-effort pointers only — NOT processed content.
// pid is REQUIRED: this table only ever holds registry-observed rows (see the
// plan's Design note); the hook/waker path uses a separate table entirely.
export const CapturedSession = z.object({
  sessionId: z.string().min(1),
  machineId: z.string().min(1),
  pid: z.number().int(),
  procStart: z.string().optional(),
  cwd: z.string().min(1),
  project: z.string().min(1),
  claudeVersion: z.string().optional(),
  entrypoint: z.string().optional(),
  kind: z.string().optional(),
  startedAt: z.string().optional(),
  status: z.enum(['alive', 'ended']),
  capturedAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  transcriptPath: z.string().optional(),
  tasksDir: z.string().optional(),
})

export type CapturedSession = z.infer<typeof CapturedSession>
