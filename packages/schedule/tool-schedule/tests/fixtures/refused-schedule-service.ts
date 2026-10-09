/** Headless snapshot service placeholder: delegated calls must stop at the tool guard. */
import type { Context } from '@deepseek-ai/cordis'
import type ScheduleService from '@deepseek-ai/dsh-schedule'

/** Plugin identity for the refusal-only snapshot fixture. */
export const name = 'refused-schedule-service'

/**
 * Supply the service presence needed to register the real reminder tools.
 * No Host operation is implemented: reaching one yields a different recorded result.
 * @param ctx - Isolated snapshot context.
 */
export function apply(ctx: Context): void {
  ctx.provide('schedule', {} as ScheduleService)
}
