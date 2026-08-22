import { useTheme } from './themeStore'
import type { GitColors } from './themeStore'

export type { GitColors }

export const fallbackLanes = ['#6fb2f0', '#7fd8e8', '#9d9ce8', '#c09ae0']

export function useGitColors(): GitColors | null {
  return useTheme()?.git ?? null
}
