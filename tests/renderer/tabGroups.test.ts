import { describe, expect, it } from 'vitest'
import { groupSlotAllowed, regroupTabs, slotAllowed } from '@renderer/tabGroups'

const groupOf = (item: string): string | null => (item.includes(':') ? item.split(':')[0] : null)

describe('regroupTabs', () => {
  it('pulls each group together at its first position', () => {
    expect(regroupTabs(['a:1', 'x', 'b:1', 'a:2', 'y', 'b:2'], groupOf)).toEqual([
      'a:1',
      'a:2',
      'x',
      'b:1',
      'b:2',
      'y'
    ])
  })

  it('leaves an already grouped order untouched', () => {
    const items = ['x', 'a:1', 'a:2', 'y']
    expect(regroupTabs(items, groupOf)).toEqual(items)
  })
})

describe('slotAllowed', () => {
  const groups = ['a', 'a', null, 'b', 'b']

  it('keeps a grouped tab inside its own span', () => {
    expect(slotAllowed(groups, 0, 0)).toBe(true)
    expect(slotAllowed(groups, 0, 2)).toBe(true)
    expect(slotAllowed(groups, 0, 3)).toBe(false)
  })

  it('lets an ungrouped tab land anywhere but inside a group', () => {
    expect(slotAllowed(groups, 2, 0)).toBe(true)
    expect(slotAllowed(groups, 2, 1)).toBe(false)
    expect(slotAllowed(groups, 2, 3)).toBe(true)
    expect(slotAllowed(groups, 2, 4)).toBe(false)
    expect(slotAllowed(groups, 2, 5)).toBe(true)
  })
})

describe('groupSlotAllowed', () => {
  const groups = ['a', 'a', null, 'b', 'b']

  it('rejects no-op slots and slots that split another group', () => {
    expect(groupSlotAllowed(groups, 0, 2, 0)).toBe(false)
    expect(groupSlotAllowed(groups, 0, 2, 2)).toBe(false)
    expect(groupSlotAllowed(groups, 0, 2, 3)).toBe(true)
    expect(groupSlotAllowed(groups, 0, 2, 4)).toBe(false)
    expect(groupSlotAllowed(groups, 0, 2, 5)).toBe(true)
    expect(groupSlotAllowed(groups, 3, 2, 0)).toBe(true)
    expect(groupSlotAllowed(groups, 3, 2, 6)).toBe(false)
  })
})
