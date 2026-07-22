import process from 'process'

export interface ShellSpec {
  file: string
  args: string[]
  env: Record<string, string>
}

const powershellInit = `
$global:__snowPrompt = $function:prompt
function global:prompt {
  $rendered = if ($global:__snowPrompt) { & $global:__snowPrompt } else { "PS $($PWD.ProviderPath)> " }
  $path = ($PWD.ProviderPath -replace '\\\\', '/')
  "$([char]27)]7;file://$env:COMPUTERNAME/$path$([char]27)\\$rendered"
}
`

const posixInit = 'printf "\\033]7;file://%s%s\\033\\\\" "${HOSTNAME:-localhost}" "$PWD"'

export function shellSpec(): ShellSpec {
  const env = process.env as Record<string, string>

  if (process.platform === 'win32') {
    const encoded = Buffer.from(powershellInit, 'utf16le').toString('base64')
    return {
      file: 'powershell.exe',
      args: ['-NoExit', '-EncodedCommand', encoded],
      env
    }
  }

  const existing = env.PROMPT_COMMAND ? `${env.PROMPT_COMMAND}; ` : ''
  return {
    file: process.env.SHELL || '/bin/bash',
    args: [],
    env: { ...env, PROMPT_COMMAND: `${existing}${posixInit}` }
  }
}
