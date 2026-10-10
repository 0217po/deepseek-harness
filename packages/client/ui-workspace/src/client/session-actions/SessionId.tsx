/** Session ID inspection through the row menu and a frame-wide read-only dialog. */
import clsx from 'clsx'
import { Button, IconInfoOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionIdDialogProps, SessionIdInjected, SessionMenuItemProps } from '../contract/slots.ts'
import css from '../rows/WorkspaceBrowser.module.css'

/**
 * Open the ID dialog without retaining or loading the Session.
 * @param props - Row identity, menu dismissal, dialog request, and locale.
 * @returns The final built-in menu item.
 */
export function SessionIdMenuItem({ sessionId, useMenuOpenState, requestSessionId, t }: SessionMenuItemProps<SessionIdInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton icon={<IconInfoOutlineRegular />} onSelect={() => {
      setMenuOpen(false)
      requestSessionId(sessionId)
    }}>
      {t('menu.sessionId')}
    </MenuItemButton>
  )
}

/**
 * Show the complete ID with manual selection and clipboard copying.
 * @param props - Pending ID, dismissal, clipboard action, and locale.
 * @returns The dialog, or nothing while no ID is requested.
 */
export function SessionIdDialog({ useSessionIdRequest, settleSessionId, copySessionId, t }: SessionIdDialogProps) {
  const sessionId = useSessionIdRequest(value => value)
  if (sessionId === null) return null
  return (
    <Modal
      open
      onClose={settleSessionId}
      closeLabel={t('close')}
      title={t('sessionId.title')}
      className={clsx(css.sessionIdDialog)}
      footer={<Button variant="outline" onClick={settleSessionId}>{t('close')}</Button>}
    >
      <div className={css.sessionIdRow}>
        <code className={css.sessionIdValue}>{sessionId}</code>
        <Button variant="outline" data-modal-autofocus onClick={() => { void copySessionId(sessionId) }}>{t('copy')}</Button>
      </div>
    </Modal>
  )
}
