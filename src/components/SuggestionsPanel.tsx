import type { Suggestion, SuggestionBatch } from '../types'

type Props = {
  suggestionBatches: SuggestionBatch[]
  isRefreshing: boolean
  reloadDisabled: boolean
  countdownLabel: string
  intentLabelMap: Record<string, string>
  onReload: () => void
  onSuggestionClick: (suggestion: Suggestion) => void
}

export default function SuggestionsPanel({
  suggestionBatches,
  isRefreshing,
  reloadDisabled,
  countdownLabel,
  intentLabelMap,
  onReload,
  onSuggestionClick,
}: Props) {
  return (
    <div className="column">
      <div className="panel-title-row">
        <h2>2. LIVE SUGGESTIONS</h2>
        <span className="status-chip">{suggestionBatches.length} batches</span>
      </div>
      <div className="panel col-panel">
        <div className="col-subhead split">
          <button className="link-button" onClick={onReload} disabled={reloadDisabled}>
            {isRefreshing ? '↻ Reloading…' : '↻ Reload suggestions'}
          </button>
          <span>{countdownLabel}</span>
        </div>
        <div className="col-scroll">
          {suggestionBatches.length === 0 ? (
            <p className="muted">Suggestion batches appear on each refresh.</p>
          ) : null}
          {suggestionBatches.map((batch, index) => (
            <div key={batch.id} className="suggestion-batch">
              <h3>
                Batch {suggestionBatches.length - index} · {new Date(batch.createdAt).toLocaleTimeString()}
                <span className="latency">{(batch.latencyMs / 1000).toFixed(1)}s</span>
              </h3>
              {batch.suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  className="suggestion-card"
                  onClick={() => onSuggestionClick(suggestion)}
                >
                  <span className={`intent-pill ${suggestion.intent}`}>
                    {(intentLabelMap[suggestion.intent] || 'Suggestion').toUpperCase()}
                  </span>
                  <p>{suggestion.preview}</p>
                  <small>{suggestion.title}</small>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
