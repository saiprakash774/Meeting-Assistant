import type { TranscriptEntry } from '../types'

type Props = {
  transcript: TranscriptEntry[]
  livePreview: TranscriptEntry[]
  isRecording: boolean
  transcriptEndRef: React.RefObject<HTMLDivElement | null>
  onToggleRecording: () => void
}

export default function TranscriptPanel({
  transcript,
  livePreview,
  isRecording,
  transcriptEndRef,
  onToggleRecording,
}: Props) {
  return (
    <div className="column">
      <div className="panel-title-row">
        <h2>1. MIC &amp; TRANSCRIPT</h2>
        <span className={`status-chip ${isRecording ? 'live' : ''}`}>
          {isRecording ? 'recording' : 'idle'}
        </span>
      </div>
      <div className="panel col-panel">
        <div className="col-subhead split">
          <span>{isRecording ? 'Listening… transcript updates every 30s.' : 'Mic is off.'}</span>
          <button
            className={`link-button${isRecording ? '' : ' resume-btn'}`}
            onClick={onToggleRecording}
          >
            {isRecording ? '⏹ Stop Mic' : '▶ Start Mic'}
          </button>
        </div>
        <div className="col-scroll">
          {transcript.length === 0 ? (
            <p className="muted">Confirmed transcript appears every ~30 seconds.</p>
          ) : null}
          {transcript.map((line) => (
            <div key={line.id} className="transcript-line">
              <span>{new Date(line.createdAt).toLocaleTimeString()}</span>
              <p>{line.text}</p>
            </div>
          ))}
          {livePreview.length > 0 ? (
            <p className="muted preview-label">Live preview (~5s, unconfirmed)</p>
          ) : null}
          {livePreview.map((line) => (
            <div key={line.id} className="transcript-line preview">
              <span>{new Date(line.createdAt).toLocaleTimeString()}</span>
              <p>{line.text}</p>
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>
      </div>
    </div>
  )
}
