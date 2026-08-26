import { useEffect, useRef, useState } from 'react'
import DiffBody, { type DiffFileEntry } from './DiffBody'
import DiffScroll from './DiffScroll'
import DiscardDialog from './DiscardDialog'
import FailureDialog from './FailureDialog'
import { type Failure } from '@renderer/format'
import { useGitAction } from '@renderer/useGitAction'
import { useLatestRun } from '@renderer/useLatestRun'

type GitDiff =
  | Awaited<ReturnType<typeof window.api.git.diff>>
  | Awaited<ReturnType<typeof window.api.git.reviewDiff>>

interface WorkingDiffViewProps {
  active: boolean
  cwd: string
  focus?: string
  focusKey: number
  review?: {
    index: number
    total: number
    onPrevious: () => void
    onNext: () => void
  }
  onOpenCommit?: (cwd: string, hash: string) => void
  onClose?: () => void
}

function WorkingDiffView({
  active,
  cwd,
  focus,
  focusKey,
  review,
  onOpenCommit,
  onClose
}: WorkingDiffViewProps): React.JSX.Element {
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [discarding, setDiscarding] = useState<DiffFileEntry | null>(null)
  const fileAction = useGitAction({ onFailure: setFailure })
  const latestRun = useLatestRun()
  const loaded = useRef(false)
  const reviewMode = !!review

  const staging = {
    busy: fileAction.pending,
    onSetStaged: (file: DiffFileEntry, staged: boolean): void => {
      fileAction.run(() =>
        staged
          ? window.api.git.stageFile(cwd, file.path, file.oldPath)
          : window.api.git.unstageFile(cwd, file.path, file.oldPath)
      )
    },
    onRevert: setDiscarding
  }

  const discard = (file: DiffFileEntry): void => {
    setDiscarding(null)
    fileAction.run(() => window.api.git.revertFile(cwd, file.path, file.oldPath))
  }

  useEffect(() => {
    window.api.git.watch(cwd)
    return () => {
      window.api.git.unwatch(cwd)
    }
  }, [cwd])

  useEffect(() => {
    loaded.current = false

    const keep = (isCurrent: () => boolean): boolean => {
      if (isCurrent() || !loaded.current) {
        loaded.current = true
        return true
      }
      return false
    }

    const load = async (): Promise<void> => {
      const isCurrent = latestRun()
      try {
        const result = reviewMode
          ? await window.api.git.reviewDiff(cwd)
          : await window.api.git.diff(cwd)
        if (!keep(isCurrent)) return
        setDiff(result)
        setError(null)
      } catch {
        if (!keep(isCurrent)) return
        setDiff(null)
        setError(
          reviewMode
            ? 'Could not compare workflow with the default branch'
            : 'Could not read working tree'
        )
      }
    }

    load()
    const offChanged = window.api.git.onChanged((changedCwd) => {
      if (changedCwd === cwd) load()
    })

    return () => {
      offChanged()
    }
  }, [cwd, latestRun, reviewMode])

  const body = (): React.JSX.Element => {
    if (error) return <div className="commit-empty">{error}</div>
    if (!diff) return <div className="commit-empty">Loading…</div>
    const target = 'target' in diff ? diff.target : null

    return (
      <>
        <div className="commit-header">
          <div className="commit-subject">
            {target ? `Changes since ${target}` : 'Uncommitted changes'}
          </div>
          <div className="commit-meta">
            <span className="commit-refs">{diff.branch ?? 'detached HEAD'}</span>
            <span>{cwd}</span>
          </div>
        </div>

        {diff.files.length === 0 ? (
          <div className="commit-empty">
            {target ? `No changes since ${target}` : 'Working tree clean'}
          </div>
        ) : (
          <DiffBody
            cwd={cwd}
            base={diff.base}
            files={diff.files}
            patch={diff.patch}
            truncated={diff.truncated}
            truncatedNote={
              target
                ? `Diff too large to display in full - compare with ${target} in a shell to see the rest.`
                : 'Diff too large to display in full - run git diff in a shell to see the rest.'
            }
            focus={focus}
            focusKey={focusKey}
            onOpenCommit={onOpenCommit}
            staging={reviewMode ? undefined : staging}
          />
        )}
      </>
    )
  }

  return (
    <DiffScroll
      active={active}
      onClose={onClose}
      tools={
        review && (
          <div className="review-navigation" aria-label="Review navigation">
            <button
              type="button"
              className="review-navigation-button"
              disabled={review.index === 0}
              onClick={review.onPrevious}
              title="Previous workflow"
              aria-label="Previous workflow"
            >
              ←
            </button>
            <span className="review-navigation-position">
              {review.index + 1} / {review.total}
            </span>
            <button
              type="button"
              className="review-navigation-button"
              disabled={review.index === review.total - 1}
              onClick={review.onNext}
              title="Next workflow"
              aria-label="Next workflow"
            >
              →
            </button>
          </div>
        )
      }
    >
      {body()}
      {discarding && (
        <DiscardDialog
          path={discarding.path}
          onCancel={() => setDiscarding(null)}
          onConfirm={() => discard(discarding)}
        />
      )}
      {failure && <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />}
    </DiffScroll>
  )
}

export default WorkingDiffView
