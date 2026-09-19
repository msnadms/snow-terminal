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
