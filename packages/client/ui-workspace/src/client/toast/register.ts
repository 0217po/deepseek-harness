/** Business-owned mappings into the keyed Workspace Toast slot. */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RowToastActions, WorkspaceViewStoreHandle } from '../contract/slots.ts'
import type { ToastDisplayInjected, ToastKind } from './contract.ts'
import { ArchiveToastEntry, ToastEntry, WorkspaceToast } from './Toast.tsx'

/**
 * Register notice presentations without changing the notification state or its lifetime.
 * @param ctx - Workspace plugin context.
 * @param viewStore - Existing viewing store, read only by archive notices.
 * @param actions - Existing archive and source-opening callbacks.
 */
export function registerToasts(
  ctx: Context,
  viewStore: WorkspaceViewStoreHandle,
  actions: Pick<RowToastActions, 'undoArchive' | 'showArchived' | 'openForkSource'>,
): void {
  ctx.slots.registerFactory({ name: 'workspace.toast.content', scope: 'root' }, WorkspaceToast)
  ctx.slots.inject('workspace.toast', function* () {
    const simple = {
      sessionIdCopied: ['toast.sessionIdCopied', 'success'],
      sessionIdCopyFailed: ['toast.sessionIdCopyFailed', 'warning'],
      pinFailed: ['toast.pinFailed', 'warning'],
      unpinFailed: ['toast.unpinFailed', 'warning'],
      archivedNotOpenable: ['toast.archivedNotOpenable', 'warning'],
      defaultWorkspaceFailed: ['defaultWorkspace.failed', 'warning'],
    } as const
    for (const key of Object.keys(simple) as (keyof typeof simple)[]) {
      const [text, tone] = simple[key]
      yield ctx.slots.register({
        name: 'workspace.toast', key, locale: 'workspace',
        inject: (): ToastDisplayInjected<keyof typeof simple> => ({ display: (_notice, t) => ({ text: t(text), tone }) }),
      }, ToastEntry<PropsRuntime<'workspace.toast', keyof typeof simple>>)
    }
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'shortcutForkFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'shortcutForkFailed'> => ({
        display: (notice, t) => ({
          text: t(notice.reason === 'unavailable' ? 'shortcut.noCompletedTurn' : 'shortcut.forkFailed'), tone: 'plain',
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'shortcutForkFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'createFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'createFailed'> => ({
        display: (notice, t) => ({ text: t('toast.createFailed', { message: notice.message }), tone: 'warning', holdMs: 6000 }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'createFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'forkRequiresOpen', locale: 'workspace',
      inject: (): ToastDisplayInjected<'forkRequiresOpen'> => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.forkRequiresOpen'), tone: 'warning', holdMs: 6000,
          actions: [{ label: t('toast.openForkSource'), onClick: () => { dismiss(); actions.openForkSource(notice.sessionId) } }],
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'forkRequiresOpen'>>)
    const archiveKeys = ['archived', 'stoppedAndArchived'] as const satisfies readonly ToastKind[]
    for (const key of archiveKeys) {
      yield ctx.slots.register({
        name: 'workspace.toast', key, locale: 'workspace', store: viewStore,
        inject: () => ({
          display: ((notice, t, dismiss) => ({
            text: t(key === 'archived' ? 'toast.archived' : 'toast.stoppedAndArchived'), tone: 'success', holdMs: 6000,
            actions: [{ label: t('toast.archivedUndo'), onClick: () => { dismiss(); actions.undoArchive(notice.sessionId) } }],
          })) satisfies ToastDisplayInjected<typeof key>['display'],
          filterAction: (t: Parameters<ToastDisplayInjected<typeof key>['display']>[1], dismiss: () => void) => ({
            prefix: t('toast.archivedOr'), label: t('toast.archivedFilter'),
            onClick: () => { dismiss(); actions.showArchived() },
          }),
        }),
      }, ArchiveToastEntry)
    }
  })
}
