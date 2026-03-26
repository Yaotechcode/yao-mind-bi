/**
 * TrendLineChart — Multi-series line/bar chart with optional target reference line.
 */

import {
  ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';

export interface TrendLineDatum {
  period: string;
  values: Record<string, number>;
}

export interface TrendLineSeries {
  key: string;
  colour: string;
  type: 'line' | 'bar';
}

export interface TrendLineChartProps {
  data: TrendLineDatum[];
  lines: TrendLineSeries[];
  targetLine?: { value: number; label: string };
}

export function TrendLineChart({ data, lines, targetLine }: TrendLineChartProps) {
  const chartData = data.map((d) => ({ period: d.period, ...d.values }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
        <XAxis dataKey="period" tick={{ fontSize: 11, fill: 'hsl(196 72% 18%)' }} />
        <YAxis tick={{ fontSize: 11, fill: 'hsl(212 10% 62%)' }} />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid hsl(223 25% 93%)' }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {targetLine && (
          <ReferenceLine
            y={targetLine.value}
            stroke="hsl(193 98% 35%)"
            strokeDasharray="4 4"
            label={{ value: targetLine.label, position: 'right', fontSize: 10, fill: 'hsl(193 98% 35%)' }}
          />
        )}
        {lines.map((s) =>
          s.type === 'bar' ? (
            <Bar key={s.key} dataKey={s.key} fill={s.colour} radius={[3, 3, 0, 0]} maxBarSize={28} />
          ) : (
            <Line
              key={s.key}
              dataKey={s.key}
              stroke={s.colour}
              strokeWidth={2}
              dot={{ r: 3, fill: s.colour }}
              activeDot={{ r: 5 }}
            />
          ),
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
