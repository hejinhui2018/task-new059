import type { Tone } from '../ui/describe';

export interface LogEntry {
  id: number;
  time: string;
  tone: Tone;
  text: string;
}

const TONE_ICON: Record<Tone, string> = {
  ok: '✓',
  warn: '⚠',
  bad: '✕',
  info: 'ℹ',
};

export default function EventLog({ entries }: { entries: LogEntry[] }) {
  return (
    <section className="panel log-panel" aria-label="调度日志">
      <h2>调度日志</h2>
      <ul className="log-list">
        {entries.map((e) => (
          <li key={e.id} className={`log-${e.tone}`}>
            <time>{e.time}</time>
            <span className="log-icon">{TONE_ICON[e.tone]}</span>
            <span>{e.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
