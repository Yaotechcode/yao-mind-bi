/**
 * EnhancedSettings — Custom fields, entity types, formula config, WIP age bands, overhead, scorecard weights.
 */

import { useState } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useConfig } from '@/hooks/useConfig';
import { DashboardSection } from '@/components/common/DashboardSection';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { AlertCard } from '@/components/common/AlertCard';

// ---------------------------------------------------------------------------
// Custom Fields
// ---------------------------------------------------------------------------

const ENTITY_TYPES = [
  { key: 'feeEarner', label: 'Fee Earner' },
  { key: 'matter', label: 'Matter' },
  { key: 'timeEntry', label: 'Time Entry' },
  { key: 'invoice', label: 'Invoice' },
  { key: 'client', label: 'Client' },
  { key: 'disbursement', label: 'Disbursement' },
  { key: 'task', label: 'Task' },
];

const DATA_TYPES = ['string', 'number', 'currency', 'percentage', 'date', 'boolean', 'select'];

function CustomFieldsSection() {
  const { config, updateConfig } = useConfig();
  const [selectedEntity, setSelectedEntity] = useState('feeEarner');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newField, setNewField] = useState({ label: '', type: 'string', source: 'csv' });

  const customFields = config?.customFields?.filter((f) => f.entityType === selectedEntity) ?? [];

  const handleAdd = async () => {
    if (!newField.label.trim()) return;
    const key = newField.label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    try {
      await updateConfig('customFields.__add__', {
        entityType: selectedEntity,
        key,
        label: newField.label,
        type: newField.type,
        source: newField.source,
      });
      setNewField({ label: '', type: 'string', source: 'csv' });
      setShowAddForm(false);
      toast.success('Custom field added');
    } catch {
      toast.error('Failed to add custom field');
    }
  };

  return (
    <DashboardSection title="Custom Fields">
      <div className="flex items-center gap-2 mb-4">
        {ENTITY_TYPES.map((et) => (
          <button
            key={et.key}
            className={cn(
              'px-3 py-1.5 text-[11px] font-semibold rounded-sm transition-all',
              selectedEntity === et.key
                ? 'bg-card text-foreground shadow-sm border border-border'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setSelectedEntity(et.key)}
          >
            {et.label}
          </button>
        ))}
      </div>

      {customFields.length > 0 ? (
        <div className="space-y-1.5">
          {customFields.map((field) => (
            <div key={field.id} className="flex items-center justify-between bg-card border border-border rounded-lg px-3 py-2">
              <div>
                <span className="text-[13px] font-medium text-foreground">{field.label}</span>
                <span className="text-xs text-muted-foreground ml-2">({field.type})</span>
              </div>
              <Button variant="ghost" size="icon-sm">
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No custom fields for this entity type.</p>
      )}

      {showAddForm ? (
        <div className="mt-3 bg-standard-background border border-border rounded-lg p-3 space-y-2">
          <input
            type="text"
            placeholder="Field label"
            className="h-8 w-full rounded-input border border-input bg-background px-2.5 text-xs text-foreground"
            value={newField.label}
            onChange={(e) => setNewField({ ...newField, label: e.target.value })}
          />
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground flex-1"
              value={newField.type}
              onChange={(e) => setNewField({ ...newField, type: e.target.value })}
            >
              {DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground flex-1"
              value={newField.source}
              onChange={(e) => setNewField({ ...newField, source: e.target.value })}
            >
              <option value="csv">CSV mapping</option>
              <option value="manual">Manual</option>
              <option value="derived">Derived</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleAdd}>Add Field</Button>
            <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="mt-3" onClick={() => setShowAddForm(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Custom Field
        </Button>
      )}
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// WIP Age Bands
// ---------------------------------------------------------------------------

interface AgeBand {
  label: string;
  minDays: number;
  maxDays: number | null;
  recoveryProbability: number;
}

const DEFAULT_BANDS: AgeBand[] = [
  { label: '0–30 days', minDays: 0, maxDays: 30, recoveryProbability: 95 },
  { label: '31–60 days', minDays: 31, maxDays: 60, recoveryProbability: 85 },
  { label: '61–90 days', minDays: 61, maxDays: 90, recoveryProbability: 70 },
  { label: '91–180 days', minDays: 91, maxDays: 180, recoveryProbability: 50 },
  { label: '180+ days', minDays: 181, maxDays: null, recoveryProbability: 25 },
];

function WipAgeBandsSection() {
  const { updateConfig } = useConfig();
  const [bands, setBands] = useState<AgeBand[]>(DEFAULT_BANDS);

  const updateBand = (idx: number, field: keyof AgeBand, value: unknown) => {
    setBands((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const addBand = () => {
    const last = bands[bands.length - 1];
    const startDay = last ? (last.maxDays ?? last.minDays) + 1 : 0;
    setBands([...bands, { label: `${startDay}+ days`, minDays: startDay, maxDays: null, recoveryProbability: 10 }]);
  };

  const removeBand = (idx: number) => {
    setBands((prev) => prev.filter((_, i) => i !== idx));
  };

  const saveBands = async () => {
    try {
      await updateConfig('wipAgeBands', bands);
      toast.success('WIP age bands saved');
    } catch {
      toast.error('Failed to save age bands');
    }
  };

  return (
    <DashboardSection title="WIP Age Bands">
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-standard-background">
              <th className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground uppercase">Band Label</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold text-muted-foreground uppercase">Min Days</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold text-muted-foreground uppercase">Max Days</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold text-muted-foreground uppercase">Recovery %</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {bands.map((band, idx) => (
              <tr key={idx} className="border-b border-standard-background">
                <td className="px-3 py-1.5">
                  <input
                    type="text"
                    className="h-7 w-full rounded-input border border-input bg-background px-2 text-xs text-foreground"
                    value={band.label}
                    onChange={(e) => updateBand(idx, 'label', e.target.value)}
                  />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input
                    type="number"
                    className="h-7 w-16 rounded-input border border-input bg-background px-1.5 text-xs text-right text-foreground"
                    value={band.minDays}
                    onChange={(e) => updateBand(idx, 'minDays', Number(e.target.value))}
                  />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input
                    type="number"
                    className="h-7 w-16 rounded-input border border-input bg-background px-1.5 text-xs text-right text-foreground"
                    value={band.maxDays ?? ''}
                    placeholder="∞"
                    onChange={(e) => updateBand(idx, 'maxDays', e.target.value ? Number(e.target.value) : null)}
                  />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input
                    type="number"
                    className="h-7 w-16 rounded-input border border-input bg-background px-1.5 text-xs text-right text-foreground"
                    value={band.recoveryProbability}
                    min={0}
                    max={100}
                    onChange={(e) => updateBand(idx, 'recoveryProbability', Number(e.target.value))}
                  />
                </td>
                <td className="px-3 py-1.5">
                  <Button variant="ghost" size="icon-sm" onClick={() => removeBand(idx)}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <Button variant="outline" size="sm" onClick={addBand}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Band
        </Button>
        <Button size="sm" onClick={saveBands}>Save Bands</Button>
      </div>
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// Overhead Model
// ---------------------------------------------------------------------------

function OverheadModelSection() {
  const { updateConfig } = useConfig();
  const [model, setModel] = useState<'none' | 'per_head' | 'by_revenue' | 'by_hours' | 'custom'>('none');

  return (
    <DashboardSection title="Overhead Model">
      <div className="space-y-3">
        <select
          className="h-8 rounded-input border border-input bg-background px-2.5 text-xs text-foreground focus:ring-2 focus:ring-ring"
          value={model}
          onChange={(e) => {
            const v = e.target.value as typeof model;
            setModel(v);
            updateConfig('overheadModel.type', v);
          }}
        >
          <option value="none">None</option>
          <option value="per_head">Per head</option>
          <option value="by_revenue">By revenue</option>
          <option value="by_hours">By hours</option>
          <option value="custom">Custom</option>
        </select>

        {model !== 'none' && (
          <div className="bg-standard-background rounded-lg p-3 border border-border">
            <p className="text-xs text-muted-foreground">
              {model === 'per_head' && 'Enter the total annual overhead cost. It will be divided equally among all fee earners.'}
              {model === 'by_revenue' && 'Enter the overhead percentage applied to each fee earner\'s revenue.'}
              {model === 'by_hours' && 'Enter the hourly overhead rate.'}
              {model === 'custom' && 'Enter a custom overhead formula or fixed amount per grade.'}
            </p>
            <input
              type="number"
              className="h-8 w-32 mt-2 rounded-input border border-input bg-background px-2.5 text-xs text-foreground"
              placeholder={model === 'by_revenue' ? 'e.g. 15%' : 'e.g. £50,000'}
              onChange={(e) => updateConfig('overheadModel.value', Number(e.target.value))}
            />
          </div>
        )}
      </div>
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// Scorecard Weights
// ---------------------------------------------------------------------------

const SCORECARD_COMPONENTS = [
  { key: 'utilisation', label: 'Utilisation' },
  { key: 'realisation', label: 'Realisation' },
  { key: 'recording', label: 'Recording' },
  { key: 'writeOff', label: 'Write-Off' },
  { key: 'revenue', label: 'Revenue' },
];

function ScorecardWeightsSection() {
  const { updateConfig } = useConfig();
  const [weights, setWeights] = useState<Record<string, number>>({
    utilisation: 25,
    realisation: 25,
    recording: 20,
    writeOff: 15,
    revenue: 15,
  });

  const total = Object.values(weights).reduce((a, b) => a + b, 0);

  const updateWeight = (key: string, val: number) => {
    setWeights((prev) => ({ ...prev, [key]: val }));
  };

  const saveWeights = async () => {
    if (total !== 100) {
      toast.error('Weights must sum to 100');
      return;
    }
    try {
      await updateConfig('scorecardWeights', weights);
      toast.success('Scorecard weights saved');
    } catch {
      toast.error('Failed to save weights');
    }
  };

  return (
    <DashboardSection title="Scorecard Weights">
      <p className="text-xs text-muted-foreground mb-3">Adjust the relative weight of each component in the fee earner scorecard. Must sum to 100.</p>
      <div className="space-y-3">
        {SCORECARD_COMPONENTS.map((comp) => (
          <div key={comp.key} className="flex items-center gap-3">
            <span className="text-[13px] text-foreground font-medium w-24">{comp.label}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={weights[comp.key]}
              onChange={(e) => updateWeight(comp.key, Number(e.target.value))}
              className="flex-1 accent-[hsl(var(--primary))]"
            />
            <span className="text-xs text-foreground font-semibold w-10 text-right">{weights[comp.key]}%</span>
          </div>
        ))}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <span className={cn('text-xs font-semibold', total === 100 ? 'text-success' : 'text-error')}>
            Total: {total}%
          </span>
          <Button size="sm" onClick={saveWeights} disabled={total !== 100}>Save Weights</Button>
        </div>
      </div>
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function EnhancedSettings() {
  return (
    <div className="space-y-6 max-w-3xl">
      <CustomFieldsSection />

      {/* Custom Entity Types */}
      <DashboardSection title="Custom Entity Types">
        <EmptyState
          title="Coming in the next update"
          message="Custom entity types will let you define new data models beyond the built-in types."
        />
      </DashboardSection>

      {/* Formula Configuration */}
      <DashboardSection title="Formula Configuration">
        <p className="text-xs text-muted-foreground">Per-formula variant selection and modifier configuration is available in the Formula Library tab.</p>
      </DashboardSection>

      <WipAgeBandsSection />
      <OverheadModelSection />
      <ScorecardWeightsSection />
    </div>
  );
}
