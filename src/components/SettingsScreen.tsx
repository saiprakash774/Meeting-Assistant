import type { AppSettings } from '../types'
import { DEFAULT_SETTINGS } from '../constants'

type Props = {
  settings: AppSettings
  onSettingsChange: (updater: (prev: AppSettings) => AppSettings) => void
  onClose: () => void
}

export default function SettingsScreen({ settings, onSettingsChange, onClose }: Props) {
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    onSettingsChange((prev) => ({ ...prev, [key]: value }))

  const resetPrompts = () =>
    onSettingsChange((prev) => ({
      ...prev,
      liveSuggestionsPrompt: DEFAULT_SETTINGS.liveSuggestionsPrompt,
      detailAnswerPrompt: DEFAULT_SETTINGS.detailAnswerPrompt,
      chatPrompt: DEFAULT_SETTINGS.chatPrompt,
    }))

  return (
    <section className="settings-screen">
      <div className="settings-header">
        <h2>Settings</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="link-button" onClick={resetPrompts}>
            Reset prompts
          </button>
          <button className="settings-close" onClick={onClose}>
            Back
          </button>
        </div>
      </div>

      <label>
        Groq API Key
        <input
          type="password"
          value={settings.apiKey}
          onChange={(e) => set('apiKey', e.target.value)}
          placeholder="gsk_..."
        />
      </label>

      <label>
        Meeting Context{' '}
        <span className="label-hint">
          (agenda, participants, background — injected into every AI call)
        </span>
        <textarea
          rows={4}
          value={settings.meetingContext}
          onChange={(e) => set('meetingContext', e.target.value)}
          placeholder="e.g. Q3 planning call with engineering leads. Agenda: roadmap priorities, resource allocation, launch dates."
        />
      </label>

      <div className="grid-3" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        <label>
          Suggestion interval (ms) <span className="label-hint">min 10 000</span>
          <input
            type="number"
            min={10_000}
            value={settings.suggestionIntervalMs}
            onChange={(e) =>
              set('suggestionIntervalMs', Math.max(10_000, Number(e.target.value) || 30_000))
            }
          />
        </label>
        <label>
          Suggestion context chars
          <input
            type="number"
            value={settings.suggestionContextChars}
            onChange={(e) => set('suggestionContextChars', Number(e.target.value) || 4_500)}
          />
        </label>
        <label>
          Detail answer context chars
          <input
            type="number"
            value={settings.detailContextChars}
            onChange={(e) => set('detailContextChars', Number(e.target.value) || 8_000)}
          />
        </label>
        <label>
          Chat context chars
          <input
            type="number"
            value={settings.chatContextChars}
            onChange={(e) => set('chatContextChars', Number(e.target.value) || 8_500)}
          />
        </label>
      </div>

      <div className="grid-3">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.noiseGateEnabled}
            onChange={(e) => set('noiseGateEnabled', e.target.checked)}
          />
          Noise gate <span className="label-hint">(skip silent chunks)</span>
        </label>
        <label>
          Min chunk size (KB) <span className="label-hint">when noise gate on</span>
          <input
            type="number"
            min={10}
            max={100}
            value={settings.noiseGateMinKb}
            disabled={!settings.noiseGateEnabled}
            onChange={(e) => set('noiseGateMinKb', Number(e.target.value) || 25)}
          />
        </label>
      </div>

      <label>
        Live suggestions prompt
        <textarea
          rows={8}
          value={settings.liveSuggestionsPrompt}
          onChange={(e) => set('liveSuggestionsPrompt', e.target.value)}
        />
      </label>

      <label>
        Suggestion detail prompt
        <textarea
          rows={7}
          value={settings.detailAnswerPrompt}
          onChange={(e) => set('detailAnswerPrompt', e.target.value)}
        />
      </label>

      <label>
        Chat prompt
        <textarea
          rows={6}
          value={settings.chatPrompt}
          onChange={(e) => set('chatPrompt', e.target.value)}
        />
      </label>
    </section>
  )
}
