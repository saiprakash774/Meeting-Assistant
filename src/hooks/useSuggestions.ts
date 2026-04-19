import { useEffect, useRef, useState } from 'react'
import type { AppSettings, RefreshTrigger, SuggestionBatch } from '../types'
import { createLiveSuggestions } from '../lib/groq'
import { buildSessionHeader, isDailyLimitError, extractWaitTime, makeId, nowIso } from '../lib/utils'
import {
  REFRESH_COOLDOWN_MS,
  SILENCE_THRESHOLD_MS,
  MIN_SUGGESTION_CONTEXT_CHARS,
  MIN_NEW_CHARS_FOR_REFRESH,
} from '../constants'

type Params = {
  settingsRef: React.MutableRefObject<AppSettings>
  isRecording: boolean
  isRecordingRef: React.MutableRefObject<boolean>
  hasFirstRealCommit: boolean
  hasFirstRealCommitRef: React.MutableRefObject<boolean>
  lastRealCommitAtRef: React.MutableRefObject<number>
  transcriptTextRef: React.MutableRefObject<string>
  pendingTranscriptPartsRef: React.MutableRefObject<string[]>
  flushAndCommitAllPending: () => Promise<void>
  sessionStartRef: React.MutableRefObject<Date | null>
  onError: (msg: string) => void
  onClearError: () => void
}

export function useSuggestions({
  settingsRef,
  isRecording,
  isRecordingRef,
  hasFirstRealCommit,
  hasFirstRealCommitRef,
  lastRealCommitAtRef,
  transcriptTextRef,
  pendingTranscriptPartsRef,
  flushAndCommitAllPending,
  sessionStartRef,
  onError,
  onClearError,
}: Params) {
  const [suggestionBatches, setSuggestionBatches] = useState<SuggestionBatch[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSuggestionTimerActive, setIsSuggestionTimerActive] = useState(false)
  const [nextRefreshInSec, setNextRefreshInSec] = useState(30)
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null)

  // Refs to avoid stale closures inside setInterval callbacks.
  const isRefreshingRef = useRef(false)
  const suggestionBatchesRef = useRef<SuggestionBatch[]>([])
  const lastRefreshAtRef = useRef(0)
  const lastSuggestionContextLengthRef = useRef(0)
  const prevHasFirstRealCommitRef = useRef(false)

  const suggestionsIntervalRef = useRef<number | null>(null)
  const countdownIntervalRef = useRef<number | null>(null)
  const silenceWatchRef = useRef<number | null>(null)

  // ── Timer helpers ──

  const stopSuggestionTimer = () => {
    if (suggestionsIntervalRef.current) {
      window.clearInterval(suggestionsIntervalRef.current)
      suggestionsIntervalRef.current = null
    }
    if (countdownIntervalRef.current) {
      window.clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    setIsSuggestionTimerActive(false)
  }

  const stopSilenceWatch = () => {
    if (silenceWatchRef.current) {
      window.clearInterval(silenceWatchRef.current)
      silenceWatchRef.current = null
    }
  }

  const startSuggestionTimer = () => {
    stopSuggestionTimer()
    const intervalMs = settingsRef.current.suggestionIntervalMs
    setNextRefreshInSec(Math.ceil(intervalMs / 1000))
    setIsSuggestionTimerActive(true)
    suggestionsIntervalRef.current = window.setInterval(() => {
      if (isRecordingRef.current) void refreshSuggestions('auto')
    }, intervalMs)
    countdownIntervalRef.current = window.setInterval(() => {
      setNextRefreshInSec((prev) => {
        const next = prev - 1
        if (next <= 0) return Math.ceil(settingsRef.current.suggestionIntervalMs / 1000)
        return next
      })
    }, 1_000)
  }

  const startSilenceWatch = () => {
    stopSilenceWatch()
    silenceWatchRef.current = window.setInterval(() => {
      if (!isRecordingRef.current || !hasFirstRealCommitRef.current) return
      const silent = Date.now() - lastRealCommitAtRef.current >= SILENCE_THRESHOLD_MS
      const timerRunning = suggestionsIntervalRef.current !== null
      if (silent && timerRunning) {
        stopSuggestionTimer()
        setNextRefreshInSec(Math.ceil(settingsRef.current.suggestionIntervalMs / 1000))
      } else if (!silent && !timerRunning) {
        startSuggestionTimer()
      }
    }, 1_000)
  }

  const stopAllTimers = () => {
    stopSuggestionTimer()
    stopSilenceWatch()
  }

  // ── Suggestion timer lifecycle ──
  // Starts after the first real 30s commit. On first flip, fires one batch
  // immediately so the user sees suggestions at ~30s not ~60s.
  useEffect(() => {
    if (!isRecording || !hasFirstRealCommit) return
    const isFirstCommit = !prevHasFirstRealCommitRef.current
    prevHasFirstRealCommitRef.current = true
    startSuggestionTimer()
    if (isFirstCommit) void refreshSuggestions('auto')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, hasFirstRealCommit, settingsRef.current.suggestionIntervalMs])

  // Silence watch: start when recording begins, stop when it ends.
  useEffect(() => {
    if (isRecording) startSilenceWatch()
    else stopSilenceWatch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording])

  // ── Core suggestion refresh ──

  const refreshSuggestions = async (trigger: RefreshTrigger = 'manual'): Promise<void> => {
    if (!settingsRef.current.apiKey) {
      onError('Add your Groq API key in Settings first.')
      return
    }
    // Use a ref to avoid stale closure — the interval callback captures
    // isRefreshing at the time the timer was started, not the current value.
    if (isRefreshingRef.current) {
      if (trigger === 'manual') setRefreshStatus('Suggestions are already updating…')
      return
    }

    if (trigger === 'manual') {
      const msSinceLast = Date.now() - lastRefreshAtRef.current
      if (msSinceLast < REFRESH_COOLDOWN_MS) {
        setRefreshStatus('Suggestions are up to date. Auto-refresh will trigger when new context arrives.')
        return
      }
      lastRefreshAtRef.current = Date.now()
    }

    onClearError()
    setRefreshStatus(null)
    setIsRefreshing(true)
    isRefreshingRef.current = true

    try {
      // Only flush during active speech — flushing silence produces a header-only
      // WebM stub that Whisper rejects with a 400.
      const speakingRecently = Date.now() - lastRealCommitAtRef.current < SILENCE_THRESHOLD_MS
      if (isRecordingRef.current && speakingRecently) await flushAndCommitAllPending()

      const pendingText = pendingTranscriptPartsRef.current.join(' ').trim()
      const rawContext = pendingText
        ? `${transcriptTextRef.current}\n${pendingText}`
        : transcriptTextRef.current
      const context =
        buildSessionHeader(sessionStartRef.current) +
        rawContext.slice(-settingsRef.current.suggestionContextChars)

      if (trigger !== 'stop' && context.length < MIN_SUGGESTION_CONTEXT_CHARS) {
        if (trigger === 'manual') setRefreshStatus('Not enough transcript content yet for suggestions.')
        return
      }

      if (trigger === 'manual' && lastSuggestionContextLengthRef.current > 0) {
        const newChars = context.length - lastSuggestionContextLengthRef.current
        if (newChars < MIN_NEW_CHARS_FOR_REFRESH) {
          const timerPaused = suggestionsIntervalRef.current === null
          setRefreshStatus(
            timerPaused
              ? 'No major new discussion points yet. Auto-refresh is paused — waiting for speech.'
              : 'No major new discussion points yet. Auto-refresh will trigger when more context arrives.',
          )
          return
        }
      }

      // Use the ref to get the latest batches — the state value captured at
      // timer-start time would be stale after several batches are generated.
      const previousTitles = suggestionBatchesRef.current
        .slice(0, 3)
        .flatMap((b) => b.suggestions.map((s) => s.title))

      const t0 = Date.now()
      const suggestions = await createLiveSuggestions(
        settingsRef.current.apiKey,
        settingsRef.current.liveSuggestionsPrompt,
        context,
        settingsRef.current.meetingContext,
        previousTitles,
      )

      if (suggestions.length < 2) {
        if (trigger === 'manual') setRefreshStatus('Not enough distinct content for a new suggestion batch yet.')
        return
      }

      lastSuggestionContextLengthRef.current = context.length
      const newBatch: SuggestionBatch = {
        id: makeId(),
        createdAt: nowIso(),
        latencyMs: Date.now() - t0,
        suggestions: suggestions.map((s) => ({ ...s, id: makeId() })),
      }
      setSuggestionBatches((prev) => {
        const updated = [newBatch, ...prev]
        suggestionBatchesRef.current = updated
        return updated
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to refresh suggestions.'
      if (isDailyLimitError(msg)) {
        stopSuggestionTimer()
        setRefreshStatus(
          `Groq daily quota reached — suggestions paused.${extractWaitTime(msg)} The quota resets automatically; try again later.`,
        )
      } else {
        onError(msg)
      }
    } finally {
      setIsRefreshing(false)
      isRefreshingRef.current = false
    }
  }

  // Reset tracking refs when a session starts or ends (does not clear displayed batches).
  const resetSession = () => {
    prevHasFirstRealCommitRef.current = false
    lastSuggestionContextLengthRef.current = 0
    lastRefreshAtRef.current = 0
    setIsSuggestionTimerActive(false)
    setNextRefreshInSec(Math.ceil(settingsRef.current.suggestionIntervalMs / 1000))
    setRefreshStatus(null)
  }

  // Derived UI values exposed so components don't recompute them.
  const reloadDisabled = isRefreshing || !isRecording || !hasFirstRealCommit

  const countdownLabel = (() => {
    if (!isRecording || !hasFirstRealCommit)
      return `auto-refresh in ${Math.ceil(settingsRef.current.suggestionIntervalMs / 1000)}s`
    if (!isSuggestionTimerActive) return 'Paused — waiting for speech'
    return `auto-refresh in ${nextRefreshInSec}s`
  })()

  return {
    suggestionBatches,
    isRefreshing,
    isSuggestionTimerActive,
    nextRefreshInSec,
    refreshStatus,
    reloadDisabled,
    countdownLabel,
    refreshSuggestions,
    stopAllTimers,
    resetSession,
  }
}
