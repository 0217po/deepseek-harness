/** Confirmation shown when this page reconnects to a Host running another release. */
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientReleaseChange, WebBootRelease } from '@deepseek-ai/dsh-client-modules/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './HostReleasePrompt.module.css'

/** Registrant-private face: the page's pending release change and its two decisions. */
export type HostReleasePromptInjected = {
  /** Keep this page and apply the new release's plugin updates; later graphs of that release apply without asking. */
  acceptRelease: () => void
  /** Reload the page from the Host. */
  reloadPage: () => void
  hooks: {
    /** Pending Host release change owned by the page's module system. */
    releaseChange: HostObservable<ClientReleaseChange | undefined>
  }
}

/** Overlay props: the root overlay owner share, the `settings` copy, and the injected face. */
export type HostReleasePromptProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings'> & InjectFace<HostReleasePromptInjected>

/**
 * Name both ends of one release transition: their versions when those differ, otherwise their commits.
 * @param from - release the transition starts at.
 * @param to - release the transition ends at.
 * @param unknown - text for a release or field the Host did not publish.
 * @returns the start and end text.
 */
function transitionText(from: WebBootRelease | undefined, to: WebBootRelease | undefined, unknown: string): [string, string] {
  const field = from?.version !== to?.version ? 'version' : 'commit'
  return [from?.[field] ?? unknown, to?.[field] ?? unknown]
}

/**
 * One labelled transition line. A completed transition fades its start; a pending one fades its end.
 * @param props - row label, both ends, and completion.
 * @returns the row's cells for the shared transition grid.
 */
function Transition({ label, from, to, done }: { label: string; from: string; to: string; done: boolean }) {
  return (
    <>
      <span className={css.label}>{label}</span>
      <span className={clsx(css.release, done ? css.faded : css.solid)}>{from}</span>
      <span aria-hidden="true" className={clsx(css.line, done ? css.done : css.pending)} />
      <span className={clsx(css.release, done ? css.solid : css.faded)}>{to}</span>
    </>
  )
}

/**
 * Ask whether to reload after the Host changed releases; closing the dialog keeps the page.
 * The service line shows the completed switch from the last applied release; the page line shows the
 * pending switch from the release this page booted from.
 * @param props - the pending change, both decisions, and localized copy.
 * @returns the dialog while a change is pending; otherwise nothing.
 */
export function HostReleasePrompt({ useReleaseChange, acceptRelease, reloadPage, t }: HostReleasePromptProps) {
  const change = useReleaseChange(value => value)
  if (change === undefined) return null
  const unknown = t('hostRelease.unknown')
  const [serviceFrom, serviceTo] = transitionText(change.current, change.next, unknown)
  const [pageFrom, pageTo] = transitionText(change.page, change.next, unknown)
  return (
    <Modal
      open
      title={t('hostRelease.title')}
      description={t('hostRelease.description')}
      closeLabel={t('hostRelease.later')}
      onClose={acceptRelease}
      className={clsx(css.dialog)}
      footer={(
        <>
          <Button variant="outline" onClick={acceptRelease}>{t('hostRelease.later')}</Button>
          <Button variant="primary" data-modal-autofocus onClick={reloadPage}>{t('hostRelease.reload')}</Button>
        </>
      )}
    >
      <div className={css.transitions}>
        <Transition label={t('hostRelease.service')} from={serviceFrom} to={serviceTo} done />
        <Transition label={t('hostRelease.page')} from={pageFrom} to={pageTo} done={false} />
      </div>
    </Modal>
  )
}
