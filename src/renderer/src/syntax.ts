const byExtension: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'css',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  toml: 'toml'
}

const byBasename: Record<string, string> = {
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash'
}

export function languageFor(filePath: string): string | null {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1)
  const direct = byBasename[name]
  if (direct) return direct
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return byExtension[name.slice(dot + 1).toLowerCase()] ?? null
}
