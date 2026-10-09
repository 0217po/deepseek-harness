/** Session ID inspection through the row menu and a frame-wide read-only dialog. */
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
      footer={(
        <>
          <Button variant="outline" onClick={settleSessionId}>{t('close')}</Button>
          <Button variant="primary" onClick={() => { void copySessionId(sessionId) }}>{t('copy')}</Button>
        </>
      )}
    >
      <textarea
        key={sessionId}
        className={css.sessionIdValue}
        aria-label={t('sessionId.title')}
        readOnly
        rows={3}
        value={sessionId}
        data-modal-autofocus
        onFocus={(event) => { event.currentTarget.select() }}
      />
    </Modal>
  )
}
