import { useMemo } from 'react';
import { shortDate, type Config } from '../apis';

export interface Point { date: string; time: string }

/** Days (extension only when enabled) and the union of slot times per day. */
export function usePointAxis(config: Config | null) {
  return useMemo(() => {
    if (!config) return { days: [] as { date: string; is_extension: boolean; times: string[] }[] };
    const days = config.days
      .filter((d) => !d.is_extension || config.election.extension_enabled)
      .sort((a, b) => a.sort - b.sort)
      .map((d) => ({
        date: d.date, is_extension: d.is_extension,
        times: [...new Set(config.slots.filter((s) => s.day_id === d.id).map((s) => s.time))].sort(),
      }));
    return { days };
  }, [config]);
}

export default function PointPicker({ config, value, onChange }: { config: Config | null; value: Point | null; onChange: (p: Point) => void }) {
  const { days } = usePointAxis(config);
  if (!value || days.length === 0) return null;
  const day = days.find((d) => d.date === value.date) ?? days[0];
  return (
    <div className="stack" style={{ marginTop: 0 }}>
      <div className="chips" role="tablist" aria-label="날짜">
        {days.map((d) => (
          <button key={d.date} role="tab" aria-selected={d.date === value.date} className={`chip ${d.date === value.date ? 'active' : ''} ${d.is_extension ? 'ext' : ''}`}
            onClick={() => onChange({ date: d.date, time: d.times.includes(value.time) ? value.time : d.times[0] })}>
            {shortDate(d.date)}{d.is_extension ? ' 연장' : ''}
          </button>
        ))}
      </div>
      <div className="chips" role="tablist" aria-label="시각">
        {day.times.map((t) => (
          <button key={t} role="tab" aria-selected={t === value.time} className={`chip ${t === value.time ? 'active' : ''}`} onClick={() => onChange({ date: day.date, time: t })}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
