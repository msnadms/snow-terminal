const scpLike = /^(?:[^@/]+@)?([^:/]+):(.+)$/

export function webUrl(raw: string): URL | null {
  const text = raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  if (!text) return null

  const scp = !text.includes('://') ? scpLike.exec(text) : null
  const normalized = scp ? `https://${scp[1]}/${scp[2]}` : text

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return null
  }
  if (!parsed.hostname) return null

  let url: URL
  try {
    url = new URL(`https://${parsed.hostname}${parsed.pathname}`)
  } catch {
    return null
  }

  const azureSsh = /^\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (azureSsh) {
    const host = url.hostname.toLowerCase()
    if (host === 'ssh.dev.azure.com') {
      url.hostname = 'dev.azure.com'
      url.pathname = `/${azureSsh[1]}/${azureSsh[2]}/_git/${azureSsh[3]}`
    } else if (host === 'vs-ssh.visualstudio.com') {
      url.hostname = `${azureSsh[1]}.visualstudio.com`
      url.pathname = `/${azureSsh[2]}/_git/${azureSsh[3]}`
    }
  }

  return url
}

function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/')
}

const forges: { labels: string[]; path: (web: string, branch: string, base: string) => string }[] =
  [
    {
      labels: ['github'],
      path: (web, branch, base) =>
        `${web}/compare/${encodeRef(base)}...${encodeRef(branch)}?expand=1`
    },
    {
      labels: ['gitlab'],
      path: (web, branch) =>
        `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`
    },
    {
      labels: ['bitbucket'],
      path: (web, branch, base) =>
        `${web}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(base)}`
    },
    {
      labels: ['azure', 'visualstudio'],
      path: (web, branch, base) =>
        `${web}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}&targetRef=${encodeURIComponent(base)}`
    }
  ]

export function pullRequestUrl(
  repo: URL,
  branch: string,
  base: string,
  template: string
): string | null {
  const web = `${repo.origin}${repo.pathname}`
  if (template) {
    return template
      .replaceAll('{branch}', encodeRef(branch))
      .replaceAll('{base}', encodeRef(base))
      .replaceAll('{repo}', web)
  }
  const labels = repo.hostname.toLowerCase().split('.')
  const forge = forges.find((entry) => entry.labels.some((label) => labels.includes(label)))
  return forge ? forge.path(web, branch, base) : null
}
