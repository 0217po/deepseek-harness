/** Localized copy for explicit inline attachment references and their image preview. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Namespace owned by attachment reference renderers. */
export const NS = 'attachment'

/** Simplified Chinese attachment-reference copy. */
export const zh = {
  'file.label': '{name} · {size}',
  'image.label': '图片',
  'image.loading': '正在加载图片',
  'image.failed': '无法加载“{name}”，请重试或关闭此提示',
  'image.preview': '图片预览',
  'image.closePreview': '关闭图片预览',
  'close': '关闭',
  'retry': '重试',
} satisfies Record<string, string>

/** Keys required by both attachment dictionaries. */
export type AttachmentKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    attachment: AttachmentKey
  }
}

/** English attachment-reference copy. */
export const en = {
  'file.label': '{name} · {size}',
  'image.label': 'Image',
  'image.loading': 'Loading image',
  'image.failed': 'Couldn’t load “{name}”. Try again or close this message.',
  'image.preview': 'Image preview',
  'image.closePreview': 'Close image preview',
  'close': 'Close',
  'retry': 'Retry',
} satisfies Record<AttachmentKey, string>
