import { useEffect, useRef, useState } from 'react'
import type { TranscriptEntry } from '../types'
import { makeId, nowIso } from '../lib/utils'
import { MIN_REAL_COMMIT_WORDS, TRANSCRIPT_NOISE_PATTERNS } from '../constants'

export function useTranscript() {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [livePreview, setLivePreview] = useState<TranscriptEntry[]>([])
  const [hasFirstRealCommit, setHasFirstRealCommit] = useState(false)

  const transcriptEndRef = useRef<HTMLDivElement | null>(null)
  const transcriptTextRef = useRef('')
  const pendingTranscriptPartsRef = useRef<string[]>([])
  const hasFirstRealCommitRef = useRef(false)
  const lastRealCommitAtRef = useRef(0)

  // Keep transcriptTextRef authoritative from committed state.
  // This useEffect fires after React renders the new transcript entry,
  // but commitPendingTranscript also updates the ref synchronously so
  // suggestion calls immediately after commit see the latest text.
  useEffect(() => {
    transcriptTextRef.current = transcript
      .map((e) => `[${new Date(e.createdAt).toLocaleTimeString()}] ${e.text}`)
      .join('\n')
  }, [transcript])

  // Auto-scroll transcript panel to latest entry.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [transcript, livePreview])

  const addTranscriptEntry = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Filter Whisper hallucinations: anything with < 2 actual letters (catches ".", "..")
    if (trimmed.replace(/[^a-zA-Z]/g, '').length < 2) return
    const normalized = trimmed.toLowerCase().replace(/[^\w\s]/g, '').trim()
    if (trimmed.split(/\s+/).length <= 3 && TRANSCRIPT_NOISE_PATTERNS.has(normalized)) return
    setLivePreview((prev) => [...prev.slice(-7), { id: makeId(), text: trimmed, createdAt: nowIso() }])
    pendingTranscriptPartsRef.current.push(trimmed)
  }

  const commitPendingTranscript = () => {
    const merged = pendingTranscriptPartsRef.current.join(' ').trim()
    pendingTranscriptPartsRef.current = []
    if (!merged) return
    const entry: TranscriptEntry = { id: makeId(), text: merged, createdAt: nowIso() }
    // Sync ref update so refreshSuggestions sees the latest text immediately —
    // the useEffect rebuild fires asynchronously after setState.
    const line = `[${new Date(entry.createdAt).toLocaleTimeString()}] ${entry.text}`
    transcriptTextRef.current = transcriptTextRef.current
      ? `${transcriptTextRef.current}\n${line}`
      : line
    // Only open the suggestion gate when this commit has enough words.
    // A stray word or two-word fragment is shown in the transcript for the
    // user but does not count as real speech for the suggestion system.
    const wordCount = merged.split(/\s+/).filter(Boolean).length
    if (wordCount >= MIN_REAL_COMMIT_WORDS) {
      lastRealCommitAtRef.current = Date.now()
      if (!hasFirstRealCommitRef.current) {
        hasFirstRealCommitRef.current = true
        setHasFirstRealCommit(true)
      }
    }
    setTranscript((prev) => [...prev, entry])
    setLivePreview([])
  }

  // Called when a new recording session starts or the current one ends.
  // Resets speech-quality tracking refs and state without clearing the
  // displayed transcript (which persists for the whole page session).
  const resetSession = () => {
    hasFirstRealCommitRef.current = false
    lastRealCommitAtRef.current = 0
    pendingTranscriptPartsRef.current = []
    setHasFirstRealCommit(false)
    setLivePreview([])
  }

  return {
    transcript,
    livePreview,
    hasFirstRealCommit,
    transcriptEndRef,
    transcriptTextRef,
    pendingTranscriptPartsRef,
    hasFirstRealCommitRef,
    lastRealCommitAtRef,
    addTranscriptEntry,
    commitPendingTranscript,
    resetSession,
  }
}
