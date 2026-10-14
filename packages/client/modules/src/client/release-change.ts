/** Host release changes held back from a page whose code belongs to another release. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { BootManifest, WebBootRelease } from './manifest.ts'

/** A Host graph whose release differs from the release this page last applied; its code waits for acceptance or a page reload. */
export interface ClientReleaseChange {
  /** Release this page booted from; its shell and static modules stay at this release until a reload. */
  readonly page: WebBootRelease | undefined
  /** Release of the latest graph this page applied: its boot release or an accepted one. */
  readonly current: WebBootRelease | undefined
  /** Release of the latest Host graph. */
  readonly next: WebBootRelease | undefined
}

/** Whether two releases are the same: both absent, or equal in every field. */
function sameRelease(left: WebBootRelease | undefined, right: WebBootRelease | undefined): boolean {
  return left?.version === right?.version && left?.commit === right?.commit
}

/** Release identity as diagnostic text. */
function describeRelease(release: WebBootRelease | undefined): string {
  return release === undefined ? 'none' : JSON.stringify(release)
}

/**
 * Holds the latest Host graph of another release than the one this page last applied. The owner applies
 * only graphs that {@link admit} passes or {@link accept} releases, and reports each one through
 * {@link applied}. The current release lives in page memory, so a reload starts from the new boot release.
 */
export class ReleaseChangeGate {
  /** Pending Host release change; undefined while every received graph carries the current release. */
  readonly change: ObservableSnapshot<ClientReleaseChange | undefined> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
  private snapshot: ClientReleaseChange | undefined
  private readonly listeners = new Set<() => void>()
  private current: WebBootRelease | undefined
  private held: BootManifest | undefined

  /**
   * Start from the release the page booted from.
   * @param page - boot graph's release identity.
   */
  constructor(private readonly page: WebBootRelease | undefined) {
    this.current = page
  }

  /** Whether a graph of another release is held; its rebuilt frames carry nothing the next graph frame lacks. */
  get holding(): boolean {
    return this.held !== undefined
  }

  /**
   * Pass a graph of the current release; hold any other one and announce each new release once.
   * @param manifest - parsed Host graph.
   * @returns true when the owner applies the graph now.
   */
  admit(manifest: BootManifest): boolean {
    if (sameRelease(manifest.release, this.current)) return true
    this.held = manifest
    if (this.snapshot === undefined || !sameRelease(this.snapshot.next, manifest.release)) {
      console.warn(`client-modules: Host release changed from ${describeRelease(this.current)} to ${describeRelease(manifest.release)}; plugin updates pause until this page accepts it or reloads`)
      this.publish({ page: this.page, current: this.current, next: manifest.release })
    }
    return false
  }

  /**
   * Release the held graph for the owner to apply.
   * @returns the held graph, or undefined when no release change is pending.
   */
  accept(): BootManifest | undefined {
    return this.held
  }

  /**
   * Record a graph the owner applied as the current release, withdrawing any pending change.
   * @param manifest - graph about to be reconciled.
   */
  applied(manifest: BootManifest): void {
    this.held = undefined
    this.current = manifest.release
    if (this.snapshot !== undefined) this.publish(undefined)
  }

  private publish(snapshot: ClientReleaseChange | undefined): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        // The page controller has no owning plugin Context for a scoped logger.
        console.error('client-modules: release change subscriber failed', error)
      }
    }
  }
}
