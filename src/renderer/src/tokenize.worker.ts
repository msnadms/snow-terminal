import { tokenize } from 'react-diff-view/esm/tokenize'
import type { HunkData, TokenizeOptions } from 'react-diff-view'
import { refractor } from 'refractor/core'
import bash from 'refractor/bash'
import c from 'refractor/c'
import cpp from 'refractor/cpp'
import csharp from 'refractor/csharp'
import css from 'refractor/css'
import go from 'refractor/go'
import java from 'refractor/java'
import javascript from 'refractor/javascript'
import json from 'refractor/json'
import jsx from 'refractor/jsx'
import markdown from 'refractor/markdown'
import markup from 'refractor/markup'
import php from 'refractor/php'
import python from 'refractor/python'
import ruby from 'refractor/ruby'
import rust from 'refractor/rust'
import scss from 'refractor/scss'
import sql from 'refractor/sql'
import toml from 'refractor/toml'
import tsx from 'refractor/tsx'
import typescript from 'refractor/typescript'
import yaml from 'refractor/yaml'

for (const language of [
  markup,
  css,
  scss,
  javascript,
  jsx,
  typescript,
  tsx,
  json,
  markdown,
  yaml,
  bash,
  python,
  go,
  rust,
  java,
  c,
  cpp,
  csharp,
  ruby,
  php,
  sql,
  toml
]) {
  refractor.register(language)
}

type TokenizeRefractor = Extract<TokenizeOptions, { highlight: true }>['refractor']

const highlighter = {
  highlight: (value: string, language: string) => refractor.highlight(value, language).children
} as unknown as TokenizeRefractor

export interface TokenizeRequest {
  type: 'tokenize'
  id: number
  payload: {
    hunks: HunkData[]
    oldSource: string | null
    language: string | null
  }
}

self.addEventListener('message', ({ data }: MessageEvent<TokenizeRequest>) => {
  if (data.type !== 'tokenize') return
  const { hunks, oldSource, language } = data.payload

  if (!language || !refractor.registered(language)) {
    self.postMessage({
      id: data.id,
      payload: { success: false, reason: `no grammar registered for ${language ?? 'this file'}` }
    })
    return
  }

  try {
    const tokens = tokenize(hunks, {
      highlight: true,
      refractor: highlighter,
      language,
      oldSource: oldSource ?? undefined
    })
    self.postMessage({ id: data.id, payload: { success: true, tokens } })
  } catch (error) {
    self.postMessage({
      id: data.id,
      payload: { success: false, reason: error instanceof Error ? error.message : String(error) }
    })
  }
})
