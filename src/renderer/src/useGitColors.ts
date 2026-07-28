import { useTheme } from './themeStore'
import type { GitColors } from './themeStore'

export type { GitColors }

export function useGitColors(): GitColors | null {
  return useTheme()?.git ?? null
}
