/**
 * StackedBarChart — Generic stacked bar (horizontal or vertical).
 */

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

export interface StackedSegment {
  key: string;
  value: number;
  colour: string;
}

export interface StackedBarDatum {
  name: string;
  segments: StackedSegment[];
}

export interface StackedBarChartProps {
  data: StackedBarDatum[];
  horizontal?: boolean;
  labels?: Record<string, string>;
}

export function StackedBarChart({ data, horizontal = false, labels = {} }: StackedBarChartProps) {
  // Flatten segments into per-row keyed values
  const allKeys = Array.from(
    new Set(data.flatMap((d) => d.segments.map((s) => s.key))),
  );
  const colourMap: Record<string, string> = {};
  data.forEach((d) => d.segments.forEach((s) => { colourMap[s.key] = s.colour; }));

  const chartData = data.map((d) => {
    const row: Record<string, unknown> = { name: d.name };
    d.segments.forEach((s) => { row[s.key] = s.value; });
    return row;
  });

  const layout = horizontal ? 'vertical' : 'horizontal';

  return (
    <ResponsiveContainer width="100%" height={horizontal ? Math.max(200, data.length * 40) : 300}>
      <BarChart data={chartData} layout={layout as 'vertical' | 'horizontal'} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
        {horizontal ? (
          <>
            <XAxis type="number" tick={{ fontSize: 11, fill: 'hsl(212 10% 62%)' }} />
            <YAxis dataKey="name" type="category" width={100} tick={{ fontSize: 11, fill: 'hsl(196 72% 18%)' }} />
          </>
        ) : (
          <>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(196 72% 18%)' }} />
            <YAxis tick={{ fontSize: 11, fill: 'hsl(212 10% 62%)' }} />
          </>
        )}
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid hsl(223 25% 93%)' }} />
        <Legend
          wrapperStyle={{ fontSize: 11 }}
          formatter={(value: string) => labels[value] ?? value}
        />
        {allKeys.map((key) => (
          <Bar
            key={key}
            dataKey={key}
            stackId="stack"
            fill={colourMap[key]}
            name={labels[key] ?? key}
            radius={[2, 2, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
