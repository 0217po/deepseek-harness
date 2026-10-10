/** Inline attachment labels; image reads start only after activation and reuse the Session-owned cache. */
import { useCallback, useEffect, useState } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, ImageLightbox, Modal, ReferenceChip, StateDot, fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageLoader } from '../MessageImage.tsx'
import type { NS } from './locales.ts'
import type {} from './user-text-rules.ts'
import css from './AttachmentReference.module.css'

/** Image loading is authorized by this reference's Session, independently of its text host. */
export interface AttachmentReferenceInjected {
  readonly loadImage: ImageLoader
}

type AttachmentReferenceProps = UserTextNodeProps<'attachment'>
  & InjectFace<AttachmentReferenceInjected> & PropsLocale<typeof NS>

/**
 * Keep file attachments read-only and open image previews only after an interactive activation.
 * @param props - explicit attachment node, interaction policy, authorized loader, and locale seat.
 * @returns an inline reference; image loading and preview dialogs render through body portals.
 */
export function AttachmentReference({ node, raw, interactive, loadImage, t }: AttachmentReferenceProps) {
  const { attachment } = node.data
  const [previewId, setPreviewId] = useState<ImageAttachmentRef['attachmentId'] | null>(null)
  const close = useCallback(() => { setPreviewId(null) }, [])
  if (attachment.type === 'file') {
    return <ReferenceChip appearance="file" title={raw} label={t('file.label', {
      name: attachment.ref.name, size: fileSizeText(attachment.ref.bytes),
    })} />
  }
  const label = attachment.ref.name ?? t('image.label')
  return <>
    <ReferenceChip appearance="file" label={label} title={raw}
      {...interactive ? { onActivate: () => { setPreviewId(attachment.ref.attachmentId) } } : {}} />
    {interactive && previewId === attachment.ref.attachmentId && <ImageReferencePreview
      key={attachment.ref.attachmentId}
      attachment={attachment.ref} label={label} loadImage={loadImage} t={t} onClose={close}
    />}
  </>
}

type ImagePreviewState = { readonly status: 'loading' | 'failed' } | { readonly status: 'open'; readonly url: string }

type ImageReferencePreviewProps = Pick<AttachmentReferenceProps, 'loadImage' | 't'> & {
  readonly attachment: ImageAttachmentRef
  readonly label: string
  readonly onClose: () => void
}

/** Mounted only by a user gesture; closing ignores pending settlement without aborting the shared read. */
function ImageReferencePreview({ attachment, label, loadImage, t, onClose }: ImageReferencePreviewProps) {
  const [preview, setPreview] = useState<ImagePreviewState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    const cached = loadImage.peek?.(attachment)
    setPreview(cached === undefined ? { status: 'loading' } : { status: 'open', url: cached })
    void loadImage(attachment).then(
      (url) => { if (live) setPreview({ status: 'open', url }) },
      () => { if (live) setPreview({ status: 'failed' }) },
    )
    return () => { live = false }
  }, [attachment, loadImage, attempt])

  if (preview.status === 'open') {
    return <ImageLightbox src={preview.url} alt={label} onClose={onClose}
      labels={{ dialog: t('image.preview'), close: t('image.closePreview') }} />
  }
  return <Modal open onClose={onClose} title={t('image.preview')} closeLabel={t('close')}
    footer={<>
      <Button variant="outline" onClick={onClose}>{t('close')}</Button>
      {preview.status === 'failed' && <Button variant="primary" onClick={() => { setAttempt(value => value + 1) }}>
        {t('retry')}
      </Button>}
    </>}
  >
    {preview.status === 'failed'
      ? <p role="alert">{t('image.failed', { name: label })}</p>
      : <span className={css.loading} role="status" aria-label={t('image.loading')}><StateDot state="ongoing" /></span>}
  </Modal>
}
