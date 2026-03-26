/**
 * WipAgeBandChart — Horizontal bar chart for WIP age bands.
 */

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

export interface WipAgeBandDatum {
  band: string;
  value: number;
  count: number;
  colour: string;
}

export interface WipAgeBandChartProps {
  data: WipAgeBandDatum[];
  onBandClick?: (band: string) => void;
}

function currencyFmt(v: number) {
  return `£${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

export function WipAgeBandChart({ data, onBandClick }: WipAgeBandChartProps) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
        <XAxis type="number" tickFormatter={currencyFmt} tick={{ fontSize: 11, fill: 'hsl(212 10% 62%)' }} />
        <YAxis
          dataKey="band"
          type="category"
          width={100}
          tick={{ fontSize: 11, fill: 'hsl(196 72% 18%)' }}
        />
        <Tooltip
          formatter={(value: unknown) => [currencyFmt(Number(value)), 'Value']}
          labelFormatter={(label: unknown) => String(label)}
          contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid hsl(223 25% 93%)' }}
          itemStyle={{ color: 'hsl(196 72% 18%)' }}
        />
        <Bar
          dataKey="value"
          radius={[0, 4, 4, 0]}
          cursor={onBandClick ? 'pointer' : 'default'}
          onClick={(_: unknown, idx: number) => onBandClick?.(data[idx].band)}
        >
          {data.map((d, i) => (
            <Cell key={i} fill={d.colour} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
