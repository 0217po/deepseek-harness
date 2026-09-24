import { createContext, useState, type ReactNode } from 'react'

interface GroupState {
  isWarm: () => boolean
  enter: () => void
  leave: () => void
  shown: (owner: symbol, dismiss: () => void) => void
  release: (owner: symbol) => void
}

/** Private coordination shared only by opted-in HoverCards inside one mounted group. */
export const HoverCardGroupContext = createContext<GroupState | null>(null)

/**
 * Share the first displayed card's dwell across one physical list, without closing readable portals on list exit.
 * @param props.children - list contents, including opted-in HoverCards.
 * @param props.className - classes for the physical list container.
 * @returns the list container and its private hover coordinator.
 */
export function HoverCardGroup({ children, className }: { children: ReactNode; className?: string }) {
  const [group] = useState<GroupState>(() => {
    let inside = false
    let warm = false
    let active: { owner: symbol; dismiss: () => void } | null = null
    return {
      isWarm: () => warm,
      enter: () => { inside = true },
      leave: () => { inside = false; warm = false },
      shown: (owner, dismiss) => {
        if (inside) warm = true
        const previous = active
        active = { owner, dismiss }
        if (previous !== null && previous.owner !== owner) previous.dismiss()
      },
      release: (owner) => { if (active?.owner === owner) active = null },
    }
  })
  return (
    <HoverCardGroupContext.Provider value={group}>
      <div
        className={className}
        onPointerOverCapture={(event) => {
          if (event.currentTarget.contains(event.target as Node)) group.enter()
        }}
        onPointerOutCapture={(event) => {
          // React portals bubble through this component but are outside the physical list.
          if (event.currentTarget.contains(event.target as Node)
            && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) group.leave()
        }}
      >
        {children}
      </div>
    </HoverCardGroupContext.Provider>
  )
}
