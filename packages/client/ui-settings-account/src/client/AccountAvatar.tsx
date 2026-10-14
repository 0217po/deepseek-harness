/** Shared account picture with an icon fallback for missing or unavailable images. */
import { IconUserOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountAvatarSnapshot } from './account-avatar.ts'
import css from './AccountAvatar.module.css'

/**
 * Render a decorative avatar next to the account identity.
 * @param props - shared browser load outcome; absent when no profile picture is available.
 * @returns picture or the default account icon.
 */
export function AccountAvatar({ avatar }: { avatar: AccountAvatarSnapshot | undefined }) {
  return avatar?.status === 'ready'
    ? <img className={css.image} src={avatar.url} alt="" referrerPolicy="no-referrer" />
    : <IconUserOutlineMedium size={16} />
}
