/**
 * AgedDebtorChart — Horizontal bar chart for debtor age bands.
 */

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

export interface AgedDebtorDatum {
  band: string;
  value: number;
  count: number;
  colour: string;
}

export interface AgedDebtorChartProps {
  bands: AgedDebtorDatum[];
  onBandClick?: (band: string) => void;
}

function currencyFmt(v: number) {
  return `£${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

export function AgedDebtorChart({ bands, onBandClick }: AgedDebtorChartProps) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, bands.length * 44)}>
      <BarChart data={bands} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
        <XAxis type="number" tickFormatter={currencyFmt} tick={{ fontSize: 11, fill: 'hsl(212 10% 62%)' }} />
        <YAxis
          dataKey="band"
          type="category"
          width={100}
          tick={{ fontSize: 11, fill: 'hsl(196 72% 18%)' }}
        />
        <Tooltip
          formatter={(value: number) => [currencyFmt(value), 'Outstanding']}
          contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid hsl(223 25% 93%)' }}
        />
        <Bar
          dataKey="value"
          radius={[0, 4, 4, 0]}
          cursor={onBandClick ? 'pointer' : 'default'}
          onClick={(_: unknown, idx: number) => onBandClick?.(bands[idx].band)}
        >
          {bands.map((d, i) => (
            <Cell key={i} fill={d.colour} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
