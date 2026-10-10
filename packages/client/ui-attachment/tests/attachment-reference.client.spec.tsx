// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AttachmentReference } from '../src/client/AttachmentReference.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const image: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'photo.png',
}

type Props = ComponentProps<typeof AttachmentReference>

function props(loadImage: Props['loadImage'], attachment: ImageAttachmentRef = image): Props {
  return {
    node: { id: 'attachment', start: 0, end: 6, data: { attachment: { type: 'image', ref: attachment } } },
    raw: '@photo', interactive: true, loadImage, t: makeTranslate(en),
  } as Props
}

describe('AttachmentReference', () => {
  it('keeps files and non-interactive images read-only without starting image reads', () => {
    const loadImage = vi.fn(() => Promise.resolve('blob:unused'))
    const input = props(loadImage)
    const view = render(<AttachmentReference {...input} interactive={false} />)
    expect(view.getByText('photo.png').getAttribute('title')).toBe('@photo')
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(<AttachmentReference {...input} node={{
      id: 'attachment', start: 0, end: 6,
      data: { attachment: { type: 'file', ref: {
        attachmentId: image.attachmentId, name: 'notes.txt', bytes: 42,
      } } },
    }} />)
    expect(view.getByText('notes.txt · 42B')).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
    expect(loadImage).not.toHaveBeenCalled()
  })

  it('loads only after activation and closes the resolved preview', async () => {
    const pending = Promise.withResolvers<string>()
    const loadImage = vi.fn(() => pending.promise)
    const view = render(<AttachmentReference {...props(loadImage)} />)
    expect(loadImage).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'photo.png' }))
    expect(view.getByRole('status', { name: 'Loading image' })).toBeTruthy()
    expect(loadImage).toHaveBeenCalledWith(image)
    await act(async () => { pending.resolve('blob:photo') })
    expect(view.getByAltText('photo.png').getAttribute('src')).toBe('blob:photo')
    fireEvent.click(view.getByRole('button', { name: 'Close image preview' }))
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('shows a cached unnamed image while its authorized read settles', async () => {
    const { name: _name, ...unnamed } = image
    const pending = Promise.withResolvers<string>()
    const loadImage = Object.assign(vi.fn(() => pending.promise), { peek: vi.fn(() => 'blob:cached') })
    const view = render(<AttachmentReference {...props(loadImage, unnamed)} />)
    fireEvent.click(view.getByRole('button', { name: 'Image' }))
    expect(view.getByAltText('Image').getAttribute('src')).toBe('blob:cached')
    expect(loadImage.peek).toHaveBeenCalledWith(unnamed)
    await act(async () => { pending.resolve('blob:fresh') })
    expect(view.getByAltText('Image').getAttribute('src')).toBe('blob:fresh')
  })

  it('contains failed image reads and retries through the same authorized loader', async () => {
    const loadImage = Object.assign(vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('blob:retry'), { peek: () => undefined })
    const view = render(<AttachmentReference {...props(loadImage)} />)
    fireEvent.click(view.getByRole('button', { name: 'photo.png' }))
    expect((await view.findByRole('alert')).textContent).toBe('Couldn’t load “photo.png”. Try again or close this message.')
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect((await view.findByAltText('photo.png')).getAttribute('src')).toBe('blob:retry')
    expect(loadImage).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'reject'] as const)('ignores a closed read that later %ss without reopening its dialog', async (outcome) => {
    const pending = Promise.withResolvers<string>()
    const view = render(<AttachmentReference {...props(() => pending.promise)} />)
    fireEvent.click(view.getByRole('button', { name: 'photo.png' }))
    fireEvent.click(view.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(view.queryByRole('dialog')).toBeNull()
    await act(async () => {
      if (outcome === 'resolve') pending.resolve('blob:late')
      else pending.reject(new Error('late failure'))
    })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.getByRole('button', { name: 'photo.png' })).toBeTruthy()
  })
})
