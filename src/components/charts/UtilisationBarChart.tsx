/**
 * UtilisationBarChart — Vertical bar chart per fee earner with target line.
 */

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';

const RAG_COLORS: Record<string, string> = {
  green: 'hsl(180 88% 38%)',
  amber: 'hsl(24 72% 64%)',
  red: 'hsl(349 72% 63%)',
  neutral: 'hsl(212 13% 69%)',
};

export interface UtilisationBarDatum {
  name: string;
  value: number | null;
  target: number;
  ragStatus: string;
}

export interface UtilisationBarChartProps {
  data: UtilisationBarDatum[];
}

function shortenName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

export function UtilisationBarChart({ data }: UtilisationBarChartProps) {
  const chartData = data.map((d) => ({ ...d, value: d.value ?? 0, shortName: shortenName(d.name) }));
  const target = data[0]?.target ?? 80;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
        <XAxis
          dataKey="shortName"
          tick={{ fontSize: 10, fill: 'hsl(196 72% 18%)' }}
          interval={0}
          angle={-30}
          textAnchor="end"
          height={50}
        />
        <YAxis
          domain={[0, 100]}
          tickFormatter={(v: number) => `${v}%`}
          tick={{ fontSize: 11, fill: 'hsl(212 10% 62%)' }}
        />
        <Tooltip
          formatter={(value: number) => [`${value.toFixed(1)}%`, 'Utilisation']}
          labelFormatter={(_: string, payload: Array<{ payload?: { name?: string } }>) =>
            payload?.[0]?.payload?.name ?? _
          }
          contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid hsl(223 25% 93%)' }}
        />
        <ReferenceLine
          y={target}
          stroke="hsl(193 98% 35%)"
          strokeDasharray="4 4"
          label={{ value: `Target ${target}%`, position: 'right', fontSize: 10, fill: 'hsl(193 98% 35%)' }}
        />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={32}>
          {chartData.map((d, i) => (
            <Cell key={i} fill={RAG_COLORS[d.ragStatus] ?? RAG_COLORS.neutral} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
