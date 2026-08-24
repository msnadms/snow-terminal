/**
 * Keeps every item of one group contiguous, anchored where that group's first item already sits.
 * Items with no group keep their place, so they can be dragged anywhere between groups.
 */
export function regroupTabs<T>(items: T[], groupOf: (item: T) => string | null): T[] {
  const ordered: T[] = []
  const tail = new Map<string, number>()
  for (const item of items) {
    const group = groupOf(item)
    const at = group != null ? tail.get(group) : undefined
    if (group == null || at == null) {
      ordered.push(item)
      if (group != null) tail.set(group, ordered.length - 1)
      continue
    }
    ordered.splice(at + 1, 0, item)
    for (const [key, index] of tail) if (index > at) tail.set(key, index + 1)
    tail.set(group, at + 1)
  }
  return ordered
}

/**
 * Whether dragging the item at `from` to land at insertion index `slot` (into an array already in
 * `regroupTabs` order) keeps every group contiguous: a grouped item may only land within its own
 * group's span, and an ungrouped item may land anywhere except strictly inside another group's span.
 */
export function slotAllowed(groups: (string | null)[], from: number, slot: number): boolean {
  const group = groups[from]
  if (group == null) {
    const insideForeignGroup =
      slot > 0 &&
      slot < groups.length &&
      groups[slot - 1] != null &&
      groups[slot - 1] === groups[slot]
    return !insideForeignGroup
  }
  return slot >= groups.indexOf(group) && slot <= groups.lastIndexOf(group) + 1
}

/**
 * Whether a contiguous group can be inserted at `slot` without splitting another group. Slots in
 * the dragged range are all no-ops once that range is removed, so they are rejected as well.
 */
export function groupSlotAllowed(
  groups: (string | null)[],
  from: number,
  count: number,
  slot: number
): boolean {
  if (slot < 0 || slot > groups.length || (slot >= from && slot <= from + count)) return false
  if (slot === 0 || slot === groups.length) return true
  return groups[slot - 1] == null || groups[slot - 1] !== groups[slot]
}
