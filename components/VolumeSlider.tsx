'use client';

export function VolumeSlider({
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const id = `volume-${label}`;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <span className="text-xs tabular-nums text-paper-dim">{Math.round(value * 100)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full disabled:opacity-40"
      />
      {hint ? <p className="text-[0.7rem] text-paper-dim/80">{hint}</p> : null}
    </div>
  );
}
