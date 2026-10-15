"use client";

import { useEffect, useRef, useState } from "react";

export function NumberStepper({
  value,
  onChange,
  step,
  nativeStep = "any",
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  unit,
  readOnly = false,
  label,
  allowEmpty = false,
}: {
  value: number;
  onChange: (value: number) => void;
  step: number;
  nativeStep?: number | "any";
  min?: number;
  max?: number;
  unit?: string;
  readOnly?: boolean;
  label: string;
  allowEmpty?: boolean;
}) {
  const valueText = Number.isFinite(value) ? String(value) : "";
  const [draft, setDraft] = useState(valueText);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(valueText);
  }, [valueText]);

  const commitDraft = () => {
    editing.current = false;
    const normalized = draft.trim();
    if (!normalized) {
      if (allowEmpty) {
        onChange(Number.NaN);
        setDraft("");
      } else {
        setDraft(valueText);
      }
      return;
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      setDraft(valueText);
      return;
    }
    onChange(parsed);
    setDraft(String(parsed));
  };

  const adjust = (direction: -1 | 1) => {
    const base = Number.isFinite(value) ? value : Math.max(0, min);
    const next = Math.min(max, Math.max(min, base + direction * step));
    const adjusted = Number(next.toFixed(12));
    onChange(adjusted);
    setDraft(String(adjusted));
  };

  return (
    <div className="number-stepper">
      <button
        type="button"
        aria-label={`${label}减少`}
        disabled={readOnly || value <= min}
        onClick={() => adjust(-1)}
      >
        −
      </button>
      <input
        aria-label={label}
        type="number"
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={nativeStep}
        value={draft}
        readOnly={readOnly}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          if (!nextDraft.trim()) {
            if (allowEmpty) onChange(Number.NaN);
            return;
          }
          const parsed = Number(nextDraft);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={commitDraft}
      />
      {unit ? <em>{unit}</em> : null}
      <button
        type="button"
        aria-label={`${label}增加`}
        disabled={readOnly || value >= max}
        onClick={() => adjust(1)}
      >
        +
      </button>
    </div>
  );
}
