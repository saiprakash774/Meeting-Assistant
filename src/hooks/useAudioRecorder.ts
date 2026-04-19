import { useRef, useState } from 'react'
import type { AppSettings } from '../types'
import { transcribeAudioChunk } from '../lib/groq'
import { pickSupportedMimeType } from '../lib/utils'
import { TRANSCRIPT_PREVIEW_INTERVAL_MS, TRANSCRIPT_COMMIT_INTERVAL_MS } from '../constants'

type Params = {
  settingsRef: React.MutableRefObject<AppSettings>
  onTranscription: (text: string) => void
  commitPendingTranscript: () => void
  onError: (msg: string) => void
}

export function useAudioRecorder({ settingsRef, onTranscription, commitPendingTranscript, onError }: Params) {
  const [isRecording, setIsRecording] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const shouldRestartRef = useRef(false)
  const isRecordingRef = useRef(false)
  const sessionStartRef = useRef<Date | null>(null)
  const inFlightTranscriptionsRef = useRef<Promise<void>[]>([])
  const transcriptCommitIntervalRef = useRef<number | null>(null)

  const setIsRecordingSync = (val: boolean) => {
    isRecordingRef.current = val
    setIsRecording(val)
  }

  const stopTranscriptCommitTimer = () => {
    if (transcriptCommitIntervalRef.current) {
      window.clearInterval(transcriptCommitIntervalRef.current)
      transcriptCommitIntervalRef.current = null
    }
  }

  const startTranscriptCommitTimer = () => {
    stopTranscriptCommitTimer()
    transcriptCommitIntervalRef.current = window.setInterval(() => {
      // Wait for any in-flight transcriptions before committing so we don't
      // lose words that are still being returned from the Whisper API.
      void Promise.all(inFlightTranscriptionsRef.current).then(commitPendingTranscript)
    }, TRANSCRIPT_COMMIT_INTERVAL_MS)
  }

  const handleAudioBlob = (blob: Blob) => {
    const s = settingsRef.current
    if (!s.apiKey || blob.size < 10_000) return
    if (s.noiseGateEnabled && blob.size < s.noiseGateMinKb * 1024) return

    const job = (async () => {
      const text = await transcribeAudioChunk(s.apiKey, blob)
      if (text) onTranscription(text)
    })().catch((err: unknown) => {
      onError(err instanceof Error ? err.message : 'Transcription failed.')
    })

    inFlightTranscriptionsRef.current.push(job)
    job.finally(() => {
      inFlightTranscriptionsRef.current = inFlightTranscriptionsRef.current.filter((p) => p !== job)
    })
  }

  const flushCurrentChunk = (): Promise<void> => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'recording') return Promise.resolve()
    return new Promise<void>((resolve) => {
      recorder.addEventListener('dataavailable', () => resolve(), { once: true })
      recorder.stop()
    })
  }

  const flushAndCommitAllPending = async () => {
    await flushCurrentChunk()
    await Promise.all(inFlightTranscriptionsRef.current)
    commitPendingTranscript()
  }

  const launchRecordingCycle = (stream: MediaStream, mimeType: string) => {
    if (!shouldRestartRef.current) return
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream)
    mediaRecorderRef.current = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) handleAudioBlob(event.data)
    }
    recorder.onstop = () => {
      if (shouldRestartRef.current)
        window.setTimeout(() => launchRecordingCycle(stream, mimeType), 100)
    }
    recorder.start()
    window.setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop()
    }, TRANSCRIPT_PREVIEW_INTERVAL_MS)
  }

  const start = async (): Promise<boolean> => {
    if (!settingsRef.current.apiKey) {
      onError('Add your Groq API key in Settings first.')
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      shouldRestartRef.current = true
      sessionStartRef.current = new Date()
      inFlightTranscriptionsRef.current = []
      launchRecordingCycle(stream, pickSupportedMimeType())
      startTranscriptCommitTimer()
      setIsRecordingSync(true)
      return true
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Could not start microphone.')
      return false
    }
  }

  const stop = async (): Promise<void> => {
    shouldRestartRef.current = false
    stopTranscriptCommitTimer()
    await flushAndCommitAllPending()
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setIsRecordingSync(false)
  }

  return {
    isRecording,
    isRecordingRef,
    sessionStartRef,
    start,
    stop,
    flushAndCommitAllPending,
  }
}
