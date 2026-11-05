import { useState, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import { Dialog as DialogPrimitive } from 'radix-ui'
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleDashed,
  Eye,
  EyeOff,
  GitBranch,
  Loader2,
  RotateCcw,
  Star,
  X,
} from 'lucide-react'
import type { BoardPr, PrDetail } from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { usePrDetail, usePrs, useSetFlags, useSetStage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from './card'
import { age, prSize, stageLabel, useBoardStore, useNow } from './model'

const reviewTone: Record<string, 'success' | 'destructive' | 'default' | 'accent'> = {
  APPROVED: 'success',
  CHANGES_REQUESTED: 'destructive',
  COMMENTED: 'default',
  REQUESTED: 'accent',
  DISMISSED: 'default',
}

const reviewLabel: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  COMMENTED: 'Commented',
  REQUESTED: 'Requested',
  DISMISSED: 'Dismissed',
}

const checkDot: Record<PrDetail['checks'][number]['state'], string> = {
  success: 'bg-success',
  failure: 'bg-destructive',
  pending: 'bg-warning',
  neutral: 'bg-muted-foreground/50',
  skipped: 'bg-muted-foreground/30',
}

const sanitize = (html: string) =>
  DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] })

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Checks({ detail }: { detail: PrDetail }) {
  const [open, setOpen] = useState(detail.ciState === 'failure')
  const counted = detail.checks.filter((check) => !check.ignored)
  const failing = counted.filter((check) => check.state === 'failure').length
  const pending = counted.filter((check) => check.state === 'pending').length
  const ignoredFailing = detail.checks.filter(
    (check) => check.ignored && check.state === 'failure',
  ).length
  if (detail.checks.length === 0) return <p className="text-sm text-muted-foreground">No checks</p>
  const sorted = [...detail.checks].sort((a, b) => {
    const rank = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }
    return Number(a.ignored) - Number(b.ignored) || rank[a.state] - rank[b.state]
  })
  return (
    <div className="rounded-xl border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
      >
        <span
          className={cn(
            'size-2.5 rounded-full',
            {
              success: 'bg-success',
              failure: 'bg-destructive',
              pending: 'bg-warning',
              none: 'bg-muted-foreground/40',
            }[detail.ciState],
          )}
        />
        <span className="flex-1">
          {failing > 0
            ? `${failing} failing`
            : pending > 0
              ? `${pending} running`
              : 'All checks passing'}
          <span className="text-muted-foreground">
            {' '}
            · {counted.length} checks
            {ignoredFailing > 0 && ` · ${ignoredFailing} expected red ignored`}
          </span>
        </span>
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="max-h-72 overflow-y-auto border-t py-1">
          {sorted.map((check, index) => (
            <li key={`${check.name}-${index}`}>
              <a
                href={check.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  'flex items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-secondary',
                  check.ignored && 'opacity-60',
                )}
              >
                <span className={cn('size-2 shrink-0 rounded-full', checkDot[check.state])} />
                <span className="truncate">{check.name}</span>
                {check.ignored && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">expected</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Overview({ pr }: { pr: BoardPr }) {
  const { data: detail, isLoading, error } = usePrDetail(pr.id)
  const setStage = useSetStage()
  const now = useNow()
  return (
    <div className="space-y-7">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
        <dt className="text-muted-foreground">Stage</dt>
        <dd className="flex items-center gap-2">
          {stageLabel(pr.tab, pr.stage)}
          <span className="text-muted-foreground">for {age(pr.stageSince, now)}</span>
          {pr.manual && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setStage.mutate({ id: pr.id, stage: null })}
            >
              <RotateCcw />
              Back to {stageLabel(pr.tab, pr.derivedStage)}
            </Button>
          )}
        </dd>
        <dt className="text-muted-foreground">Author</dt>
        <dd className="flex items-center gap-2">
          <Avatar src={pr.authorAvatar} name={pr.author} />
          {pr.author}
          {pr.role === 'takeover' && <Badge variant="accent">Taken over</Badge>}
        </dd>
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate select-text">
            {detail?.headOwner && detail.headOwner !== pr.repo.split('/')[0]
              ? `${detail.headOwner}:`
              : ''}
            {detail?.headRef ?? '…'}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="truncate">{detail?.baseRef ?? '…'}</span>
        </dd>
        <dt className="text-muted-foreground">Size</dt>
        <dd>
          <span className="font-mono">{prSize(pr)}</span>{' '}
          <span className="text-success">+{pr.additions}</span>{' '}
          <span className="text-destructive">−{pr.deletions}</span>
          <span className="text-muted-foreground">
            {' '}
            · {pr.changedFiles} files{detail ? ` · ${detail.commits} commits` : ''}
          </span>
        </dd>
        {pr.unresolvedThreads > 0 && (
          <>
            <dt className="text-muted-foreground">Threads</dt>
            <dd>{pr.unresolvedThreads} unresolved</dd>
          </>
        )}
      </dl>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading from GitHub…
        </div>
      )}
      <ErrorText error={error} />

      {detail && (
        <>
          <Block title="Checks">
            <Checks detail={detail} />
          </Block>

          {detail.reviewers.length > 0 && (
            <Block title="Reviewers">
              <ul className="space-y-1.5">
                {detail.reviewers.map((reviewer) => (
                  <li
                    key={`${reviewer.kind}-${reviewer.name}`}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Avatar src={reviewer.avatar} name={reviewer.name} />
                    <span>
                      {reviewer.kind === 'team' ? `team ${reviewer.name}` : reviewer.name}
                    </span>
                    <Badge variant={reviewTone[reviewer.state] ?? 'default'} className="ml-auto">
                      {reviewer.state === 'APPROVED' ? (
                        <Check />
                      ) : reviewer.state === 'REQUESTED' ? (
                        <CircleDashed />
                      ) : null}
                      {reviewLabel[reviewer.state] ?? reviewer.state}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {detail.linkedIssues.length > 0 && (
            <Block title="Linked issues">
              <ul className="space-y-1">
                {detail.linkedIssues.map((issue) => (
                  <li key={issue.url}>
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-md text-sm hover:underline"
                    >
                      <span className="font-mono text-muted-foreground">#{issue.number}</span>
                      <span className="truncate">{issue.title}</span>
                      {issue.state !== 'OPEN' && (
                        <Badge className="ml-auto">{issue.state.toLowerCase()}</Badge>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {detail.labels.length > 0 && (
            <Block title="Labels">
              <div className="flex flex-wrap gap-1.5">
                {detail.labels.map((label) => (
                  <span
                    key={label.name}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: `#${label.color}` }}
                    />
                    {label.name}
                  </span>
                ))}
              </div>
            </Block>
          )}

          <Block title="Description">
            {detail.bodyHtml.trim() ? (
              <div
                className="markdown-body select-text"
                dangerouslySetInnerHTML={{ __html: sanitize(detail.bodyHtml) }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
          </Block>
        </>
      )}
    </div>
  )
}

export function PrDrawer() {
  const openPrId = useBoardStore((state) => state.openPrId)
  const openPr = useBoardStore((state) => state.openPr)
  const { data: prs } = usePrs()
  const setFlags = useSetFlags()
  const pr = prs?.find((item) => item.id === openPrId) ?? null

  return (
    <DialogPrimitive.Root open={pr !== null} onOpenChange={(open) => !open && openPr(null)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-y-3 right-3 z-50 flex w-[min(620px,calc(100vw-48px))] flex-col rounded-2xl border bg-background shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right-8 data-[state=open]:fade-in-0">
          {pr && (
            <>
              <header className="space-y-3 border-b px-6 pt-6 pb-4">
                <div className="flex items-center gap-2 pr-8 text-sm text-muted-foreground">
                  <span className="font-mono">{pr.repo}</span>
                  <span className="font-mono">#{pr.number}</span>
                  {pr.isDraft && <Badge>Draft</Badge>}
                  {pr.state === 'MERGED' && <Badge variant="accent">Merged</Badge>}
                  {pr.state === 'CLOSED' && <Badge variant="destructive">Closed</Badge>}
                  {pr.manual && <Badge variant="accent">Manual stage</Badge>}
                </div>
                <DialogPrimitive.Title className="text-xl leading-snug font-semibold select-text">
                  {pr.title}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="sr-only">
                  Pull request overview
                </DialogPrimitive.Description>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" asChild>
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      <ArrowUpRight />
                      Open on GitHub
                    </a>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-pressed={pr.starred}
                    onClick={() => setFlags.mutate({ id: pr.id, starred: !pr.starred })}
                  >
                    <Star className={cn(pr.starred && 'fill-warning text-warning')} />
                    {pr.starred ? 'Starred' : 'Star'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setFlags.mutate({ id: pr.id, hidden: !pr.hidden })}
                  >
                    {pr.hidden ? <Eye /> : <EyeOff />}
                    {pr.hidden ? 'Show on board' : 'Hide'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setFlags.mutate({ id: pr.id, archived: pr.archivedAt === null })}
                  >
                    {pr.archivedAt === null ? <Archive /> : <ArchiveRestore />}
                    {pr.archivedAt === null ? 'Archive' : 'Restore'}
                  </Button>
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <Overview pr={pr} />
              </div>
              <DialogPrimitive.Close className="absolute top-5 right-5 rounded-md p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <X className="size-4" />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
