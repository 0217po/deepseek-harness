/** Command description and its settled exit status in the conversation row. */
import { Tag, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TerminalSummary.module.css'

/**
 * Keep the command description neutral and its exit status visible at narrow widths.
 * @param props - tool-authored description and localized exit label.
 * @returns a single-line description with space reserved for its status capsule.
 */
export function TerminalSummary({ description, exitLabel }: { description: string; exitLabel: string }) {
  return (
    <span className={css.summary} data-terminal-summary>
      <span className={css.description}><TextShimmer>{description}</TextShimmer></span>
      <Tag tone="neutral" className={css.badge}>
        <span className={css.dot} aria-hidden />
        {exitLabel}
      </Tag>
    </span>
  )
}
