import { Field } from '@/components/form/field';

export interface AssetValues {
  serialNumber: string;
  vendor: string;
  model: string;
  purchasedAt: string;
  warrantyEndsAt: string;
  eolAt: string;
  runPastEol: boolean;
}

interface AssetFieldsetProps {
  values: AssetValues;
  onChange: (patch: Partial<AssetValues>) => void;
}

/**
 * Shared "Asset" fieldset used by both CreateHostDialog and EditHostDialog so
 * the optional asset-tracking fields (serial, vendor, model, purchase/warranty
 * /EOL dates, runPastEol opt-out) stay in sync between the two forms.
 */
export function AssetFieldset({ values, onChange }: AssetFieldsetProps): React.JSX.Element {
  return (
    <fieldset className="mt-2 border-t border-border pt-4">
      <legend className="text-sm font-medium">Asset</legend>
      <p className="mt-1 text-xs text-fg-muted">
        Optional hardware metadata used for warranty and EOL reporting.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Serial number"
          value={values.serialNumber}
          onChange={(e) => onChange({ serialNumber: e.target.value })}
          placeholder="Optional"
          maxLength={120}
        />
        <Field
          label="Vendor"
          value={values.vendor}
          onChange={(e) => onChange({ vendor: e.target.value })}
          placeholder="e.g. HPE"
          maxLength={120}
        />
        <Field
          label="Model"
          value={values.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="e.g. ProLiant DL380"
          maxLength={120}
        />
        <Field
          label="Purchased at"
          type="date"
          value={values.purchasedAt}
          onChange={(e) => onChange({ purchasedAt: e.target.value })}
        />
        <Field
          label="Warranty ends"
          type="date"
          value={values.warrantyEndsAt}
          onChange={(e) => onChange({ warrantyEndsAt: e.target.value })}
        />
        <Field
          label="End of life"
          type="date"
          value={values.eolAt}
          onChange={(e) => onChange({ eolAt: e.target.value })}
        />
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-input"
          checked={values.runPastEol}
          onChange={(e) => onChange({ runPastEol: e.target.checked })}
        />
        <span>Plan to run past EOL (don&rsquo;t drop from forecast)</span>
      </label>
    </fieldset>
  );
}
